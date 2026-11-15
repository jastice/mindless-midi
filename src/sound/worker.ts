/**
 * Render worker for the stem engines. The main thread sends bars (as notes,
 * plus sample plans or the raw bar for libADLMIDI); this renders each role's
 * audio for the bar, levels it, and streams it straight to the stem worklet
 * through a MessagePort. Notes ring into later bars through per-role windows.
 *
 * A style with parts (corpus `parts`) has a window per part, and a leveller per
 * part except that a kit's parts share one, as its kick and the rest already
 * do. The parts of a role are summed into its stem before the mix, so the
 * worklet and the bus still see one stem per role.
 *
 * A bar with moves (a style with corpus `moves`) has them run on the stems:
 * a part's after its levelling, a role's and everything's on the role stems,
 * then risers and impacts added from windows of their own (see moves.ts). A
 * bar without moves skips all of it.
 */
// @ts-expect-error: untyped Emscripten ES module from libadlmidi-js
import createADLMIDIUntyped from "libadlmidi-js/dist/libadlmidi.nuked.browser.js";
import type { AdlModule, CreateAdlModule } from "../audio/adlmidi_wasm.js";
import { EV_CC, EventQueue, type SynthSink, barEvents } from "../audio/events.js";
import { ROLES, type Role } from "../corpus/constants.js";
import { BodyLeveler } from "./body_leveler.js";
import { covers, moveValue } from "../engine/moves.js";
import { STEM_REF } from "./bus.js";
import { StemWindow, type Stereo } from "./dsp.js";
import { RoleLeveler } from "./leveler.js";
import { MoveRunner, type StemMoves, impact, movesOn } from "./moves.js";
import type { StemEngine, ToStems, ToWorker } from "./protocol.js";
import { MAX_SAMPLE_SECONDS, type SampleData, renderSampleNote } from "./sampler.js";
import type { SoundSet } from "./sound_set.js";
import { MAX_VOICE_SECONDS, playsPatch, renderSynthNote } from "./synth.js";
import type { ScoreNote } from "./types.js";
import { type StemId, WeightedMix, weightFor } from "./weight.js";

const createADLMIDI = createADLMIDIUntyped as CreateAdlModule;
declare const self: { onmessage: ((e: MessageEvent<ToWorker>) => void) | null };

let sr = 48000;
let port: MessagePort | null = null;
let engine: StemEngine | null = null;
const samples = new Map<string, SampleData>();
/** Keyed by stem, or by part id for a note that names its part. */
const windows = new Map<string, StemWindow>();
/** The role of each part that has a window. Empty unless a style with parts has played: then the code for parts below runs. */
const partRole = new Map<string, Role>();
const levelers = new Map<string, RoleLeveler>();
/** The weighted mix's levellers (one per role, or per part; the kick shares the kit's) and its stem processing. */
const bodies = new Map<string, BodyLeveler>();
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
/** The previous note of each line: a part's, or a role's. */
const prev = new Map<string, ScoreNote>();
let wasm: ArrayBuffer | null = null;
let fm: Promise<FmStems> | null = null;
/** Moves: their state, made on the first bar that has any. */
let runner: MoveRunner | null = null;
/** Risers and impacts, per role they join, with the frame where each window falls silent. */
const fx = new Map<Role, { w: StemWindow; until: number }>();

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

function windowFor(role: string, start: number): StemWindow {
  let w = windows.get(role);
  if (!w) windows.set(role, (w = new StemWindow(start, Math.ceil((Math.max(MAX_VOICE_SECONDS, MAX_SAMPLE_SECONDS) + 8) * sr))));
  return w;
}

