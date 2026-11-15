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
import { bandShare, measureWeight } from "./measure.js";
import { stemMoves } from "./moves.js";
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
    const moves = stemMoves(bar);
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
      ...(moves && { moves }),
    });
    start += frames;
  }
  await new Promise<void>((resolve) => {
    cleared = resolve;
    send({ type: "clear", from: start });
  });
  return fingerprint(posted);
}

/**
 * What the worker posted, as a hash of the bar layout (starts, lengths, roles) and the RMS of the stems in
 * eight stretches of the run. The levels are compared with a tolerance, not bit for bit: the last bits of a
 * float differ between CPUs, and nobody hears them.
 */
function fingerprint(msgs: ToStems[]): string {
  const h = createHash("sha256");
  const arrays: Float32Array[] = [];
  for (const msg of msgs) {
    if (msg.type !== "pcm") continue;
    h.update(`${msg.start}/${msg.frames}/${msg.roles.join(",")}`);
    for (const d of msg.data) arrays.push(new Float32Array(d.buffer, d.byteOffset, d.byteLength / 4));
  }
  const energy = new Array<number>(8).fill(0);
  const count = new Array<number>(8).fill(0);
  arrays.forEach((x, i) => {
    const k = Math.floor((i * 8) / arrays.length);
    for (let j = 0; j < x.length; j++) energy[k]! += x[j]! * x[j]!;
    count[k]! += x.length;
  });
  return `${h.digest("hex").slice(0, 16)}:${energy.map((e, k) => Math.sqrt(e / Math.max(1, count[k]!)).toFixed(4)).join(",")}`;
}

/** Equal but for rounding: the same layout, each level within a hair of the other. */
function assertClose(got: Record<string, string>, want: Record<string, string>): void {
  assert.deepEqual(Object.keys(got), Object.keys(want));
  for (const k of Object.keys(want)) {
    const [gh, gl] = got[k]!.split(":") as [string, string];
    const [wh, wl] = want[k]!.split(":") as [string, string];
    assert.equal(gh, wh, `${k}: the bars' layout changed`);
    const a = gl.split(",").map(Number);
    const b = wl.split(",").map(Number);
    a.forEach((v, i) => assert.ok(Math.abs(v - b[i]!) <= 5e-4, `${k}[${i}]: ${v} vs ${b[i]}`));
  }
}

