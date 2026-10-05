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
}

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
  /** A generated bar whose dispatch was interrupted by an engine switch; it goes out next. */
  private carry: { entry: Scheduled; skips: number } | null = null;
  private skips = 0;
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
   * Switch sound engine. While playing, the new engine takes over at the
   * next bar boundary a moment ahead, re-rendering the bars already queued.
   */
  async setEngine(engine: Engine): Promise<void> {
    if (engine === this.engineName) return;
    const previous = this.engineName;
    this.engineName = engine;
    this.emit();
    const ctx = this.ctx;
    if (!ctx) return;
    const my = ++this.token;
    await this.ensureEngine(engine);
    // Wait out any scheduling in flight (it sees the new token and stops), then hold
    // the lock so bars reach the new engine strictly in order.
    while (this.pumping) await new Promise((r) => setTimeout(r, 5));
    if (my !== this.token) return;
    this.pumping = true;
    try {
      const sr = ctx.sampleRate;
      const soon = Math.round((ctx.currentTime + 0.3) * sr);
      const redo = this.timeline.filter((t) => t.frame >= soon);
      const boundary = redo[0]?.frame ?? this.nextFrame;
      this.stopEngine(previous, boundary);
      this.needsSetup = true;
      this.busStyle = null;
      for (const t of redo) {
        const plans = engine === "samples" ? await this.prepare(t) : undefined;
        if (my !== this.token) return;
        this.dispatch(t, plans);
      }
    } finally {
      this.pumping = false;
    }
    this.schedule(Math.round(ctx.currentTime * ctx.sampleRate));
  }

  /** Abandon the current piece and start a new one right away. */
  skip(): void {
    this.conductor.skip();
    this.skips++;
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
        // The conductor has moved on past an interrupted bar, so it must still play (unless skipped).
        const carried = this.carry?.skips === this.skips ? this.carry.entry : null;
        this.carry = null;
        let entry: Scheduled;
        if (carried) entry = carried;
        else {
          const bar = this.conductor.nextBar();
          entry = { bar, notes: this.notesOf(bar), frame: 0, frames: barFrames(bar, sr), start: 0, end: 0 };
        }
        const plans = this.engineName === "samples" ? await this.prepare(entry) : undefined;
        if (my !== this.token) {
          this.carry = { entry, skips: this.skips };
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
      const { plans, fresh } = await lib.prepare(entry.notes, entry.bar.info.styleId);
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