function resetAll(): void {
  windows.clear();
  partRole.clear();
  prev.clear();
  runner?.clear();
  fx.clear();
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
  const mv = msg.moves;
  if (mv) (runner ??= new MoveRunner(sr)).begin();
  else if (runner?.holding) runner.clear();
  const fpb = mv ? msg.frames / mv.beats : 0;
  let stems: Map<string, Stereo>;
  if (msg.engine === "fm_bus") {
    stems = (await loadFm()).render(msg, split);
  } else {
    // Notes ring on in each role's window; hand out this bar's frames.
    msg.notes.forEach((n, i) => {
      let id: string = stemOf(n, split);
      if (n.part !== undefined && id !== "kick") partRole.set((id = n.part), n.role);
      const w = windowFor(id, msg.start);
      const line = n.part ?? n.role;
      const sound = mv && n.patch !== undefined ? patched(msg.sound, n, mv, msg.start, fpb) : msg.sound;
      if (msg.engine === "synth" || playsPatch(n, msg.sound)) renderSynthNote(w, n, sr, msg.styleId, prev.get(line), msg.touch, sound);
      else if (msg.plans?.[i]) renderSampleNote(w, n, msg.plans[i]!, (u) => samples.get(u), sr);
      prev.set(line, n);
    });
    stems = new Map();
    for (const [role, w] of windows) {
      if (w.base < msg.start) w.take(msg.start - w.base);
      stems.set(role, w.take(msg.frames));
    }
  }
  const extra = mv || fx.size ? effects(msg, mv) : undefined;
  const roles: number[] = [];
  const data: Float32Array[] = [];
  if (msg.mix) {
    let out = weigh(stems, msg, msg.mix);
    if (extra) out = finish(out, mv, extra);
    for (const s of out) {
      roles.push(ROLES.indexOf(s[0]));
      data.push(s[1].l, s[1].r);
    }
  } else {
    if (mv && partRole.size) partMoves(stems, mv);
    // With parts: a kit's parts are summed and levelled as one, the others each at their own level, then summed by role.
    const kit = (id: string) => (partRole.get(id) === "drums" ? "drums" : id);
    const groups = partRole.size ? summed(stems, kit) : stems;
    for (const [id, s] of groups) {
      let lv = levelers.get(id);
      if (!lv) levelers.set(id, (lv = new RoleLeveler(sr, STEM_REF)));
      lv.target = levelOf(msg, id) * STEM_REF;
      lv.process(s);
    }
    let out = (partRole.size ? summed(groups, roleOf) : groups) as Map<Role, Stereo>;
    if (extra) out = finish(out, mv, extra);
    for (const [role, s] of out) {
      roles.push(ROLES.indexOf(role));
      data.push(s.l, s.r);
    }
  }
  if (mv) runner!.end();
  const out: ToStems = { type: "pcm", start: msg.start, frames: msg.frames, roles, data };
  port?.postMessage(out, data.map((d) => d.buffer));
}

/** A note's sound with the bar's patch move on its part applied at its onset (the acid line's drifting cutoff). */
function patched(sound: SoundSet | undefined, n: ScoreNote, mv: StemMoves, barStart: number, fpb: number): SoundSet | undefined {
  const base = sound?.patches?.[n.patch!];
  const m = base && mv.list.find((x) => x.target === "patch" && x.scope !== "master" && covers(x, { part: n.part, role: n.role }));
  if (!m) return sound;
  const v = moveValue(m, (n.t * sr - barStart) / fpb);
  const p = { ...base, filter: { ...base.filter } };
  if (m.param === "cutoff") p.filter.cutoff = v;
  else if (m.param === "q") p.filter.q = v;
  else if (m.param === "env") p.filter.env = v;
  else if (m.param === "drive") p.drive = v;
  return { ...sound, patches: { ...sound!.patches, [n.patch!]: p } };
}

/** Risers and impacts for this bar: rendered into their windows, this bar's frames taken out. */
function effects(msg: Extract<ToWorker, { type: "bar" }>, mv: StemMoves | undefined): Map<Role, Stereo> {
  const fpb = mv ? msg.frames / mv.beats : 0;
  for (const m of mv?.list ?? []) {
    if (m.target !== "riser" && m.target !== "impact") continue;
    const role = (m.scope !== "master" && m.scope.role) || (m.target === "riser" ? "pad" : "drums");
    let f = fx.get(role);
    if (!f) fx.set(role, (f = { w: new StemWindow(msg.start, Math.ceil(8 * sr)), until: 0 }));
    if (f.w.base < msg.start) f.w.take(msg.start - f.w.base);
    const until = m.target === "riser" ? runner!.riser(f.w, role, m, msg.start, fpb) : impact(f.w, m, msg.start, fpb, sr);
    f.until = Math.max(f.until, until);
  }
  const out = new Map<Role, Stereo>();
  for (const [role, f] of fx) {
    if (f.w.base < msg.start) f.w.take(msg.start - f.w.base);
    out.set(role, f.w.take(msg.frames));
    if (f.w.base >= f.until) fx.delete(role);
  }
  return out;
}