const GOLDEN: Record<string, string> = {
  "metroid/synth/plain": "f0218e79181bcc45:0.0408,0.0303,0.0366,0.0285,0.0280,0.0256,0.0238,0.0249",
  "metroid/synth/weighted": "f0218e79181bcc45:0.0381,0.0395,0.0408,0.0377,0.0387,0.0387,0.0352,0.0339",
  "retro/synth/plain": "f9c826fdca8d44d5:0.0263,0.0280,0.0239,0.0239,0.0246,0.0253,0.0238,0.0236",
  "retro/synth/weighted": "f9c826fdca8d44d5:0.0378,0.0384,0.0392,0.0363,0.0359,0.0372,0.0350,0.0333",
  "lofi/synth/plain": "bdda59e7264eede5:0.0196,0.0155,0.0130,0.0132,0.0135,0.0137,0.0139,0.0144",
  "lofi/synth/weighted": "bdda59e7264eede5:0.0121,0.0116,0.0244,0.0231,0.0258,0.0255,0.0244,0.0245",
  "jazz_trio/synth/plain": "61cf36df163a2fc8:0.0178,0.0193,0.0198,0.0205,0.0200,0.0192,0.0205,0.0205",
  "jazz_trio/synth/weighted": "61cf36df163a2fc8:0.0213,0.0212,0.0289,0.0281,0.0279,0.0251,0.0265,0.0261",
  "minimalist/synth/plain": "11191221445e46d6:0.0062,0.0108,0.0198,0.0122,0.0132,0.0138,0.0144,0.0149",
  "minimalist/synth/weighted": "11191221445e46d6:0.0174,0.0183,0.0160,0.0162,0.0159,0.0153,0.0164,0.0161",
  "monkey_island/synth/plain": "a3a57c499d0cb0d7:0.0653,0.0218,0.0207,0.0205,0.0203,0.0240,0.0176,0.0173",
  "monkey_island/synth/weighted": "a3a57c499d0cb0d7:0.0262,0.0279,0.0288,0.0280,0.0277,0.0339,0.0248,0.0241",
  "electro_swing/synth/plain": "88be84a4cf9197f2:0.0195,0.0245,0.0225,0.0229,0.0303,0.0268,0.0215,0.0254",
  "electro_swing/synth/weighted": "88be84a4cf9197f2:0.0174,0.0288,0.0261,0.0247,0.0258,0.0279,0.0234,0.0290",
  "synthwave/synth/plain": "e9c35f15cd8886ad:0.0352,0.0270,0.0248,0.0261,0.0255,0.0248,0.0252,0.0264",
  "synthwave/synth/weighted": "e9c35f15cd8886ad:0.0415,0.0366,0.0333,0.0337,0.0334,0.0330,0.0338,0.0343",
  "bossa_nova/synth/plain": "032d5d7bd0315508:0.0086,0.0145,0.0135,0.0137,0.0157,0.0160,0.0137,0.0140",
  "bossa_nova/synth/weighted": "032d5d7bd0315508:0.0083,0.0144,0.0146,0.0151,0.0153,0.0162,0.0156,0.0165",
  "funk/synth/plain": "2788c9244636c767:0.0203,0.0229,0.0230,0.0188,0.0190,0.0209,0.0187,0.0180",
  "funk/synth/weighted": "2788c9244636c767:0.0361,0.0312,0.0311,0.0293,0.0278,0.0289,0.0284,0.0275",
  "western/synth/plain": "b9c314f3c3b4fd6c:0.0233,0.0193,0.0190,0.0181,0.0184,0.0177,0.0191,0.0177",
  "western/synth/weighted": "b9c314f3c3b4fd6c:0.0220,0.0229,0.0239,0.0219,0.0211,0.0215,0.0226,0.0216",
  "celtic/synth/plain": "b95eef369b2e798c:0.0265,0.0233,0.0221,0.0202,0.0219,0.0215,0.0241,0.0204",
  "celtic/synth/weighted": "b95eef369b2e798c:0.0225,0.0323,0.0281,0.0254,0.0290,0.0298,0.0291,0.0255",
  "musette/synth/plain": "1ab535055a7d2f36:0.0212,0.0131,0.0130,0.0122,0.0128,0.0113,0.0121,0.0120",
  "musette/synth/weighted": "1ab535055a7d2f36:0.0187,0.0206,0.0192,0.0183,0.0214,0.0199,0.0191,0.0189",
  "liquid_dnb/synth/plain": "96dca5d50db14bda:0.0195,0.0183,0.0207,0.0214,0.0194,0.0194,0.0221,0.0215",
  "liquid_dnb/synth/weighted": "96dca5d50db14bda:0.0281,0.0286,0.0335,0.0335,0.0277,0.0280,0.0334,0.0335",
  "castlevania/synth/plain": "40a6bbc5e9b35a8e:0.0147,0.0204,0.0201,0.0198,0.0187,0.0199,0.0207,0.0225",
  "castlevania/synth/weighted": "40a6bbc5e9b35a8e:0.0084,0.0179,0.0203,0.0203,0.0205,0.0205,0.0206,0.0223",
  "jrpg/synth/plain": "816bfa9d2e7f6b78:0.0119,0.0148,0.0166,0.0167,0.0185,0.0175,0.0187,0.0195",
  "jrpg/synth/weighted": "816bfa9d2e7f6b78:0.0173,0.0238,0.0268,0.0276,0.0264,0.0260,0.0278,0.0289",
  "disco/synth/plain": "9f13462b46754631:0.0300,0.0313,0.0299,0.0324,0.0290,0.0357,0.0218,0.0235",
  "disco/synth/weighted": "27abc59e1e5fa01a:0.0323,0.0317,0.0308,0.0302,0.0293,0.0391,0.0255,0.0282",
  "baroque/synth/plain": "cb9636ecdab403f0:0.0275,0.0231,0.0215,0.0218,0.0229,0.0222,0.0263,0.0198",
  "baroque/synth/weighted": "cb9636ecdab403f0:0.0193,0.0198,0.0185,0.0187,0.0195,0.0193,0.0182,0.0180",
  "orbital_glass/synth/plain": "4a7e6f8bdbc401d7:0.0144,0.0137,0.0159,0.0165,0.0161,0.0162,0.0153,0.0141",
  "orbital_glass/synth/weighted": "4a7e6f8bdbc401d7:0.0083,0.0139,0.0149,0.0143,0.0142,0.0146,0.0139,0.0121",
  "midnight_platform/synth/plain": "d71441ac24fcfdda:0.0160,0.0134,0.0245,0.0269,0.0204,0.0231,0.0192,0.0167",
  "midnight_platform/synth/weighted": "d71441ac24fcfdda:0.0224,0.0212,0.0357,0.0440,0.0377,0.0389,0.0309,0.0276",
  "courtyard_nine/synth/plain": "80687264020b8523:0.0144,0.0163,0.0142,0.0140,0.0132,0.0130,0.0142,0.0145",
  "courtyard_nine/synth/weighted": "80687264020b8523:0.0133,0.0148,0.0152,0.0154,0.0145,0.0140,0.0154,0.0163",
  "low_log/synth/plain": "e553dc9a2bbbfce1:0.0951,0.0154,0.0180,0.0223,0.0203,0.0201,0.0235,0.0230",
  "low_log/synth/weighted": "404cb506681c386b:0.0179,0.0174,0.0152,0.0225,0.0256,0.0262,0.0234,0.0237",
  "funk/samples/plain": "2788c9244636c767:0.0220,0.0205,0.0192,0.0205,0.0192,0.0187,0.0199,0.0195",
  "funk/samples/weighted": "2788c9244636c767:0.0315,0.0253,0.0251,0.0273,0.0251,0.0235,0.0248,0.0249",
  "synthwave/samples/plain": "e9c35f15cd8886ad:0.0310,0.0237,0.0228,0.0215,0.0223,0.0221,0.0230,0.0213",
  "synthwave/samples/weighted": "e9c35f15cd8886ad:0.0360,0.0361,0.0302,0.0271,0.0305,0.0303,0.0315,0.0269",
  "jazz_trio/samples/plain": "61cf36df163a2fc8:0.0178,0.0170,0.0195,0.0205,0.0198,0.0181,0.0205,0.0197",
  "jazz_trio/samples/weighted": "61cf36df163a2fc8:0.0162,0.0162,0.0240,0.0234,0.0226,0.0202,0.0224,0.0217",
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
  assertClose(got, GOLDEN);
});

