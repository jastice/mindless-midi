/**
 * Main-thread side of playback: owns the AudioContext and the sound engines,
 * asks the conductor for bars a few seconds ahead and ships them out.
 * Scheduling is driven by "tick" messages from the audio thread rather than
 * timers, so it keeps going in background tabs.
 *
 * Engines: "fm" is the original path (events to the OPL3 worklet). The others
 * send bars to a render worker that streams per-role stems to a stem worklet,
 * whose outputs run through the live mix bus.
 */
import { barEvents, barFrames } from "../audio/events.js";
import { TARGET_RMS } from "../audio/leveler.js";
import { type FromWorklet, PROCESSOR_NAME, type ToWorklet } from "../audio/protocol.js";
import { ROLES, type Role } from "../corpus/constants.js";
import type { StyleBundle } from "../corpus/schema.js";
import { Conductor } from "../engine/conductor.js";
import { barsToMidi } from "../engine/midi_file.js";
import type { Bar } from "../engine/types.js";
import { Bus } from "../sound/bus.js";
import { type Engine, type FromStems, STEM_PROCESSOR, type ToWorker } from "../sound/protocol.js";
import { type PlannedNote, SampleCache, SampleLibrary } from "../sound/sampler.js";
import type { ScoreNote } from "../sound/types.js";

export type { Engine };

export interface TimedBar {
  bar: Bar;
  /** AudioContext time (seconds) at which the bar starts / ends. */
  start: number;
  end: number;
}

interface Scheduled extends TimedBar {
  frame: number;
  frames: number;
  /** Notes with onsets relative to the bar start, seconds. */
  notes: ScoreNote[];
  /** Skip epoch it was generated in (a skip discards bars not yet sent). */
  skips: number;
  /** Samples engine: resolved zones (downloads done), computed once per bar. */
  plans?: PlannedNote[];
  planning?: Promise<PlannedNote[]>;
}

/** A switch to Samples waits until this much music from the switch point has its samples. */
const SWITCH_READY_SECONDS = 6;
/** Give up waiting for a section start after this long and switch at any ready bar. */
const SWITCH_MAX_WAIT = 30;

export interface PlayerOptions {
  seed: string;
  processorUrl: string;
  wasmUrl: string;
  stemWorkletUrl: string;
  workerUrl: string;
  engine?: Engine;
}

type Listener = () => void;

const HISTORY_SECONDS = 20 * 60;
const OPL_CHIPS = 4;
/** Seconds of music rendered ahead. Samples get more slack for downloads. */
const LOOKAHEAD: Record<Engine, number> = { fm: 3, fm_bus: 4, synth: 4, samples: 6 };

type Upcoming = { e: Scheduled; start: number; end: number };

/** A section start, or failing that the start of a 4-bar phrase. */
const isPhrase = (u: Upcoming) => !u.e.bar.info.gap && u.e.bar.info.barInSection % 4 === 0;
const isSection = (u: Upcoming) => !u.e.bar.info.gap && u.e.bar.info.barInSection === 0;
/** Prefer a section start this soon after the first suitable phrase start, seconds. */
const SECTION_GRACE = 8;

/**
 * Index of the bar to switch at: the earliest phrase start satisfying `ok`,
 * or a section start that follows within SECTION_GRACE. -1 if none.
 */
function pickBoundary(ups: Upcoming[], ok: (u: Upcoming, i: number) => boolean): number {
  const phrase = ups.findIndex((u, i) => isPhrase(u) && ok(u, i));
  if (phrase < 0) return -1;
  const limit = ups[phrase]!.start + SECTION_GRACE;
  const section = ups.findIndex((u, i) => i >= phrase && u.start <= limit && isSection(u) && ok(u, i));
  return section >= 0 ? section : phrase;
}

/** A prior for the download rate from the browser's own estimate (Chromium), bytes/s. */
function initialRate(): number | null {
  const c = (navigator as Navigator & { connection?: { downlink?: number } }).connection;
  return c?.downlink ? (c.downlink * 1e6) / 8 / 2 : null;
}

