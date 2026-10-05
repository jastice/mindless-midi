/**
 * Main-thread side of playback: owns the AudioContext and worklet, asks the
 * conductor for bars a few seconds ahead and ships them as timestamped
 * events. Scheduling is driven by "tick" messages from the audio thread
 * rather than timers, so it keeps going in background tabs.
 */
import { barEvents, barFrames } from "../audio/events.js";
import { type FromWorklet, PROCESSOR_NAME, type ToWorklet } from "../audio/protocol.js";
import type { StyleBundle } from "../corpus/schema.js";
import { Conductor } from "../engine/conductor.js";
import { barsToMidi } from "../engine/midi_file.js";
import type { Bar } from "../engine/types.js";

export interface TimedBar {
  bar: Bar;
  /** AudioContext time (seconds) at which the bar starts / ends. */
  start: number;
  end: number;
}

export interface PlayerOptions {
  seed: string;
  processorUrl: string;
  wasmUrl: string;
  /** How far ahead to schedule, seconds. */
  lookahead?: number;
}

type Listener = () => void;

const HISTORY_SECONDS = 20 * 60;
const OPL_CHIPS = 4;

export class Player {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private output: GainNode | null = null;
  private readonly conductor: Conductor;
  private readonly opts: Required<PlayerOptions>;
  private styles: StyleBundle[];
  private nextFrame = 0;
  private timeline: TimedBar[] = [];
  private volume = 0.8;
  private starting: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();
  private lastPieceIndex = -1;

  constructor(styles: StyleBundle[], opts: PlayerOptions) {
    this.styles = styles;
    this.opts = { lookahead: 3, ...opts };
    this.conductor = new Conductor(styles, opts.seed);
  }

  get seed(): string {
    return this.conductor.seed;
  }

  get playing(): boolean {
    return this.ctx?.state === "running";
  }

  get started(): boolean {
    return this.node !== null;
  }

  get now(): number {
    if (!this.ctx) return 0;
    // What is audible now, not what the worklet is rendering.
    return this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
  }

  /** Subscribe to state changes (play/pause, new piece). */
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
    this.styles = styles;
    this.conductor.setStyles(styles);
    const cur = this.current();
    if (cur && !styles.some((s) => s.id === cur.bar.info.styleId)) this.skip();
  }

  /** Abandon the current piece and start a new one right away. */
  skip(): void {
    this.conductor.skip();
    if (!this.ctx || !this.node) return;
    this.post({ type: "clear" });
    const now = this.ctx.currentTime;
    this.timeline = this.timeline.filter((t) => t.start <= now);
    const last = this.timeline[this.timeline.length - 1];
    if (last) last.end = Math.min(last.end, now);
    this.nextFrame = Math.round((now + 0.08) * this.ctx.sampleRate);
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

  private async boot(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: "playback" });
    const [wasm] = await Promise.all([
      fetch(this.opts.wasmUrl).then((r) => {
        if (!r.ok) throw new Error(`failed to load synth (${r.status})`);
        return r.arrayBuffer();
      }),
      ctx.audioWorklet.addModule(this.opts.processorUrl),
    ]);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasm, chips: OPL_CHIPS },
    });
    const output = ctx.createGain();
    output.gain.value = this.volume * this.volume;
    node.connect(output).connect(ctx.destination);

    const ready = new Promise<void>((resolve, reject) => {
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
        const msg = e.data;
        if (msg.type === "ready") resolve();
        else if (msg.type === "error") reject(new Error(msg.message));
        else if (msg.type === "tick") this.schedule(msg.frame);
      };
    });
    this.ctx = ctx;
    this.node = node;
    this.output = output;
    this.nextFrame = Math.round((ctx.currentTime + 0.15) * ctx.sampleRate);
    this.schedule(Math.round(ctx.currentTime * ctx.sampleRate));
    await ready;
  }

  private post(msg: ToWorklet): void {
    this.node?.port.postMessage(msg);
  }

  /** Keep the worklet fed `lookahead` seconds past `frame`. */
  private schedule(frame: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const sr = ctx.sampleRate;
    const horizon = frame + this.opts.lookahead * sr;
    // If the tab was frozen and we fell behind, jump forward instead of bursting.
    if (this.nextFrame < frame) this.nextFrame = frame + Math.round(0.05 * sr);
    let changed = false;
    while (this.nextFrame < horizon) {
      const bar = this.conductor.nextBar();
      const frames = barFrames(bar, sr);
      this.post({ type: "events", events: barEvents(bar, this.nextFrame, sr) });
      this.timeline.push({ bar, start: this.nextFrame / sr, end: (this.nextFrame + frames) / sr });
      this.nextFrame += frames;
      if (bar.info.pieceIndex !== this.lastPieceIndex) {
        this.lastPieceIndex = bar.info.pieceIndex;
        changed = true;
      }
    }
    const cutoff = frame / sr - HISTORY_SECONDS;
    if (this.timeline.length && this.timeline[0]!.end < cutoff) {
      this.timeline = this.timeline.filter((t) => t.end >= cutoff);
    }
    if (changed) this.emit();
  }
}
