/**
 * What the render worker streams for the shipped styles must not change when
 * it learns to key its windows and levellers by part. This drives the worker
 * itself, as the player does, and hashes the stems it posts. The hashes were
 * taken from the code before parts existed (at 500d40c); a change to them
 * changes how Mindless Midi and Mighty Midi sound.
 *
 * The worker keeps its mix state for its lifetime, so the runs depend on
 * their order: add new ones at the end.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROLES, type Role } from "../corpus/constants.js";
import type { StyleBundle } from "../corpus/schema.js";
import { Conductor } from "../engine/conductor.js";
import { velocityScale } from "../engine/parts.js";
import { DEFAULT_PIECE_OPTIONS, Piece, type PieceOptions } from "../engine/piece.js";
import { SetConductor } from "../engine/set.js";
import type { Bar } from "../engine/types.js";
import { type Stereo, stereo } from "./dsp.js";
import { measureWeight } from "./measure.js";
import type { StemEngine, ToStems, ToWorker } from "./protocol.js";
import type { PlannedNote, SampleData } from "./sampler.js";
import { barScore } from "./score.js";
import { partLevels, styleSound } from "./sound_set.js";

const SR = 24000;
const FLOOR = 0.42;
const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };

// The worker is a module worker: it listens on `self`.
const scope: { onmessage: ((e: { data: ToWorker }) => void) | null } = { onmessage: null };
(globalThis as unknown as { self: typeof scope }).self = scope;
await import("./worker.js");

let posted: ToStems[] = [];
let cleared: (() => void) | null = null;
const port = {
  postMessage(msg: ToStems) {
    if (msg.type === "clear") cleared?.();
    else posted.push(msg);
  },
};
const send = (data: ToWorker) => scope.onmessage!({ data });
send({ type: "init", sampleRate: SR, port } as unknown as ToWorker);

// One recording for every sampled note: a decaying tone.
const sample: SampleData = { channels: [new Float32Array(SR / 2)], sampleRate: SR };
for (let i = 0; i < SR / 2; i++) sample.channels[0]![i] = 0.4 * Math.sin(i * 0.11) * Math.exp(-i / (SR * 0.12));
send({ type: "samples", items: [["x", sample]] });

/** Bars of a style through the worker, as the player sends them; a hash of everything it posts. */
async function run(style: StyleBundle, engine: StemEngine, weighted: boolean, bars: number, source?: { nextBar(): Bar }): Promise<string> {
  posted = [];
  const conductor = source ?? new Conductor([style], `worker-${style.id}`, weighted ? { ...DEFAULT_PIECE_OPTIONS, expression: { gestures: true, velocityFloor: FLOOR } } : DEFAULT_PIECE_OPTIONS);
  const parts = partLevels(style.corpus);
  const levels = Object.fromEntries(style.corpus.instruments.map((i) => [i.role, i.volume])) as Partial<Record<Role, number>>;
  const sound = styleSound(style.corpus);
  const programs = new Map<number, number>();
  const patches = new Map<number | string, string>();
  let start = 0;
  for (let b = 0; b < bars; b++) {
    const bar = conductor.nextBar();
    const frames = Math.round(((bar.beats * 60) / bar.bpm) * SR);
    const notes = barScore(bar, programs, weighted ? { legato: true, gestures: true, patches } : { patches }).map((n) => ({ ...n, t: n.t + start / SR }));
    const plans: PlannedNote[] | undefined =
      engine === "samples" ? notes.map((n) => ({ zones: [{ url: "x", rate: n.role === "drums" ? 1 : Math.pow(2, (n.key - 60) / 12), gain: 1, offset: 0 }], release: 0.08, sustain: false, drum: n.role === "drums" })) : undefined;
    send({
      type: "bar",
      engine,
      start,
      frames,
      styleId: style.id,
      newPiece: bar.info.barInPiece === 0,
      levels,
      ...(parts && { partLevels: parts }),
      notes,
      ...(plans && { plans }),
      ...(weighted && { mix: { intensity: bar.info.intensity, lean: velocityScale(bar.info.intensity, FLOOR) }, touch: true }),
      ...(sound && { sound }),
    });
    start += frames;
  }
  await new Promise<void>((resolve) => {
    cleared = resolve;
    send({ type: "clear", from: start });
  });
  const h = createHash("sha256");
  for (const msg of posted) {
    if (msg.type !== "pcm") continue;
    h.update(`${msg.start}/${msg.frames}/${msg.roles.join(",")}`);
    for (const d of msg.data) h.update(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
  }
  return h.digest("hex").slice(0, 16);
}

const GOLDEN: Record<string, string> = {
  "metroid/synth/plain": "a3160d572d4c2b97",
  "metroid/synth/weighted": "c0bbf2b48bda7ff3",
  "retro/synth/plain": "ec297bd175d62b0d",
  "retro/synth/weighted": "fc59088150791a97",
  "lofi/synth/plain": "99f3dd10b23fc8dd",
  "lofi/synth/weighted": "f2152d81eb7cc822",
  "jazz_trio/synth/plain": "1760c57e7d7c3212",
  "jazz_trio/synth/weighted": "9dc933ad6bc61d97",
  "minimalist/synth/plain": "468bc7ac0e7e57a4",
  "minimalist/synth/weighted": "892e63afc3cdcc03",
  "monkey_island/synth/plain": "c69afcafebad474d",
  "monkey_island/synth/weighted": "1357243ab6f16405",
  "electro_swing/synth/plain": "f1da00af9c973f6f",
  "electro_swing/synth/weighted": "f7958a83026ea6b9",
  "synthwave/synth/plain": "6b94bcd6d23f4ea2",
  "synthwave/synth/weighted": "1a12a153d66eea0b",
  "bossa_nova/synth/plain": "3fa0391eb3eaa921",
  "bossa_nova/synth/weighted": "fd0fdd504cffa1c5",
  "funk/synth/plain": "734325bff9997ebb",
  "funk/synth/weighted": "247e91bc0b4622f4",
  "western/synth/plain": "a3dc3101b1ddbf2b",
  "western/synth/weighted": "1707431c7304536d",
  "celtic/synth/plain": "56db59266ff7a707",
  "celtic/synth/weighted": "9131ba3967efb978",
  "musette/synth/plain": "59385e6231593b98",
  "musette/synth/weighted": "0d7491b428245222",
  "liquid_dnb/synth/plain": "685a585dc1bc7aa9",
  "liquid_dnb/synth/weighted": "71e16c0778cc136d",
  "castlevania/synth/plain": "11430bd55794bdc0",
  "castlevania/synth/weighted": "b4f6b4973c4e3246",
  "jrpg/synth/plain": "4a314f337c6976fb",
  "jrpg/synth/weighted": "e72430122075a393",
  "disco/synth/plain": "039a8982392bb617",
  "disco/synth/weighted": "69025988a8e3a287",
  "baroque/synth/plain": "86a4b7a38cbfd17c",
  "baroque/synth/weighted": "16aa65f91028e3e5",
  "orbital_glass/synth/plain": "78df966ce0de2249",
  "orbital_glass/synth/weighted": "750169ec437f2d28",
  "midnight_platform/synth/plain": "f99660e48ee5c9cb",
  "midnight_platform/synth/weighted": "9cabc1c119ee2496",
  "courtyard_nine/synth/plain": "61f852fd8b920b06",
  "courtyard_nine/synth/weighted": "bb5e60ebce9971ea",
  "low_log/synth/plain": "6f88391f21b97275",
  "low_log/synth/weighted": "e6c5b99cc42cc27e",
  "funk/samples/plain": "d2e69b20e40e2c4c",
  "funk/samples/weighted": "6ed0dd699a178fd3",
  "synthwave/samples/plain": "5cdd53ab8f2e625a",
  "synthwave/samples/weighted": "2860bddaf9c4cffd",
  "jazz_trio/samples/plain": "0f7a6ecc68f0f5b8",
  "jazz_trio/samples/weighted": "c53cab07872339a2",
};

test("the worker streams what it did for every shipped style, plain and weighted, synth and samples", async () => {
  const got: Record<string, string> = {};
  for (const style of styles) {
    got[`${style.id}/synth/plain`] = await run(style, "synth", false, 10);
    got[`${style.id}/synth/weighted`] = await run(style, "synth", true, 10);
  }
  for (const id of ["funk", "synthwave", "jazz_trio"]) {
    const style = styles.find((s) => s.id === id)!;
    got[`${id}/samples/plain`] = await run(style, "samples", false, 10);
    got[`${id}/samples/weighted`] = await run(style, "samples", true, 10);
  }
  if (process.env.PRINT_GOLDEN) console.log(JSON.stringify(got, null, 2));
  assert.deepEqual(got, GOLDEN);
});

// --- A style with parts ------------------------------------------------------

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const TECHNO = claudia.find((s) => s.id === "minimal_techno")!;
const SET: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: FLOOR } };

