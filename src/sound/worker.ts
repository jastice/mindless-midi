/**
 * Render worker for the stem engines. The main thread sends bars (as notes,
 * plus sample plans or the raw bar for libADLMIDI); this renders each role's
 * audio for the bar, levels it, and streams it straight to the stem worklet
 * through a MessagePort. Notes ring into later bars through per-role windows.
 */
// @ts-expect-error: untyped Emscripten ES module from libadlmidi-js
import createADLMIDIUntyped from "libadlmidi-js/dist/libadlmidi.nuked.browser.js";
import type { AdlModule, CreateAdlModule } from "../audio/adlmidi_wasm.js";
import { EV_CC, EventQueue, type SynthSink, barEvents } from "../audio/events.js";
import { ROLES, type Role } from "../corpus/constants.js";
import { BodyLeveler } from "./body_leveler.js";
import { STEM_REF } from "./bus.js";
import { StemWindow, type Stereo } from "./dsp.js";
import { RoleLeveler } from "./leveler.js";
import type { StemEngine, ToStems, ToWorker } from "./protocol.js";
import { MAX_SAMPLE_SECONDS, type SampleData, renderSampleNote } from "./sampler.js";
import { MAX_VOICE_SECONDS, renderSynthNote } from "./synth.js";
import type { ScoreNote } from "./types.js";
import { type StemId, WeightedMix, weightFor } from "./weight.js";

const createADLMIDI = createADLMIDIUntyped as CreateAdlModule;
declare const self: { onmessage: ((e: MessageEvent<ToWorker>) => void) | null };

let sr = 48000;
let port: MessagePort | null = null;
let engine: StemEngine | null = null;
const samples = new Map<string, SampleData>();
const windows = new Map<StemId, StemWindow>();
const levelers = new Map<Role, RoleLeveler>();
/** The weighted mix's levellers (one per role; the kick shares the kit's) and its stem processing. */
const bodies = new Map<Role, BodyLeveler>();
let weighted: WeightedMix | null = null;
/** Roughly how amplitude follows velocity in each engine (`velocity^law`), for reading a stem's level apart from how hard its section is played. */
const LAW: Record<StemEngine, number> = { synth: 1.3, samples: 1.8, fm_bus: 1.5 };

/**
 * The weighted mix levels an instrument for a section at full intensity, and most sections are not:
 * this much above the plain target puts a typical section where the plain mix has it, so the bus trim rests near unity.
 */
const FULL_STRENGTH = 1.4;

/** The stem a note is rendered into: its role, or the kick's own stem when the mix wants it apart. */
const stemOf = (n: { role: Role; key: number }, split: boolean): StemId => (split && n.role === "drums" && (n.key === 35 || n.key === 36) ? "kick" : n.role);
const prev = new Map<Role, ScoreNote>();
let wasm: ArrayBuffer | null = null;
let fm: Promise<FmStems> | null = null;

/** One libADLMIDI instance per role, so each role gets its own stem. */
class FmStems {
  private readonly players = new Map<StemId, { p: number; queue: EventQueue; sink: SynthSink }>();
  private readonly buf: number;
  private static readonly CHUNK = 2048;
  constructor(private readonly m: AdlModule) {
    this.buf = m._malloc(FmStems.CHUNK * 4);
  }
  private player(role: StemId) {
    let pl = this.players.get(role);
    if (pl) return pl;
    const m = this.m;
    const p = m._adl_init(sr);
    m._adl_switchEmulator(p, 1);
    m._adl_setNumChips(p, 2);
    m._adl_setSoftPanEnabled(p, 1);
    let bank = -1;
    const sink: SynthSink = {
      noteOn: (ch, key, vel) => void m._adl_rt_noteOn(p, ch, key, vel),
      noteOff: (ch, key) => m._adl_rt_noteOff(p, ch, key),
      controlChange: (ch, cc, v) => m._adl_rt_controllerChange(p, ch, cc, v),
      programChange: (ch, prog) => m._adl_rt_patchChange(p, ch, prog),
      pitchBend: (ch, value) => m._adl_rt_pitchBend(p, ch, value),
      setBank: (b) => {
        if (b === bank) return;
        bank = b;
        m._adl_setBank(p, b);
        m._adl_reset(p);
      },
      reset: () => {
        m._adl_panic(p);
        m._adl_rt_resetState(p);
      },
      setGain: () => {},
    };
    pl = { p, queue: new EventQueue(), sink };
    this.players.set(role, pl);
    return pl;
  }
  render(msg: Extract<ToWorker, { type: "bar" }>, split: boolean): Map<StemId, Stereo> {
    const out = new Map<StemId, Stereo>();
    const bar = msg.bar!;
    const roles = new Set<StemId>([...this.players.keys(), ...bar.notes.map((n) => stemOf(n, split))]);
    for (const role of roles) {
      const pl = this.player(role);
      // The bus pans the stem; keep the chip centred.
      const events = barEvents({ ...bar, notes: bar.notes.filter((n) => stemOf(n, split) === role) }, msg.start, sr).filter((e) => !(e.type === EV_CC && e.a === 10));
      pl.queue.push(events);
      const s: Stereo = { l: new Float32Array(msg.frames), r: new Float32Array(msg.frames) };
      for (let at = 0; at < msg.frames; at += FmStems.CHUNK) {
        const n = Math.min(FmStems.CHUNK, msg.frames - at);
        pl.queue.run(msg.start + at, n, pl.sink, (offset, count) => {
          this.m._adl_generate(pl.p, count * 2, this.buf);
          const pcm = new Int16Array(this.m.HEAP16.buffer, this.buf, count * 2);
          for (let i = 0; i < count; i++) {
            s.l[at + offset + i] = pcm[i * 2]! / 32768;
            s.r[at + offset + i] = pcm[i * 2 + 1]! / 32768;
          }
        });
      }
      out.set(role, s);
    }
    return out;
  }
  clear(): void {
    for (const pl of this.players.values()) {
      pl.queue.clear();
      pl.sink.reset();
    }
  }
}