export class Player {
  private ctx: AudioContext | null = null;
  private output: GainNode | null = null;
  private fmNode: AudioWorkletNode | null = null;
  private stemNode: AudioWorkletNode | null = null;
  private worker: Worker | null = null;
  private bus: Bus | null = null;
  private library: SampleLibrary | null = null;
  private wasm: Promise<ArrayBuffer> | null = null;
  private workerHasWasm = false;
  private readonly conductor: Conductor;
  private readonly opts: PlayerOptions;
  private readonly styleById: Map<string, StyleBundle>;
  private engineName: Engine;
  private nextFrame = 0;
  private timeline: Scheduled[] = [];
  private volume = 0.8;
  private starting: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();
  private lastPieceIndex = -1;
  /** Bumped by skips and engine switches; in-flight scheduling for an older token is dropped. */
  private token = 0;
  private pumping = false;
  private again = false;
  /** Bars generated (for prefetching, or interrupted mid-dispatch) but not yet sent to an engine. */
  private ahead: Scheduled[] = [];
  private skips = 0;
  /** A switch waiting for its samples to arrive; it happens at a later bar. */
  private pending: {
    engine: Engine;
    since: number;
    /** The bar the switch is committed to. */
    at?: Scheduled;
    /** The section start currently being downloaded for, and how far ahead to aim. */
    target?: Scheduled;
    lead: number;
    /** New sample bytes and music seconds planned while waiting: the music's demand. */
    bytes: number;
    seconds: number;
  } | null = null;
  private prefetching = false;
  /** Booting in Samples mode: waiting for the first seconds to download. */
  private warming = false;
  /** Highest load progress shown so far, so the bar never runs backwards when the target moves. */
  private shownProgress = 0;
  /** A switch that has been scheduled but isn't audible yet (the old engine plays until `at`). */
  private arriving: { from: Engine; to: Engine; at: number } | null = null;
  /** Measured sample download throughput, bytes/s (null until known). */
  private rate: number | null = initialRate();
  /** New sample bytes the music asks for per second of playback (moving average). */
  private needRate = 0;
  private loadingCount = 0;
  /** Set once a preparation has been waiting long enough to be worth showing. */
  private slowLoad = false;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Programs per channel as of the last generated bar. */
  private readonly programs = new Map<number, number>();
  /** The next bar sent to an engine must carry its piece's setup (bank, programs, levels). */
  private needsSetup = false;
  private busStyle: string | null = null;
  /** Bus loudness AGC (the stem engines' counterpart of the FM path's Leveler). */
  private agcEnv = TARGET_RMS * TARGET_RMS;
  private agcGain = 1;
  private readonly meterBuf = new Float32Array(2048);

  constructor(styles: StyleBundle[], opts: PlayerOptions) {
    this.opts = opts;
    this.engineName = opts.engine ?? "fm";
    this.styleById = new Map(styles.map((s) => [s.id, s]));
    this.conductor = new Conductor(styles, opts.seed);
  }

  get seed(): string {
    return this.conductor.seed;
  }

  get engine(): Engine {
    return this.engineName;
  }

  get playing(): boolean {
    return this.ctx?.state === "running";
  }

  get started(): boolean {
    return this.ctx !== null;
  }

  /** Noticeably waiting for samples to download (not every bar's quick lookup). */
  get loading(): boolean {
    return this.slowLoad;
  }

  private get arrivingNow(): { from: Engine; to: Engine; at: number } | null {
    return this.arriving && this.ctx && this.now < this.arriving.at ? this.arriving : null;
  }

  /** The engine you hear (lags `engine` while a scheduled switch hasn't arrived yet). */
  get audibleEngine(): Engine {
    return this.arrivingNow?.from ?? this.engineName;
  }

  /** An engine queued to take over, until it is audible. */
  get pendingEngine(): Engine | null {
    return this.pending?.engine ?? this.arrivingNow?.to ?? null;
  }