/** The same style as it was before it had parts: one part per role. */
function withoutParts(style: StyleBundle): StyleBundle {
  const { parts: _, arrangement: __, ...corpus } = style.corpus;
  const own = <T extends { material?: string | undefined }>(items: T[]) => items.filter((x) => x.material === undefined);
  return { ...style, corpus: { ...corpus, motifs: own(corpus.motifs), comping: own(corpus.comping), drums: own(corpus.drums) } };
}

/** What the last run posted, per role and summed. */
function heard(): { roles: Map<Role, Stereo>; mix: Stereo } {
  const pcm = posted.filter((m) => m.type === "pcm");
  const frames = pcm.reduce((a, m) => a + m.frames, 0);
  const roles = new Map<Role, Stereo>();
  const mix = stereo(frames);
  let at = 0;
  for (const m of pcm) {
    m.roles.forEach((r, i) => {
      const role = ROLES[r]!;
      const s = roles.get(role) ?? stereo(frames);
      roles.set(role, s);
      s.l.set(m.data[2 * i]!, at);
      s.r.set(m.data[2 * i + 1]!, at);
      for (let k = 0; k < m.frames; k++) {
        mix.l[at + k]! += m.data[2 * i]![k]!;
        mix.r[at + k]! += m.data[2 * i + 1]![k]!;
      }
    });
    at += m.frames;
  }
  return { roles, mix };
}
const rms = (s: Stereo, from = 0, to = s.l.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return Math.sqrt(e / (2 * Math.max(1, to - from)));
};
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

