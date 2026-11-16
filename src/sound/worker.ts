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
 *
 * All of that is one `StemDeck`: one track's rendering state. A bar that names
 * no deck is rendered by the one deck there always is, exactly as before. In a
 * set (bars with `deck`) a `SetMix` keeps two: each deck's stems go to outputs
 * of their own (deck 1's after deck 0's), the bus has a strip per deck, and a
 * deck that stops playing rings out over one more bar, faded (see `SetMix`).
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
import type { DeckBar, StemEngine, ToStems, ToWorker } from "./protocol.js";
import { MAX_SAMPLE_SECONDS, type SampleData, renderSampleNote } from "./sampler.js";
import type { SoundSet } from "./sound_set.js";
import { MAX_VOICE_SECONDS, playsPatch, renderSynthNote } from "./synth.js";
import type { Move } from "../engine/types.js";
import type { ScoreNote } from "./types.js";
import { type StemId, WeightedMix, weightFor } from "./weight.js";

const createADLMIDI = createADLMIDIUntyped as CreateAdlModule;
declare const self: { onmessage: ((e: MessageEvent<ToWorker>) => void) | null };

let sr = 48000;
let port: MessagePort | null = null;
let engine: StemEngine | null = null;
const samples = new Map<string, SampleData>();
/** Roughly how amplitude follows velocity in each engine (`velocity^law`), for reading a stem's level apart from how hard its section is played. */
const LAW: Record<StemEngine, number> = { synth: 1.3, samples: 1.8, fm_bus: 1.5 };

/**
 * The weighted mix levels an instrument for a section at full intensity, and most sections are not:
 * this much above the plain target puts a typical section where the plain mix has it, so the bus trim rests near unity.
 */
const FULL_STRENGTH = 1.4;

/** The stem a note is rendered into: its role, or the kick's own stem when the mix wants it apart. */
const stemOf = (n: { role: Role; key: number }, split: boolean): StemId => (split && n.role === "drums" && (n.key === 35 || n.key === 36) ? "kick" : n.role);
let wasm: ArrayBuffer | null = null;
let fm: Promise<FmStems> | null = null;