  /**
   * How far the downloads for a waiting Samples switch (or the first start in
   * Samples mode) have got, 0..1; null when nothing is waiting.
   */
  get loadProgress(): number | null {
    if (!this.ctx) return null;
    if (this.arrivingNow?.to === "samples") return 1;
    const p = this.pending;
    let from: Scheduled | undefined;
    if (this.warming) from = this.upcoming(-Infinity)[0]?.e;
    else if (p?.engine === "samples") {
      if (p.at) return (this.shownProgress = 1);
      from = p.target;
      if (!from) return this.shownProgress;
    } else {
      this.shownProgress = 0;
      return null;
    }
    const ups = this.upcoming(-Infinity);
    const i = ups.findIndex((u) => u.e === from);
    if (i < 0) return 0;
    const until = ups[i]!.start + SWITCH_READY_SECONDS;
    let ready = 0;
    let next = 0;
    for (let j = i; j < ups.length && ups[j]!.start < until; j++) {
      const len = Math.min(ups[j]!.end, until) - ups[j]!.start;
      if (ups[j]!.e.plans) ready += len;
      else if (!next) next = len;
    }
    // Count the bar still downloading by its finished files.
    const partial = next * (this.library?.downloadProgress ?? 0);
    this.shownProgress = Math.max(this.shownProgress, Math.min(1, (ready + partial) / SWITCH_READY_SECONDS));
    return this.shownProgress;
  }

  /** Seconds until a queued switch is heard, once its bar is chosen. */
  get switchIn(): number | null {
    if (!this.ctx) return null;
    const arriving = this.arrivingNow;
    if (arriving) return Math.max(0, arriving.at - this.now);
    const at = this.pending?.at;
    if (!at) return null;
    const u = this.upcoming(-Infinity).find((x) => x.e === at);
    return u ? Math.max(0, u.start - this.now) : null;
  }

  /** Sample download progress, for the UI. */
  get downloads(): { bytes: number; rate: number | null } {
    return { bytes: this.library?.bytes ?? 0, rate: this.rate };
  }

  /** Credits for the sampled instruments heard so far. */
  get sampleCredits(): string[] {
    return this.library?.labels ?? [];
  }

  get now(): number {
    if (!this.ctx) return 0;
    // What is audible now, not what the worklet is rendering.
    return this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
  }

  /** Subscribe to state changes (play/pause, new piece, engine, loading). */
  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Start or resume. Must be called from a user gesture the first time. */
  async play(): Promise<void> {
    if (!this.ctx) {
      this.starting ??= this.boot();
      await this.starting;
    }
    await this.ctx!.resume();
    this.emit();
  }

  async pause(): Promise<void> {
    await this.ctx?.suspend();
    this.emit();
  }