// --- A style with parts ------------------------------------------------------

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const TECHNO = claudia.find((s) => s.id === "minimal_techno")!;
const SET: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: FLOOR } };

/** The same style as it was before it had parts: one part per role. */
function withoutParts(style: StyleBundle): StyleBundle {
  const { parts: _, arrangement: __, moves: ___, ...corpus } = style.corpus;
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
  const builds = new Set<number>();
  let at = 0;
  const source = {
    nextBar() {
      const bar = c.nextBar();
      if (bar.info.build) builds.add(at);
      at++;
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
  // (Outside builds: there the pad's stem carries the riser.)
  const loudest = (s: Stereo) => Math.max(...Array.from({ length: bars - 1 }, (_, b) => (builds.has(b) ? 0 : rms(s, b * frames, (b + 1) * frames))));
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

// --- Moves -------------------------------------------------------------------

test("moves through the worker: a build thins the low end and rises, the drop lands on an impact", async () => {
  const c = new SetConductor([TECHNO], "worker-moves", SET);
  const bars: Bar[] = [];
  const source = {
    nextBar() {
      const bar = c.nextBar();
      bars.push(bar);
      return bar;
    },
  };
  const n = 150;
  const first = await run(TECHNO, "synth", true, n, source);
  const { roles, mix } = heard();
  const frames = Math.round(((bars[0]!.beats * 60) / bars[0]!.bpm) * SR);
  const bar = (s: Stereo | undefined, b: number, from = 0, to = frames): Stereo => (s ? { l: s.l.slice(b * frames + from, b * frames + to), r: s.r.slice(b * frames + from, b * frames + to) } : stereo(to - from));
  const start = bars.findIndex((b) => b.info.build?.bar === 0);
  assert.ok(start > 0 && bars[start]!.info.pieceIndex === 0, "a build in the first track");
  const len = bars[start]!.info.build!.bars;
  const drop = start + len;
  assert.equal(bars[drop]!.info.turn, "drop");
  // Against the same bars without the high-pass and the riser: the high-pass takes the lows out of every stem
  // but the pad's (which carries the riser), and the riser is what the pad's stem gained.
  let i = 0;
  const plain = {
    nextBar(): Bar {
      const b = bars[i++]!;
      return { ...b, moves: b.moves?.filter((m) => !(m.scope === "master" && m.target === "lowCut") && m.target !== "riser") };
    },
  };
  await run(TECHNO, "synth", true, n, plain);
  const was = heard().roles;
  const sum = (rs: Map<Role, Stereo>, keep: (r: Role) => boolean) => {
    const out = stereo(mix.l.length);
    for (const [r, s] of rs) {
      if (!keep(r)) continue;
      for (let k = 0; k < s.l.length; k++) {
        out.l[k]! += s.l[k]!;
        out.r[k]! += s.r[k]!;
      }
    }
    return out;
  };
  const rest = sum(roles, (r) => r !== "pad");
  const open = sum(was, (r) => r !== "pad");
  const gained = sum(new Map([["pad", roles.get("pad")!], ["lead", { l: (was.get("pad") ?? stereo(mix.l.length)).l.map((x) => -x), r: (was.get("pad") ?? stereo(mix.l.length)).r.map((x) => -x) }]]), () => true);
  const low = (s: Stereo, b: number) => bandShare(bar(s, b), SR, 0, 150) * rms(bar(s, b)) ** 2;
  const cut = Array.from({ length: len }, (_, k) => db(Math.sqrt(low(rest, start + k) / low(open, start + k))));
  const riser = Array.from({ length: len }, (_, k) => rms(bar(gained, start + k)));
  const level = Array.from({ length: len + 1 }, (_, k) => db(rms(bar(mix, start - 1 + k))));
  console.log(`a ${len}-bar build at bar ${start}: below 150 Hz, per bar, ${cut.map((x) => x.toFixed(1)).join(" ")} dB against no high-pass; the mix ${level.map((x) => x.toFixed(1)).join(" ")} dB from the bar before; pad stem (the riser) ${riser.map((x) => db(x).toFixed(1)).join(" ")} dB`);
  assert.ok(cut[0]! > -1.5, "it starts open");
  for (let k = 1; k < len; k++) assert.ok(cut[k]! < cut[k - 1]! + 0.5, `and closes, bar ${k}`);
  assert.ok(cut.at(-1)! < -12, "by its last bar the lows are 12 dB down");
  assert.ok(riser.at(-1)! > riser[0]! * 4, "the riser climbs more than 12 dB");
  // The drop: the kick and an impact, heavy below 120 Hz.
  const hit = bar(roles.get("drums"), drop, 0, Math.round(0.3 * SR));
  const last = bar(roles.get("drums"), drop - 1, 0, Math.round(0.3 * SR));
  console.log(`the drop: drums ${db(rms(hit)).toFixed(1)} dB in its first 300 ms (${(bandShare(hit, SR, 0, 120) * 100).toFixed(0)}% below 120 Hz) against ${db(rms(last)).toFixed(1)} dB on the build's last downbeat`);
  assert.ok(rms(hit) > rms(last) * 2 && bandShare(hit, SR, 0, 120) > 0.5);
  for (let i = 0; i < mix.l.length; i++) assert.ok(Number.isFinite(mix.l[i]) && Math.abs(mix.l[i]!) < 4, `sample ${i}`);
  // (Two runs here cannot be compared by hash: the worker's levellers remember earlier runs. The bars' moves are
  // the same however they are reached (src/engine/moves.test.ts), and the runner holds nothing a bar did not state.)
  assert.ok(first.length > 0);
});
