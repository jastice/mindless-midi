/**
 * Offline rendering through the same event queue the AudioWorklet uses, with
 * libADLMIDI's WASM core running in Node. Used by tests and the render CLI.
 */
import { AdlMidiCore } from "libadlmidi-js/nuked";
import type { StyleBundle } from "../../src/corpus/schema.js";
import { Conductor } from "../../src/engine/conductor.js";
import type { PieceOptions } from "../../src/engine/piece.js";
import type { Bar } from "../../src/engine/types.js";
import { EventQueue, type SynthSink, barEvents, barFrames } from "../../src/audio/events.js";
import { Leveler } from "../../src/audio/leveler.js";

type Core = Awaited<ReturnType<typeof AdlMidiCore.create>>;

export interface RenderOptions {
  seconds: number;
  seed: string;
  sampleRate?: number;
  chips?: number;
  pieces?: PieceOptions;
  /** Apply the browser's output stage (style gain, AGC, limiter). */
  applyGain?: boolean;
}

export interface Rendered {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  bars: Bar[];
  wallMs: number;
}

class CoreSink implements SynthSink {
  private bank = -1;
  constructor(
    private readonly core: Core,
    private readonly leveler: Leveler | null,
  ) {}
  setGain(gain: number): void {
    this.leveler?.setGain(gain);
  }
  noteOn(ch: number, key: number, vel: number): void {
    this.core.noteOn(ch, key, vel);
  }
  noteOff(ch: number, key: number): void {
    this.core.noteOff(ch, key);
  }
  controlChange(ch: number, cc: number, value: number): void {
    this.core.controllerChange(ch, cc, value);
  }
  programChange(ch: number, program: number): void {
    this.core.programChange(ch, program);
  }
  setBank(bank: number): void {
    if (bank === this.bank) return;
    this.bank = bank;
    this.core.setBank(bank);
    this.core.resetFull();
  }
  reset(): void {
    this.core.panic();
    this.core.reset();
  }
}

export async function render(styles: StyleBundle[], opts: RenderOptions): Promise<Rendered> {
  const sampleRate = opts.sampleRate ?? 44100;
  const core = await AdlMidiCore.create();
  core.init(sampleRate);
  core.setNumChips(opts.chips ?? 4);
  core.setSoftPanEnabled(true);
  const leveler = opts.applyGain ? new Leveler(sampleRate) : null;
  const sink = new CoreSink(core, leveler);

  const conductor = new Conductor(styles, opts.seed, opts.pieces);
  const queue = new EventQueue();
  const total = Math.round(opts.seconds * sampleRate);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const bars: Bar[] = [];
  const chunk = 512;
  let nextBar = 0;
  const t0 = performance.now();
  for (let frame = 0; frame < total; frame += chunk) {
    while (nextBar < frame + sampleRate) {
      const bar = conductor.nextBar();
      bars.push(bar);
      queue.push(barEvents(bar, nextBar, sampleRate));
      nextBar += barFrames(bar, sampleRate);
    }
    const n = Math.min(chunk, total - frame);
    queue.run(frame, n, sink, (offset, count) => {
      const pcm = core.generate(count);
      for (let i = 0; i < count; i++) {
        left[frame + offset + i] = pcm[i * 2]!;
        right[frame + offset + i] = pcm[i * 2 + 1]!;
      }
      leveler?.process(left, right, frame + offset, count);
    });
  }
  const wallMs = performance.now() - t0;
  core.close();
  return { sampleRate, left, right, bars, wallMs };
}

export interface LevelStats {
  peak: number;
  rms: number;
  /** RMS per second, to spot dropouts. */
  rmsPerSecond: number[];
  nonFinite: number;
}

export function levels(r: Pick<Rendered, "left" | "right" | "sampleRate">): LevelStats {
  let peak = 0;
  let sum = 0;
  let nonFinite = 0;
  const perSecond: number[] = [];
  let secSum = 0;
  for (let i = 0; i < r.left.length; i++) {
    const l = r.left[i]!;
    const rr = r.right[i]!;
    if (!Number.isFinite(l) || !Number.isFinite(rr)) nonFinite++;
    peak = Math.max(peak, Math.abs(l), Math.abs(rr));
    const e = (l * l + rr * rr) / 2;
    sum += e;
    secSum += e;
    if ((i + 1) % r.sampleRate === 0) {
      perSecond.push(Math.sqrt(secSum / r.sampleRate));
      secSum = 0;
    }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, r.left.length)), rmsPerSecond: perSecond, nonFinite };
}

/** 16-bit PCM stereo WAV. */
export function toWav(r: Pick<Rendered, "left" | "right" | "sampleRate">, gain = 1): Uint8Array {
  const n = r.left.length;
  const data = n * 4;
  const buf = new DataView(new ArrayBuffer(44 + data));
  const str = (o: number, s: string) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  buf.setUint32(4, 36 + data, true);
  str(8, "WAVE");
  str(12, "fmt ");
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 2, true);
  buf.setUint32(24, r.sampleRate, true);
  buf.setUint32(28, r.sampleRate * 4, true);
  buf.setUint16(32, 4, true);
  buf.setUint16(34, 16, true);
  str(36, "data");
  buf.setUint32(40, data, true);
  const s16 = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * gain * 32767)));
  for (let i = 0; i < n; i++) {
    buf.setInt16(44 + i * 4, s16(r.left[i]!), true);
    buf.setInt16(46 + i * 4, s16(r.right[i]!), true);
  }
  return new Uint8Array(buf.buffer);
}
