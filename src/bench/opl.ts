/**
 * Baseline: the shipping OPL3 path (libADLMIDI, Nuked OPL3) rendered on the
 * main thread through the same event queue as the worklet. Renders either
 * the full mix with the app's output stage, or one role at a time as a stem
 * for the shared mix bus.
 */
// @ts-expect-error: untyped Emscripten ES module from libadlmidi-js
import createADLMIDIUntyped from "libadlmidi-js/dist/libadlmidi.nuked.browser.js";
import type { AdlModule, CreateAdlModule } from "../audio/adlmidi_wasm.js";
import { EV_CC, EV_ON, EventQueue, type SynthSink, barEvents, barFrames } from "../audio/events.js";
import { Leveler } from "../audio/leveler.js";
import type { Role } from "../corpus/constants.js";
import { type Stereo, stereo, yieldToUi } from "../sound/dsp.js";
import { type Score, TAIL_SECONDS } from "./score.js";

const createADLMIDI = createADLMIDIUntyped as CreateAdlModule;
const EMULATOR_NUKED_FAST = 1;
const CHIPS = 4;
const CHUNK = 4096;

let modulePromise: Promise<AdlModule> | null = null;

function adl(wasmUrl: string): Promise<AdlModule> {
  modulePromise ??= fetch(wasmUrl)
    .then((r) => r.arrayBuffer())
    .then((wasm) =>
      createADLMIDI({
        instantiateWasm: (imports, done) => {
          WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance));
          return {};
        },
      }),
    );
  return modulePromise;
}

class Sink implements SynthSink {
  private bank = -1;
  constructor(
    private readonly m: AdlModule,
    private readonly p: number,
    private readonly leveler: Leveler | null,
  ) {}
  setGain(gain: number): void {
    this.leveler?.setGain(gain);
  }
  noteOn(ch: number, key: number, vel: number): void {
    this.m._adl_rt_noteOn(this.p, ch, key, vel);
  }
  noteOff(ch: number, key: number): void {
    this.m._adl_rt_noteOff(this.p, ch, key);
  }
  controlChange(ch: number, cc: number, value: number): void {
    this.m._adl_rt_controllerChange(this.p, ch, cc, value);
  }
  programChange(ch: number, program: number): void {
    this.m._adl_rt_patchChange(this.p, ch, program);
  }
  setBank(bank: number): void {
    if (bank === this.bank) return;
    this.bank = bank;
    this.m._adl_setBank(this.p, bank);
    this.m._adl_reset(this.p);
  }
  reset(): void {
    this.m._adl_panic(this.p);
    this.m._adl_rt_resetState(this.p);
  }
}

/** Render the score's bars, optionally only one role, optionally through the app's leveler. */
export async function renderOpl(score: Score, sr: number, wasmUrl: string, opts: { role?: Role; leveler?: boolean } = {}): Promise<Stereo> {
  const m = await adl(wasmUrl);
  const p = m._adl_init(sr);
  if (!p) throw new Error("adl_init failed");
  m._adl_switchEmulator(p, EMULATOR_NUKED_FAST);
  m._adl_setNumChips(p, CHIPS);
  m._adl_setSoftPanEnabled(p, 1);
  const buf = m._malloc(CHUNK * 2 * 2);
  const leveler = opts.leveler ? new Leveler(sr) : null;
  const sink = new Sink(m, p, leveler);
  const queue = new EventQueue();
  const cutoff = Math.round(score.seconds * sr);
  let frame = 0;
  for (const bar of score.bars) {
    const b = opts.role ? { ...bar, notes: bar.notes.filter((n) => n.role === opts.role) } : bar;
    // Stems are panned by the bus (as in the app), so keep the chip centred.
    queue.push(barEvents(b, frame, sr).filter((e) => (e.type !== EV_ON || e.frame < cutoff) && !(opts.role && e.type === EV_CC && e.a === 10)));
    frame += barFrames(bar, sr);
  }
  const total = Math.ceil((score.seconds + TAIL_SECONDS) * sr);
  const out = stereo(total);
  for (let start = 0; start < total; start += CHUNK) {
    const n = Math.min(CHUNK, total - start);
    queue.run(start, n, sink, (offset, count) => {
      m._adl_generate(p, count * 2, buf);
      const pcm = new Int16Array(m.HEAP16.buffer, buf, count * 2);
      for (let i = 0; i < count; i++) {
        out.l[start + offset + i] = pcm[i * 2]! / 32768;
        out.r[start + offset + i] = pcm[i * 2 + 1]! / 32768;
      }
      leveler?.process(out.l, out.r, start + offset, count);
    });
    if ((start / CHUNK) % 64 === 63) await yieldToUi();
  }
  m._free(buf);
  (m as AdlModule & { _adl_close?: (p: number) => void })._adl_close?.(p);
  return out;
}