type BarMsg = Extract<ToWorker, { type: "bar" }>;
/** What a deck renders: its own bar's fields, and the slice's time and engine. */
type DeckJob = DeckBar & { engine: StemEngine; start: number; frames: number; bar?: BarMsg["bar"] };

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
  render(msg: DeckJob, split: boolean): Map<StemId, Stereo> {
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

/** One track's rendering state: windows and previous notes per stem or part, levellers, the weighted mix, moves. */
class StemDeck {
  /** Keyed by stem, or by part id for a note that names its part. */
  private readonly windows = new Map<string, StemWindow>();
  /** The role of each part that has a window. Empty unless a style with parts has played: then the code for parts below runs. */
  private readonly partRole = new Map<string, Role>();
  private readonly levelers = new Map<string, RoleLeveler>();
  /** The weighted mix's levellers (one per role, or per part; the kick shares the kit's) and its stem processing. */
  private readonly bodies = new Map<string, BodyLeveler>();
  private weighted: WeightedMix | null = null;
  /** The previous note of each line: a part's, or a role's. */
  private readonly prev = new Map<string, ScoreNote>();
  /** Moves: their state, made on the first bar that has any. */
  private runner: MoveRunner | null = null;
  /** Risers and impacts, per role they join, with the frame where each window falls silent. */
  private readonly fx = new Map<Role, { w: StemWindow; until: number }>();

  /** Forget what rings and what moves (a seek, or another engine). */
  clear(): void {
    this.windows.clear();
    this.partRole.clear();
    this.prev.clear();
    this.runner?.clear();
    this.fx.clear();
  }

  /** Another engine's loudness says nothing about this one's (the plain levellers find out within a second; these remember). */
  forgetBodies(): void {
    for (const l of this.bodies.values()) l.reset();
  }

  private windowFor(role: string, start: number): StemWindow {
    let w = this.windows.get(role);
    if (!w) this.windows.set(role, (w = new StemWindow(start, Math.ceil((Math.max(MAX_VOICE_SECONDS, MAX_SAMPLE_SECONDS) + 8) * sr))));
    return w;
  }

  /** The bar's stems, one per role, levelled and mixed, with its moves run on them. */
  async render(msg: DeckJob): Promise<Map<Role, Stereo>> {
    if (msg.newPiece) {
      for (const l of this.levelers.values()) l.reset();
      for (const l of this.bodies.values()) l.reset();
    }
    const split = msg.mix !== undefined;
    const mv = msg.moves;
    if (mv) (this.runner ??= new MoveRunner(sr)).begin();
    else if (this.runner?.holding) this.runner.clear();
    const fpb = mv ? msg.frames / mv.beats : 0;
    let stems: Map<string, Stereo>;
    if (msg.engine === "fm_bus") {
      stems = (await loadFm()).render(msg, split);
    } else {
      // Notes ring on in each role's window; hand out this bar's frames.
      msg.notes.forEach((n, i) => {
        let id: string = stemOf(n, split);
        if (n.part !== undefined && id !== "kick") this.partRole.set((id = n.part), n.role);
        const w = this.windowFor(id, msg.start);
        const line = n.part ?? n.role;
        const sound = mv && n.patch !== undefined ? patched(msg.sound, n, mv, msg.start, fpb) : msg.sound;
        if (msg.engine === "synth" || playsPatch(n, msg.sound)) renderSynthNote(w, n, sr, msg.styleId, this.prev.get(line), msg.touch, sound);
        else if (msg.plans?.[i]) renderSampleNote(w, n, msg.plans[i]!, (u) => samples.get(u), sr);
        this.prev.set(line, n);
      });
      stems = new Map();
      for (const [role, w] of this.windows) {
        if (w.base < msg.start) w.take(msg.start - w.base);
        stems.set(role, w.take(msg.frames));
      }
    }
    const extra = mv || this.fx.size ? this.effects(msg, mv) : undefined;
    let out: Map<Role, Stereo>;
    if (msg.mix) {
      out = this.weigh(stems, msg, msg.mix);
      if (extra) out = this.finish(out, mv, extra);
    } else {
      if (mv && this.partRole.size) this.partMoves(stems, mv);
      // With parts: a kit's parts are summed and levelled as one, the others each at their own level, then summed by role.
      const kit = (id: string) => (this.partRole.get(id) === "drums" ? "drums" : id);
      const groups = this.partRole.size ? summed(stems, kit) : stems;
      for (const [id, s] of groups) {
        let lv = this.levelers.get(id);
        if (!lv) this.levelers.set(id, (lv = new RoleLeveler(sr, STEM_REF)));
        lv.target = this.levelOf(msg, id) * STEM_REF;
        lv.process(s);
      }
      out = (this.partRole.size ? summed(groups, this.roleOf) : groups) as Map<Role, Stereo>;
      if (extra) out = this.finish(out, mv, extra);
    }
    if (mv) this.runner!.end();
    return out;
  }

  /** Risers and impacts for this bar: rendered into their windows, this bar's frames taken out. */
  private effects(msg: DeckJob, mv: StemMoves | undefined): Map<Role, Stereo> {
    const fpb = mv ? msg.frames / mv.beats : 0;
    for (const m of mv?.list ?? []) {
      if (m.target !== "riser" && m.target !== "impact") continue;
      const role = (m.scope !== "master" && m.scope.role) || (m.target === "riser" ? "pad" : "drums");
      let f = this.fx.get(role);
      if (!f) this.fx.set(role, (f = { w: new StemWindow(msg.start, Math.ceil(8 * sr)), until: 0 }));
      if (f.w.base < msg.start) f.w.take(msg.start - f.w.base);
      const until = m.target === "riser" ? this.runner!.riser(f.w, role, m, msg.start, fpb) : impact(f.w, m, msg.start, fpb, sr);
      f.until = Math.max(f.until, until);
    }
    const out = new Map<Role, Stereo>();
    for (const [role, f] of this.fx) {
      if (f.w.base < msg.start) f.w.take(msg.start - f.w.base);
      out.set(role, f.w.take(msg.frames));
      if (f.w.base >= f.until) this.fx.delete(role);
    }
    return out;
  }

  /** A part's own moves, on its stem. */
  private partMoves(stems: Map<string, Stereo>, mv: StemMoves): void {
    const fpb = (stems.values().next().value?.l.length ?? 0) / mv.beats;
    for (const [id, s] of stems) {
      if (!this.partRole.has(id)) continue;
      const list = movesOn(mv.list, { part: id, role: this.roleOf(id) as Role });
      if (list.length) this.runner!.apply(s, `part:${id}`, list, fpb);
    }
  }

  /** The role stems with the moves on roles and everything run on them, and the risers and impacts added. */
  private finish(out: Map<Role, Stereo>, mv: StemMoves | undefined, extra: Map<Role, Stereo>): Map<Role, Stereo> {
    if (mv) {
      for (const [role, s] of out) {
        const list = movesOn(mv.list, { role });
        if (list.length) this.runner!.apply(s, `role:${role}`, list, s.l.length / mv.beats);
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
  private readonly roleOf = (id: string): string => this.partRole.get(id) ?? id;

  /** The mix level of a stem or a part: the part's own if the bar gives one, else its role's. */
  private levelOf(msg: DeckJob, id: string): number {
    return msg.partLevels?.[id] ?? msg.levels[this.roleOf(id) as Role] ?? 0.5;
  }

  /** The weighted mix: level each instrument without following the performance, then mix the stems (the kick joins the kit). */
  private weigh(stems: Map<string, Stereo>, msg: DeckJob, mix: { intensity: number; lean: number }): Map<Role, Stereo> {
    // The section's velocity scale as amplitude, by this engine's velocity law.
    const lean = Math.pow(Math.max(0.05, Math.min(1, mix.lean)), LAW[msg.engine]);
    const level = (id: string, group: Stereo[], playing: boolean) => {
      if (!group.length) return;
      let lv = this.bodies.get(id);
      if (!lv) this.bodies.set(id, (lv = new BodyLeveler(sr, STEM_REF)));
      lv.target = this.levelOf(msg, id) * STEM_REF * FULL_STRENGTH;
      lv.process(group, playing ? lean : undefined);
    };
    if (!this.partRole.size) {
      for (const role of ROLES) {
        const group = [stems.get(role), role === "drums" ? stems.get("kick") : undefined].filter((s): s is Stereo => s !== undefined);
        level(role, group, msg.notes.some((n) => n.role === role));
      }
    } else {
      // A kit is one instrument, whatever its parts: they share a leveller with the kick. Every other part is its own.
      const kit = [...stems].filter(([id]) => id === "kick" || this.roleOf(id) === "drums").map(([, s]) => s);
      level("drums", kit, msg.notes.some((n) => n.role === "drums"));
      for (const [id, s] of stems) {
        if (id === "kick" || this.roleOf(id) === "drums") continue;
        level(id, [s], msg.notes.some((n) => (n.part ?? n.role) === id));
      }
      // A part's moves after its levelling, so the leveller never works against a fade or a sweep.
      if (msg.moves) this.partMoves(stems, msg.moves);
      stems = summed(stems, this.roleOf);
    }
    this.weighted ??= new WeightedMix(sr);
    return this.weighted.process(stems as Map<StemId, Stereo>, weightFor(msg.styleId), mix.intensity);
  }
}

/** Moves on a deck's stems that hold the sound where a transition left it: what a ringing tail keeps. */
const HELD = new Set<Move["target"]>(["lowCut", "highCut", "lows"]);

/**
 * Two decks for a set. Each renders its own track's bar into its own stems.
 * The low end and the handover are the set conductor's moves on each deck
 * (lows cut on the deck that does not own them, swapped on a phrase), and the
 * deck without the low end plays drums only, which the kick never ducks: so
 * one kick ducks everything without a shared stage. What is left here is a
 * deck that stops: it rings out over one more bar, its transition's filters
 * held and its level falling to nothing over the first beat, then is dropped.
 */
class SetMix {
  private readonly decks: (StemDeck | null)[] = [null, null];
  /** What each deck played last: its moves, to hold over its tail. Null once its tail has rung. */
  private readonly last: ({ moves: StemMoves | undefined; styleId: string; mix: DeckBar["mix"] } | null)[] = [null, null];

  clear(): void {
    this.decks.fill(null);
    this.last.fill(null);
  }

  async render(msg: BarMsg, roles: number[], data: Float32Array[]): Promise<void> {
    const jobs: DeckJob[] = [msg, ...(msg.with ? [{ ...msg.with, engine: msg.engine, start: msg.start, frames: msg.frames }] : [])];
    const playing = new Set(jobs.map((j) => j.deck ?? 0));
    for (const job of jobs) {
      const d = job.deck ?? 0;
      const deck = (this.decks[d] ??= new StemDeck());
      this.post(d, await deck.render(job), roles, data);
      this.last[d] = { moves: job.moves, styleId: job.styleId, mix: job.mix };
    }
    for (const d of [0, 1] as const) {
      const deck = this.decks[d];
      const last = this.last[d];
      if (!deck || playing.has(d)) continue;
      if (last) this.post(d, await deck.render(tail(msg, last)), roles, data);
      this.decks[d] = null;
      this.last[d] = null;
    }
  }

  private post(deck: number, out: Map<Role, Stereo>, roles: number[], data: Float32Array[]): void {
    for (const [role, s] of out) {
      roles.push(deck * ROLES.length + ROLES.indexOf(role));
      data.push(s.l, s.r);
    }
  }
}

/** A deck's bar after its last: no notes, the filters its transition left held, and a fade to nothing over the first beat. */
function tail(msg: BarMsg, last: { moves: StemMoves | undefined; styleId: string; mix: DeckBar["mix"] }): DeckJob {
  const beats = last.moves?.beats ?? 4;
  const own = (last.moves?.list ?? []).filter((m) => m.scope !== "master" && m.scope.part === undefined && m.scope.deck !== undefined);
  const list: Move[] = own.filter((m) => HELD.has(m.target)).map((m) => ({ scope: m.scope, target: m.target, from: m.to, to: m.to, beats }));
  const gain = own.find((m) => m.target === "gain");
  list.push({ scope: "master", target: "gain", from: gain?.to ?? 1, to: 0, beats: 1 });
  return { engine: msg.engine, start: msg.start, frames: msg.frames, styleId: last.styleId, newPiece: false, levels: {}, notes: [], ...(last.mix && { mix: last.mix }), moves: { beats, list } };
}

/** The one deck of every bar that names none: Mindless Midi, Mighty Midi, and any style without a set. */
const solo = new StemDeck();
const set = new SetMix();

function resetAll(): void {
  solo.clear();
  set.clear();
  fm?.then((f) => f.clear());
}

async function renderBar(msg: BarMsg): Promise<void> {
  if (msg.engine !== engine) {
    resetAll();
    engine = msg.engine;
    solo.forgetBodies();
  }
  const roles: number[] = [];
  const data: Float32Array[] = [];
  if (msg.deck === undefined) {
    for (const [role, s] of await solo.render(msg)) {
      roles.push(ROLES.indexOf(role));
      data.push(s.l, s.r);
    }
  } else await set.render(msg, roles, data);
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