  async toggle(): Promise<void> {
    return this.playing ? this.pause() : this.play();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.output && this.ctx) this.output.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.05);
  }

  /** Change the style pool; if the current piece's style was removed, move on now. */
  setStyles(styles: StyleBundle[]): void {
    if (!styles.length) return;
    for (const s of styles) this.styleById.set(s.id, s);
    this.conductor.setStyles(styles);
    const cur = this.current();
    if (cur && !styles.some((s) => s.id === cur.bar.info.styleId)) this.skip();
  }

  /**
   * Switch sound engine. The new engine takes over at the next bar boundary a
   * moment ahead, re-rendering the bars already queued. Samples are fetched
   * first: the current engine keeps playing and the switch is queued for a
   * phrase start once enough of the music from there is downloaded (slow
   * connections just switch later).
   */
  async setEngine(engine: Engine): Promise<void> {
    if (this.pending) {
      if (engine === this.pending.engine) return;
      this.pending = null;
      this.emit();
    }
    if (engine === this.engineName) return;
    const ctx = this.ctx;
    if (!ctx) {
      this.engineName = engine;
      this.emit();
      return;
    }
    await this.ensureEngine(engine);
    if (engine === "samples") {
      this.pending = { engine, since: ctx.currentTime, lead: 2, bytes: 0, seconds: 0 };
      this.emit();
      void this.prefetchLoop();
      return;
    }
    const previous = this.engineName;
    this.engineName = engine;
    this.emit();
    const my = ++this.token;
    // Wait out any scheduling in flight (it sees the new token and stops), then hold
    // the lock so bars reach the new engine strictly in order.
    while (this.pumping) await new Promise((r) => setTimeout(r, 5));
    if (my !== this.token) return;
    const soon = Math.round((ctx.currentTime + 0.3) * ctx.sampleRate);
    const boundary = this.timeline.find((t) => t.frame >= soon) ?? null;
    this.takeOver(previous, boundary);
  }

  /** Hand the stream to `this.engineName` from `boundary` (a sent bar) or from the next unsent bar. */
  private takeOver(previous: Engine, boundary: Scheduled | null): void {
    const ctx = this.ctx!;
    this.token++;
    this.needsSetup = true;
    this.busStyle = null;
    if (boundary) {
      this.stopEngine(previous, boundary.frame);
      for (const t of this.timeline) if (t.frame >= boundary.frame) this.dispatch(t, t.plans);
    }
    this.emit();
    this.schedule(Math.round(ctx.currentTime * ctx.sampleRate));
  }

  /** Abandon the current piece and start a new one right away. */
  skip(): void {
    this.conductor.skip();
    this.skips++;
    this.ahead = [];
    if (this.pending) this.pending.at = undefined;
    const ctx = this.ctx;
    if (!ctx) return;
    this.token++;
    const sr = ctx.sampleRate;
    const now = ctx.currentTime;
    if (this.engineName === "fm") this.post({ type: "clear" });
    else this.toWorker({ type: "clear", from: Math.round(now * sr) });
    this.timeline = this.timeline.filter((t) => t.start <= now);
    const last = this.timeline[this.timeline.length - 1];
    if (last) last.end = Math.min(last.end, now);
    this.nextFrame = Math.round((now + (this.engineName === "fm" ? 0.08 : 0.25)) * sr);
    this.needsSetup = true;
    this.schedule(this.nextFrame);
  }

  /** The bar audible now. */
  current(): TimedBar | undefined {
    const t = this.now;
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const tb = this.timeline[i]!;
      if (tb.start <= t) return t < tb.end ? tb : undefined;
    }
    return undefined;
  }

  /** Bars overlapping [from, to] (AudioContext seconds). */
  window(from: number, to: number): TimedBar[] {
    return this.timeline.filter((t) => t.end >= from && t.start <= to);
  }

  /** A Standard MIDI File of what has played in the last `minutes`. */
  exportMidi(minutes = 10): Uint8Array | null {
    const t = this.now;
    const bars = this.timeline.filter((tb) => tb.start <= t && tb.start >= t - minutes * 60).map((tb) => tb.bar);
    return bars.length ? barsToMidi(bars) : null;
  }

  // --- Engines ----------------------------------------------------------------

  private async boot(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: "playback" });
    const output = ctx.createGain();
    output.gain.value = this.volume * this.volume;
    output.connect(ctx.destination);
    this.ctx = ctx;
    this.output = output;
    await this.ensureEngine(this.engineName);
    this.nextFrame = Math.round((ctx.currentTime + (this.engineName === "fm" ? 0.15 : 0.3)) * ctx.sampleRate);
    if (this.engineName === "samples") {
      // Start once the first few seconds are downloaded, not bar by bar.
      void this.prefetchLoop();
      this.warming = true;
      this.emit();
      try {
        while (!this.readyFrom(0, this.upcoming(-Infinity))) await new Promise((r) => setTimeout(r, 100));
      } finally {
        this.warming = false;
        this.emit();
      }
    }
    this.needsSetup = true;
    this.schedule(Math.round(ctx.currentTime * ctx.sampleRate));
  }

  private loadWasm(): Promise<ArrayBuffer> {
    this.wasm ??= fetch(this.opts.wasmUrl).then((r) => {
      if (!r.ok) throw new Error(`failed to load synth (${r.status})`);
      return r.arrayBuffer();
    });
    return this.wasm;
  }

  private async ensureEngine(engine: Engine): Promise<void> {
    const ctx = this.ctx!;
    if (engine === "fm") {
      if (this.fmNode) return;
      const [wasm] = await Promise.all([this.loadWasm(), ctx.audioWorklet.addModule(this.opts.processorUrl)]);
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasm: wasm.slice(0), chips: OPL_CHIPS },
      });
      node.connect(this.output!);
      await new Promise<void>((resolve, reject) => {
        node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
          const msg = e.data;
          if (msg.type === "ready") resolve();
          else if (msg.type === "error") reject(new Error(msg.message));
          else if (msg.type === "tick") this.schedule(msg.frame);
        };
      });
      this.fmNode = node;
      return;
    }
    if (!this.stemNode) {
      await ctx.audioWorklet.addModule(this.opts.stemWorkletUrl);
      const node = new AudioWorkletNode(ctx, STEM_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: ROLES.length,
        outputChannelCount: ROLES.map(() => 2),
      });
      const bus = new Bus(ctx);
      ROLES.forEach((role, i) => node.connect(bus.input(role), i));
      bus.output.connect(this.output!);
      const worker = new Worker(this.opts.workerUrl, { type: "module" });
      worker.onerror = (e) => console.error("render worker", e.message);
      const channel = new MessageChannel();
      worker.postMessage({ type: "init", sampleRate: ctx.sampleRate, port: channel.port1 } satisfies ToWorker, [channel.port1]);
      node.port.postMessage({ type: "port", port: channel.port2 }, [channel.port2]);
      node.port.onmessage = (e: MessageEvent<FromStems>) => {
        if (e.data.type !== "tick") return;
        this.levelBus();
        this.schedule(e.data.frame);
      };
      this.stemNode = node;
      this.bus = bus;
      this.worker = worker;
    }
    if (engine === "fm_bus" && !this.workerHasWasm) {
      const wasm = (await this.loadWasm()).slice(0);
      this.toWorker({ type: "wasm", wasm }, [wasm]);
      this.workerHasWasm = true;
    }
    if (engine === "samples") this.library ??= new SampleLibrary(new SampleCache(ctx));
  }

  /**
   * Slow loudness AGC on the bus (within ±6 dB of unity), run on every tick
   * (~12 Hz): busy styles and sparse ones settle at the FM path's level.
   */
  private levelBus(): void {
    const bus = this.bus;
    if (!bus || this.engineName === "fm" || !this.ctx) return;
    bus.meter.getFloatTimeDomainData(this.meterBuf);
    let ms = 0;
    for (const x of this.meterBuf) ms += x * x;
    ms /= this.meterBuf.length;
    const pre = ms / (this.agcGain * this.agcGain);
    // Don't adapt during silence (gaps between pieces, sparse intros).
    if (pre > (TARGET_RMS / 8) ** 2) this.agcEnv += 0.12 * (pre - this.agcEnv);
    const want = Math.max(0.5, Math.min(2, TARGET_RMS / Math.sqrt(this.agcEnv)));
    this.agcGain += (want < this.agcGain ? 0.15 : 0.02) * (want - this.agcGain);
    bus.trim.gain.setTargetAtTime(this.agcGain, this.ctx.currentTime, 0.1);
  }

  /** Silence an engine from `frame` on. */
  private stopEngine(engine: Engine, frame: number): void {
    if (engine === "fm") this.post({ type: "clearFrom", frame });
    else this.toWorker({ type: "clear", from: frame });
  }

  private post(msg: ToWorklet): void {
    this.fmNode?.port.postMessage(msg);
  }

  private toWorker(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  // --- Scheduling ---------------------------------------------------------------

  /** Keep the active engine fed past `frame`. */
  private schedule(frame: number): void {
    // Booting in Samples mode: nothing goes out until the first seconds are downloaded.
    if (this.warming) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    void this.pump(frame);
  }

  private async pump(frame: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.pumping = true;
    const my = this.token;
    try {
      const sr = ctx.sampleRate;
      // If the tab was frozen and we fell behind, jump forward instead of bursting.
      if (this.nextFrame < frame) this.nextFrame = frame + Math.round(0.05 * sr);
      let changed = false;
      while (this.nextFrame < Math.round(ctx.currentTime * sr) + LOOKAHEAD[this.engineName] * sr) {
        const entry = this.ahead.shift() ?? this.generate();
        if (this.pending?.at === entry) {
          this.arriving = { from: this.engineName, to: this.pending.engine, at: Math.max(this.nextFrame / sr, ctx.currentTime) };
          this.engineName = this.pending.engine;
          this.pending = null;
          this.needsSetup = true;
          this.busStyle = null;
          this.emit();
        }
        const plans = this.engineName === "samples" ? await this.plan(entry) : undefined;
        if (my !== this.token) {
          // The conductor has moved past it, so it must still play (unless skipped).
          if (entry.skips === this.skips) this.ahead.unshift(entry);
          return;
        }
        // A slow download leaves a gap rather than playing late.
        const earliest = Math.round((ctx.currentTime + 0.1) * sr);
        if (this.nextFrame < earliest) this.nextFrame = earliest;
        entry.frame = this.nextFrame;
        entry.start = entry.frame / sr;
        entry.end = (entry.frame + entry.frames) / sr;
        this.dispatch(entry, plans);
        this.timeline.push(entry);
        this.nextFrame += entry.frames;
        if (entry.bar.info.pieceIndex !== this.lastPieceIndex) {
          this.lastPieceIndex = entry.bar.info.pieceIndex;
          changed = true;
        }
      }
      const cutoff = ctx.currentTime - HISTORY_SECONDS;
      if (this.timeline.length && this.timeline[0]!.end < cutoff) {
        this.timeline = this.timeline.filter((t) => t.end >= cutoff);
      }
      if (changed) this.emit();
    } finally {
      this.pumping = false;
      if (this.again) {
        this.again = false;
        queueMicrotask(() => this.schedule(Math.round(ctx.currentTime * ctx.sampleRate)));
      }
    }
  }

  private generate(): Scheduled {
    const bar = this.conductor.nextBar();
    return { bar, notes: this.notesOf(bar), skips: this.skips, frame: 0, frames: barFrames(bar, this.ctx!.sampleRate), start: 0, end: 0 };
  }

  /** Unplayed bars with their (expected) start times: sent ones from `from` on, then the unsent queue. */
  private upcoming(from = this.ctx!.currentTime): { e: Scheduled; start: number; end: number }[] {
    const sr = this.ctx!.sampleRate;
    const out = this.timeline.filter((t) => t.start >= from).map((e) => ({ e, start: e.start, end: e.end }));
    let f = this.nextFrame;
    for (const e of this.ahead) {
      out.push({ e, start: f / sr, end: (f + e.frames) / sr });
      f += e.frames;
    }
    return out;
  }

  /** Whether every bar for SWITCH_READY_SECONDS from `ups[i]` has its samples. */
  private readyFrom(i: number, ups: { e: Scheduled; start: number; end: number }[]): boolean {
    const first = ups[i];
    if (!first) return false;
    const until = first.start + SWITCH_READY_SECONDS;
    for (let j = i; j < ups.length; j++) {
      if (!ups[j]!.e.plans) return false;
      if (ups[j]!.end >= until) return true;
    }
    return false;
  }

  /**
   * How far ahead to download, seconds: more when the connection is slow
   * relative to what the music needs, and enough to reach a section start
   * while a switch is waiting.
   */
  private prefetchHorizon(): number {
    const base = this.pending ? SWITCH_READY_SECONDS + 24 : 8;
    if (!this.rate) return base;
    return Math.min(60, Math.max(base, 8 + 40 * (this.needRate / this.rate)));
  }

  /** Background downloads for the Samples engine (current or queued). */
  private async prefetchLoop(): Promise<void> {
    if (this.prefetching) return;
    this.prefetching = true;
    try {
      while (this.ctx && (this.engineName === "samples" || this.pending?.engine === "samples")) {
        const now = this.ctx.currentTime;
        // While a switch waits, only download from its target on; earlier bars play on the old engine.
        const floor = this.switchFloor(now);
        const horizon = Math.max(now + this.prefetchHorizon(), floor + SWITCH_READY_SECONDS + 1);
        const ups = this.generateUntil(horizon);
        const todo = ups.find((u) => !u.e.plans && u.start >= floor - 1e-3 && u.start < horizon);
        if (todo) {
          // Don't block on one slow bar: re-evaluate the target while it downloads.
          await Promise.race([this.plan(todo.e), new Promise((r) => setTimeout(r, 400))]);
          this.maybeSwitch();
          continue;
        }
        this.maybeSwitch();
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      this.prefetching = false;
    }
  }

  /** Generate unsent bars until the upcoming music reaches `until` (context seconds). */
  private generateUntil(until: number): { e: Scheduled; start: number; end: number }[] {
    let ups = this.upcoming();
    while (!ups.length || ups[ups.length - 1]!.end < until) {
      this.ahead.push(this.generate());
      ups = this.upcoming();
    }
    return ups;
  }

  /**
   * Where a waiting switch downloads from. First the very next bars (if they
   * are cached the switch is instant). After that, a section start far enough
   * out that its first seconds can download in time, judged from the measured
   * connection speed and how many new bytes per second this music needs. A
   * target that can no longer make it is dropped for a later one; what was
   * downloaded for it stays cached, so each retry needs less.
   */
  private switchFloor(now: number): number {
    const p = this.pending;
    if (!p || p.engine !== "samples") return now;
    if (p.at) return this.upcoming(-Infinity).find((u) => u.e === p.at)?.start ?? now;
    if (now - p.since < 0.5 && !p.target) return now;
    const demand = p.seconds > 0 ? p.bytes / p.seconds : Math.max(this.needRate, 50e3);
    const rate = this.rate ?? 100e3;
    let ups = this.upcoming(now + 0.3);
    let t = p.target ? ups.find((u) => u.e === p.target) : undefined;
    if (t) {
      let unplanned = 0;
      for (const u of ups) if (u.start >= t.start && u.start < t.start + SWITCH_READY_SECONDS && !u.e.plans) unplanned += u.end - u.start;
      if (t.start - now < (unplanned * demand) / rate + 0.5) t = undefined;
    }
    if (!t) {
      p.lead = Math.min(120, Math.max(p.lead, (1.3 * demand * SWITCH_READY_SECONDS) / rate + 1));
      ups = this.generateUntil(now + p.lead + 40).filter((u) => u.start >= now + 0.3);
      const i = pickBoundary(ups, (u) => u.start >= now + p!.lead);
      t = i >= 0 ? ups[i] : ups.find((u) => u.start >= now + p.lead);
      p.target = t?.e;
    }
    return t?.start ?? now;
  }

  /** Make a queued switch happen once its samples are in: right away if they were quick, else at a section start. */
  private maybeSwitch(): void {
    const p = this.pending;
    const ctx = this.ctx;
    if (!p || p.at || !ctx || this.pumping) return;
    const now = ctx.currentTime;
    const ups = this.upcoming(now + 0.3);
    const waited = now - p.since;
    let pick = -1;
    if (waited < 0.5 && this.readyFrom(0, ups)) pick = 0;
    else {
      pick = pickBoundary(ups, (_, i) => this.readyFrom(i, ups));
      if (pick < 0 && waited > SWITCH_MAX_WAIT) pick = ups.findIndex((_, i) => this.readyFrom(i, ups));
    }
    if (pick < 0) {
      this.emit();
      return;
    }
    const at = ups[pick]!.e;
    if (this.timeline.includes(at)) {
      // Already sent to the old engine: switch now and re-send from there.
      const previous = this.engineName;
      this.engineName = p.engine;
      this.pending = null;
      this.takeOver(previous, at);
    } else {
      // Still unsent: the old engine plays up to it, and pump() swaps when it gets there.
      p.at = at;
      this.emit();
    }
  }

  /** Samples engine: plan a bar once (prefetch and playback share the result). */
  private plan(entry: Scheduled): Promise<PlannedNote[]> {
    entry.planning ??= this.prepare(entry).then((plans) => (entry.plans = plans));
    return entry.planning;
  }

  /** The bar's notes in seconds from its start, with the program sounding on each channel. */
  private notesOf(bar: Bar): ScoreNote[] {
    for (const c of bar.controls) {
      if (c.kind === "reset") this.programs.clear();
      else if (c.kind === "program") this.programs.set(c.ch, c.value);
    }
    const spb = 60 / bar.bpm;
    return bar.notes.map((n) => ({
      t: n.beat * spb,
      dur: Math.max(0.01, n.dur * spb),
      key: n.key,
      vel: n.vel,
      ch: n.ch,
      role: n.role,
      program: this.programs.get(n.ch) ?? 0,
    }));
  }

  /** Samples engine: resolve and download what the bar needs, hand new samples to the worker. */
  private async prepare(entry: Scheduled): Promise<PlannedNote[]> {
    const lib = this.library!;
    if (this.loadingCount++ === 0) {
      this.slowTimer = setTimeout(() => {
        this.slowLoad = true;
        this.emit();
      }, 300);
    }
    try {
      const t0 = performance.now();
      const { plans, fresh } = await lib.prepare(entry.notes, entry.bar.info.styleId);
      // Connection speed from real downloads; demand from what the music needed.
      const bytes = [...fresh.keys()].reduce((a, u) => a + (lib.sizes.get(u) ?? 0), 0);
      const seconds = (performance.now() - t0) / 1000;
      if (bytes > 30_000 && seconds > 0.02) this.rate = this.rate ? 0.7 * this.rate + 0.3 * (bytes / seconds) : bytes / seconds;
      const barSeconds = entry.frames / (this.ctx?.sampleRate ?? 48000);
      this.needRate += 0.1 * (bytes / barSeconds - this.needRate);
      if (this.pending) {
        this.pending.bytes += bytes;
        this.pending.seconds += barSeconds;
      }
      if (fresh.size) {
        const items = [...fresh];
        // Sample data moves to the worker; the main thread never reads it again.
        const buffers = new Set(items.flatMap(([, d]) => d.channels.map((c) => c.buffer)));
        this.toWorker({ type: "samples", items }, [...buffers]);
      }
      return plans;
    } finally {
      if (--this.loadingCount === 0) {
        if (this.slowTimer) clearTimeout(this.slowTimer);
        this.slowTimer = null;
        if (this.slowLoad) {
          this.slowLoad = false;
          this.emit();
        }
      }
    }
  }

  /** Bar setup carried over from earlier bars of its piece (for an engine joining mid-piece). */
  private withSetup(entry: Scheduled): Bar {
    if (!this.needsSetup) return entry.bar;
    this.needsSetup = false;
    const piece = entry.bar.info.pieceIndex;
    const setup = this.timeline
      .filter((t) => t.bar.info.pieceIndex === piece && t.frame < entry.frame)
      .flatMap((t) => t.bar.controls.map((c) => ({ ...c, beat: 0 })));
    return setup.length ? { ...entry.bar, controls: [...setup, ...entry.bar.controls] } : entry.bar;
  }

  private dispatch(entry: Scheduled, plans: PlannedNote[] | undefined): void {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const bar = this.withSetup(entry);
    const engine = this.engineName;
    if (engine === "fm") {
      this.post({ type: "events", events: barEvents(bar, entry.frame, sr) });
      return;
    }
    const info = bar.info;
    const style = this.styleById.get(info.styleId);
    const at = entry.start;
    if (this.bus && style && (info.barInPiece === 0 || this.busStyle !== info.styleId)) {
      const pans = Object.fromEntries(style.corpus.instruments.map((i) => [i.role, i.pan])) as Partial<Record<Role, number>>;
      this.bus.setStyle(style.id, bar.bpm, pans, Math.max(at, ctx.currentTime));
      this.busStyle = info.styleId;
    }
    const notes = entry.notes.map((n) => ({ ...n, t: n.t + at }));
    this.bus?.duck(info.styleId, notes.filter((n) => n.role === "drums" && (n.key === 35 || n.key === 36)).map((n) => n.t));
    const levels = Object.fromEntries((style?.corpus.instruments ?? []).map((i) => [i.role, i.volume])) as Partial<Record<Role, number>>;
    this.toWorker({
      type: "bar",
      engine,
      start: entry.frame,
      frames: entry.frames,
      styleId: info.styleId,
      newPiece: info.barInPiece === 0,
      levels,
      notes,
      plans: plans?.map((p) => (p.cut === undefined ? p : { ...p, cut: p.cut + at })),
      bar: engine === "fm_bus" ? bar : undefined,
    });
  }
}