function loadFm(): Promise<FmStems> {
  // Don't remember the failure: the wasm may still be on its way, and later bars should get it.
  if (!wasm) return Promise.reject(new Error("no libADLMIDI wasm"));
  fm ??= (async () => {
    const bytes = wasm!;
    const m = await createADLMIDI({
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(bytes, imports).then((r) => done(r.instance));
        return {};
      },
    });
    return new FmStems(m);
  })();
  return fm;
}

function windowFor(role: StemId, start: number): StemWindow {
  let w = windows.get(role);
  if (!w) windows.set(role, (w = new StemWindow(start, Math.ceil((Math.max(MAX_VOICE_SECONDS, MAX_SAMPLE_SECONDS) + 8) * sr))));
  return w;
}

function resetAll(): void {
  windows.clear();
  prev.clear();
  fm?.then((f) => f.clear());
}

async function renderBar(msg: Extract<ToWorker, { type: "bar" }>): Promise<void> {
  if (msg.engine !== engine) {
    resetAll();
    engine = msg.engine;
    // Another engine's loudness says nothing about this one's (the plain levellers find out within a second; these remember).
    for (const l of bodies.values()) l.reset();
  }
  if (msg.newPiece) {
    for (const l of levelers.values()) l.reset();
    for (const l of bodies.values()) l.reset();
  }
  const split = msg.mix !== undefined;
  let stems: Map<StemId, Stereo>;
  if (msg.engine === "fm_bus") {
    stems = (await loadFm()).render(msg, split);
  } else {
    // Notes ring on in each role's window; hand out this bar's frames.
    msg.notes.forEach((n, i) => {
      const w = windowFor(stemOf(n, split), msg.start);
      if (msg.engine === "synth") renderSynthNote(w, n, sr, msg.styleId, prev.get(n.role), msg.touch);
      else if (msg.plans?.[i]) renderSampleNote(w, n, msg.plans[i]!, (u) => samples.get(u), sr);
      prev.set(n.role, n);
    });
    stems = new Map();
    for (const [role, w] of windows) {
      if (w.base < msg.start) w.take(msg.start - w.base);
      stems.set(role, w.take(msg.frames));
    }
  }
  const roles: number[] = [];
  const data: Float32Array[] = [];
  if (msg.mix) {
    for (const s of weigh(stems, msg, msg.mix)) {
      roles.push(ROLES.indexOf(s[0]));
      data.push(s[1].l, s[1].r);
    }
  } else {
    for (const [role, s] of stems as Map<Role, Stereo>) {
      let lv = levelers.get(role);
      if (!lv) levelers.set(role, (lv = new RoleLeveler(sr, STEM_REF)));
      lv.target = (msg.levels[role] ?? 0.5) * STEM_REF;
      lv.process(s);
      roles.push(ROLES.indexOf(role));
      data.push(s.l, s.r);
    }
  }
  const out: ToStems = { type: "pcm", start: msg.start, frames: msg.frames, roles, data };
  port?.postMessage(out, data.map((d) => d.buffer));
}

/** The weighted mix: level each instrument without following the performance, then mix the stems (the kick joins the kit). */
function weigh(stems: Map<StemId, Stereo>, msg: Extract<ToWorker, { type: "bar" }>, mix: { intensity: number; lean: number }): Map<Role, Stereo> {
  // The section's velocity scale as amplitude, by this engine's velocity law.
  const lean = Math.pow(Math.max(0.05, Math.min(1, mix.lean)), LAW[msg.engine]);
  for (const role of ROLES) {
    const group = [stems.get(role), role === "drums" ? stems.get("kick") : undefined].filter((s): s is Stereo => s !== undefined);
    if (!group.length) continue;
    let lv = bodies.get(role);
    if (!lv) bodies.set(role, (lv = new BodyLeveler(sr, STEM_REF)));
    lv.target = (msg.levels[role] ?? 0.5) * STEM_REF * FULL_STRENGTH;
    lv.process(group, msg.notes.some((n) => n.role === role) ? lean : undefined);
  }
  weighted ??= new WeightedMix(sr);
  return weighted.process(stems, weightFor(msg.styleId), mix.intensity);
}

// Bars must be rendered in order even when one awaits the FM module.
let chain = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      sr = msg.sampleRate;
      port = msg.port;
      break;
    case "wasm":
      wasm = msg.wasm;
      break;
    case "samples":
      for (const [url, d] of msg.items) samples.set(url, d);
      break;
    case "bar":
      chain = chain.then(() => renderBar(msg)).catch((err) => console.error("render worker", err));
      break;
    case "clear":
      chain = chain.then(() => {
        resetAll();
        port?.postMessage({ type: "clear", from: msg.from } satisfies ToStems);
      });
      break;
  }
};
