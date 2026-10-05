/**
 * AudioWorklet processor: libADLMIDI (OPL3 FM emulation, WASM) driven by a
 * sample-accurate event queue. The main thread sends timestamped events a few
 * seconds ahead; this thread applies each at its exact frame.
 */
// @ts-expect-error: untyped Emscripten ES module from libadlmidi-js
import createADLMIDIUntyped from "libadlmidi-js/dist/libadlmidi.nuked.browser.js";
import type { AdlModule, CreateAdlModule } from "./adlmidi_wasm.js";
import { EventQueue, type SynthEvent, type SynthSink } from "./events.js";
import { Leveler } from "./leveler.js";
import { PROCESSOR_NAME, type ToWorklet } from "./protocol.js";

const createADLMIDI = createADLMIDIUntyped as CreateAdlModule;

// Minimal AudioWorkletGlobalScope typings (not in TypeScript's DOM lib).
declare const currentFrame: number;
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const BLOCK = 128;
const IDLE_AFTER = 4;
/** Emulator ids from libADLMIDI: 1 = Nuked OPL3 (fast, bit-exact). */
const EMULATOR_NUKED_FAST = 1;

class AdlSink implements SynthSink {
  private bank = -1;
  constructor(
    private readonly m: AdlModule,
    private readonly p: number,
    private readonly leveler: Leveler,
  ) {}
  setGain(gain: number): void {
    this.leveler.setGain(gain);
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

class MindlessProcessor extends AudioWorkletProcessor {
  private m: AdlModule | null = null;
  private player = 0;
  private buf = 0;
  private sink: AdlSink | null = null;
  private readonly queue = new EventQueue();
  private readonly leveler = new Leveler(sampleRate);
  private blocks = 0;
  private early: SynthEvent[][] = [];
  /** Last frame with queued events; after a few silent seconds the chip idles (another engine may be playing). */
  private busyUntil = 0;

  constructor(options: { processorOptions: { wasm: ArrayBuffer; chips: number } }) {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.onMessage(e.data);
    void this.init(options.processorOptions.wasm, options.processorOptions.chips);
  }

  private async init(wasm: ArrayBuffer, chips: number): Promise<void> {
    try {
      const m = await createADLMIDI({
        instantiateWasm: (imports, done) => {
          WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance));
          return {};
        },
      });
      const p = m._adl_init(sampleRate);
      if (!p) throw new Error("adl_init failed");
      m._adl_switchEmulator(p, EMULATOR_NUKED_FAST);
      m._adl_setNumChips(p, chips);
      m._adl_setSoftPanEnabled(p, 1);
      this.buf = m._malloc(BLOCK * 2 * 2);
      this.m = m;
      this.player = p;
      this.sink = new AdlSink(m, p, this.leveler);
      for (const evs of this.early) this.queue.push(evs);
      this.early = [];
      this.port.postMessage({ type: "ready", frame: currentFrame });
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err) });
    }
  }

  private onMessage(msg: ToWorklet): void {
    switch (msg.type) {
      case "events":
        this.busyUntil = Math.max(this.busyUntil, (msg.events[msg.events.length - 1]?.frame ?? 0) + IDLE_AFTER * sampleRate);
        if (this.sink) this.queue.push(msg.events);
        else this.early.push(msg.events);
        break;
      case "clear":
        this.queue.clear();
        this.early = [];
        this.sink?.reset();
        break;
      case "clearFrom":
        this.queue.clearFrom(msg.frame);
        break;

    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || !this.m || !this.sink) return true;
    if (!this.queue.pending && currentFrame > this.busyUntil) return true;
    const left = out[0]!;
    const right = out[1] ?? left;
    const m = this.m;
    this.queue.run(currentFrame, left.length, this.sink, (offset, count) => {
      m._adl_generate(this.player, count * 2, this.buf);
      const pcm = new Int16Array(m.HEAP16.buffer, this.buf, count * 2);
      for (let i = 0; i < count; i++) {
        left[offset + i] = pcm[i * 2]! / 32768;
        right[offset + i] = pcm[i * 2 + 1]! / 32768;
      }
      this.leveler.process(left, right, offset, count);
    });
    // Ask the main thread for more music ~10 times a second.
    if (++this.blocks % 32 === 0) {
      this.port.postMessage({ type: "tick", frame: currentFrame, pending: this.queue.pending });
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, MindlessProcessor);