test("a style with parts streams one stem per role, whatever its parts, and the mix measures as techno", async () => {
  // A whole track of a set: the mix-in, a breakdown, a drop, the mix-out.
  const bars = 144;
  const c = new SetConductor([TECHNO], "worker-parts", SET);
  const seen = new Set<string>();
  const source = {
    nextBar() {
      const bar = c.nextBar();
      for (const id of bar.info.parts ?? []) seen.add(id);
      return bar;
    },
  };
  const t0 = performance.now();
  await run(TECHNO, "synth", true, bars, source);
  const withParts = (performance.now() - t0) / bars;
  const { roles, mix } = heard();
  assert.ok(seen.size >= 8, `parts played: ${[...seen]}`);
  // Fifteen parts, five roles: the worklet and the bus see roles only.
  assert.deepEqual([...roles.keys()].sort(), ["arp", "bass", "comp", "drums", "pad"].filter((r) => [...seen].some((id) => TECHNO.corpus.parts!.find((p) => p.id === id)!.role === r)).sort());
  for (const s of [mix, ...roles.values()]) for (let i = 0; i < s.l.length; i++) assert.ok(Number.isFinite(s.l[i]) && Number.isFinite(s.r[i]));

  // The same style without its parts block, as it played before: the comparison for level and for CPU.
  const plain = withoutParts(TECHNO);
  const t1 = performance.now();
  await run(plain, "synth", true, bars, new SetConductor([plain], "worker-parts", SET));
  const withoutThem = (performance.now() - t1) / bars;
  const before = heard();

  const barSeconds = mix.l.length / SR / bars;
  const body = (s: Stereo): Stereo => ({ l: s.l.slice(16 * Math.round(barSeconds * SR)), r: s.r.slice(16 * Math.round(barSeconds * SR)) });
  const m = measureWeight(body(mix), SR);
  const was = measureWeight(body(before.mix), SR);
  const line = (x: typeof m) => `rms ${db(x.rms).toFixed(1)} dB, crest ${x.crest.toFixed(1)} dB, range ${x.range.toFixed(1)} dB, sub ${(x.sub * 100).toFixed(0)}%, low-mid ${(x.lowMid * 100).toFixed(0)}%, low corr ${x.lowCorrelation.toFixed(2)}`;
  console.log(`minimal techno, one track through the worker (weighted mix, synth, ${SR} Hz):\n  with parts    ${line(m)}\n  without parts ${line(was)}`);
  // A role's level where it plays hardest: its loudest bar. (Over a whole track a role that plays less reads quieter, which says nothing about its level.)
  const frames = Math.round(barSeconds * SR);
  const loudest = (s: Stereo) => Math.max(...Array.from({ length: bars - 1 }, (_, b) => rms(s, b * frames, (b + 1) * frames)));
  console.log(`  loudest bar per role with parts: ${[...roles].map(([r, s]) => `${r} ${db(loudest(s)).toFixed(1)} dB`).join(", ")}`);
  console.log(`  loudest bar per role without:    ${[...before.roles].map(([r, s]) => `${r} ${db(loudest(s)).toFixed(1)} dB`).join(", ")}`);
  console.log(`render time per bar: ${withParts.toFixed(1)} ms with parts, ${withoutThem.toFixed(1)} ms without (a bar is ${(barSeconds * 1000).toFixed(0)} ms: ${(barSeconds * 1000 / withParts).toFixed(0)}x and ${(barSeconds * 1000 / withoutThem).toFixed(0)}x real time at ${SR} Hz)`);
  assert.ok(m.lowCorrelation > 0.95, `the low end is mono: ${m.lowCorrelation}`);
  assert.ok(m.sub > 0.2 && m.sub < 0.75, `sub share ${m.sub}`);
  // More parts are not a louder mix: within 3 dB of the style before parts, and each role's stem, at its loudest, within 6 dB of what it was.
  assert.ok(Math.abs(db(m.rms / was.rms)) < 3, `${db(m.rms / was.rms).toFixed(1)} dB against the style without parts`);
  for (const [role, s] of roles) {
    const old = before.roles.get(role);
    if (old) assert.ok(Math.abs(db(loudest(s) / loudest(old))) < 6, `${role}: ${db(loudest(s) / loudest(old)).toFixed(1)} dB`);
  }
  // Rendering stays far ahead of real time.
  assert.ok(withParts < barSeconds * 1000 / 4, `${withParts} ms per bar`);

  // The same at the hottest a set plays a track (lift 0.3), where the most parts are in.
  const hot = async (style: StyleBundle) => {
    const piece = new Piece(style, "worker-hot", 0, { ...SET, frame: "set", lift: 0.3 });
    let b = 0;
    let on = 0;
    let most = 0;
    const t = performance.now();
    await run(style, "synth", true, piece.totalBars, {
      nextBar() {
        const bar = piece.renderBar(b, b++);
        on += bar.info.parts?.length ?? 0;
        most = Math.max(most, bar.info.parts?.length ?? 0);
        return bar;
      },
    });
    return { ms: (performance.now() - t) / piece.totalBars, mean: on / piece.totalBars, most, bars: piece.totalBars };
  };
  const hotParts = await hot(TECHNO);
  const hotPlain = await hot(plain);
  console.log(`at lift 0.3: ${hotParts.ms.toFixed(1)} ms per bar with parts (${hotParts.mean.toFixed(1)} parts in on average, ${hotParts.most} at most, ${hotParts.bars} bars), ${hotPlain.ms.toFixed(1)} ms without`);
  assert.ok(hotParts.ms < barSeconds * 1000 / 4, `${hotParts.ms} ms per bar`);
});