/** A part's own moves, on its stem. */
function partMoves(stems: Map<string, Stereo>, mv: StemMoves): void {
  const fpb = (stems.values().next().value?.l.length ?? 0) / mv.beats;
  for (const [id, s] of stems) {
    if (!partRole.has(id)) continue;
    const list = movesOn(mv.list, { part: id, role: roleOf(id) as Role });
    if (list.length) runner!.apply(s, `part:${id}`, list, fpb);
  }
}

/** The role stems with the moves on roles and everything run on them, and the risers and impacts added. */
function finish(out: Map<Role, Stereo>, mv: StemMoves | undefined, extra: Map<Role, Stereo>): Map<Role, Stereo> {
  if (mv) {
    for (const [role, s] of out) {
      const list = movesOn(mv.list, { role });
      if (list.length) runner!.apply(s, `role:${role}`, list, s.l.length / mv.beats);
    }
  }
  for (const [role, e] of extra) {
    const s = out.get(role);
    if (!s) out.set(role, e);
    else
      for (let i = 0; i < s.l.length; i++) {
        s.l[i]! += e.l[i]!;
        s.r[i]! += e.r[i]!;
      }
  }
  return out;
}

/** The stem a window's audio belongs to: a part's role, or the window's own id. */
const roleOf = (id: string): string => partRole.get(id) ?? id;

/** The mix level of a stem or a part: the part's own if the bar gives one, else its role's. */
const levelOf = (msg: Extract<ToWorker, { type: "bar" }>, id: string): number => msg.partLevels?.[id] ?? msg.levels[roleOf(id) as Role] ?? 0.5;

/** Stems added together by `key`, in place into the first of each group. */
function summed(stems: Map<string, Stereo>, key: (id: string) => string): Map<string, Stereo> {
  const out = new Map<string, Stereo>();
  for (const [id, s] of stems) {
    const into = out.get(key(id));
    if (!into) {
      out.set(key(id), s);
      continue;
    }
    for (let i = 0; i < s.l.length; i++) {
      into.l[i]! += s.l[i]!;
      into.r[i]! += s.r[i]!;
    }
  }
  return out;
}

/** The weighted mix: level each instrument without following the performance, then mix the stems (the kick joins the kit). */
function weigh(stems: Map<string, Stereo>, msg: Extract<ToWorker, { type: "bar" }>, mix: { intensity: number; lean: number }): Map<Role, Stereo> {
  // The section's velocity scale as amplitude, by this engine's velocity law.
  const lean = Math.pow(Math.max(0.05, Math.min(1, mix.lean)), LAW[msg.engine]);
  const level = (id: string, group: Stereo[], playing: boolean) => {
    if (!group.length) return;
    let lv = bodies.get(id);
    if (!lv) bodies.set(id, (lv = new BodyLeveler(sr, STEM_REF)));
    lv.target = levelOf(msg, id) * STEM_REF * FULL_STRENGTH;
    lv.process(group, playing ? lean : undefined);
  };
  if (!partRole.size) {
    for (const role of ROLES) {
      const group = [stems.get(role), role === "drums" ? stems.get("kick") : undefined].filter((s): s is Stereo => s !== undefined);
      level(role, group, msg.notes.some((n) => n.role === role));
    }
  } else {
    // A kit is one instrument, whatever its parts: they share a leveller with the kick. Every other part is its own.
    const kit = [...stems].filter(([id]) => id === "kick" || roleOf(id) === "drums").map(([, s]) => s);
    level("drums", kit, msg.notes.some((n) => n.role === "drums"));
    for (const [id, s] of stems) {
      if (id === "kick" || roleOf(id) === "drums") continue;
      level(id, [s], msg.notes.some((n) => (n.part ?? n.role) === id));
    }
    // A part's moves after its levelling, so the leveller never works against a fade or a sweep.
    if (msg.moves) partMoves(stems, msg.moves);
    stems = summed(stems, roleOf);
  }
  weighted ??= new WeightedMix(sr);
  return weighted.process(stems as Map<StemId, Stereo>, weightFor(msg.styleId), mix.intensity);
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
