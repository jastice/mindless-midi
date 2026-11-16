/**
 * Two decks through the render worker, as the player sends a set's slices:
 * the dominant deck's bar, with the other deck's beside it. What it asserts
 * is the plan's: during a transition the low end (below 150 Hz) is one deck's,
 * the bass swap makes no step, and two decks do not clip. Nobody has listened
 * to any of it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROLES, type Role } from "../corpus/constants.js";
import type { StyleBundle } from "../corpus/schema.js";
import { velocityScale } from "../engine/parts.js";
import type { PieceOptions } from "../engine/piece.js";
import { SetConductor, type Slice } from "../engine/set.js";
import type { Bar, TransitionType } from "../engine/types.js";
import { type Stereo, stereo } from "./dsp.js";
import { bandShare } from "./measure.js";
import { stemMoves } from "./moves.js";
import type { DeckBar, ToStems, ToWorker } from "./protocol.js";
import { barScore } from "./score.js";
import { partLevels, styleSound } from "./sound_set.js";
import type { ScoreNote } from "./types.js";

const SR = 24000;
const FLOOR = 0.42;
const SET: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: FLOOR } };
const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const byId = new Map(claudia.map((s) => [s.id, s]));

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

/** One deck's bar as the player sends it. */
function deckBar(bar: Bar, notes: ScoreNote[]): DeckBar {
  const style = byId.get(bar.info.styleId)!;
  const parts = partLevels(style.corpus);
  const sound = styleSound(style.corpus);
  const moves = stemMoves(bar);
  return {
    styleId: style.id,
    newPiece: bar.info.barInPiece === 0,
    levels: Object.fromEntries(style.corpus.instruments.map((i) => [i.role, i.volume])) as Partial<Record<Role, number>>,
    ...(parts && { partLevels: parts }),
    notes,
    mix: { intensity: bar.info.intensity, lean: velocityScale(bar.info.intensity, FLOOR) },
    touch: true,
    ...(sound && { sound }),
    ...(moves && { moves }),
    deck: bar.deck!,
  };
}

interface Heard {
  /** Per deck, the sum of its role stems. */
  decks: [Stereo, Stereo];
  mix: Stereo;
  frames: number[];
  ms: number[];
}

/** Slices `from` to `to` of a set through the worker. Every slice from the first is scored, so each deck's sounds are set up. */
async function play(slices: Slice[], from: number, to: number): Promise<Heard> {
  posted = [];
  const programs = [new Map<number, number>(), new Map<number, number>()];
  const patches = [new Map<number | string, string>(), new Map<number | string, string>()];
  const score = (bar: Bar, start: number) => barScore(bar, programs[bar.deck!]!, { legato: true, gestures: true, patches: patches[bar.deck!]! }).map((n) => ({ ...n, t: n.t + start / SR }));
  let start = 0;
  const ms: number[] = [];
  const frames: number[] = [];
  for (let i = 0; i < to; i++) {
    const s = slices[i]!;
    const own = s.decks.find((d) => d.deck === s.dominant)!.bar;
    const other = s.decks.find((d) => d.deck !== s.dominant)?.bar;
    const n = Math.round(((own.beats * 60) / own.bpm) * SR);
    const a = score(own, start);
    const b = other && score(other, start);
    if (i >= from) {
      const t = performance.now();
      send({ type: "bar", engine: "synth", start, frames: n, ...deckBar(own, a), ...(other && { with: deckBar(other, b!) }) });
      // (The worker renders on a promise chain with nothing to wait for: by the next turn of the loop the bar is done.)
      await new Promise((r) => setImmediate(r));
      ms.push(performance.now() - t);
      frames.push(n);
      start += n;
    }
  }
  await new Promise<void>((resolve) => {
    cleared = resolve;
    send({ type: "clear", from: start });
  });
  const total = frames.reduce((x, y) => x + y, 0);
  const decks: [Stereo, Stereo] = [stereo(total), stereo(total)];
  const mix = stereo(total);
  let at = 0;
  for (const m of posted) {
    if (m.type !== "pcm") continue;
    m.roles.forEach((r, k) => {
      const d = decks[Math.floor(r / ROLES.length)]!;
      for (let j = 0; j < m.frames; j++) {
        const l = m.data[2 * k]![j]!;
        const rr = m.data[2 * k + 1]![j]!;
        d.l[at + j]! += l;
        d.r[at + j]! += rr;
        mix.l[at + j]! += l;
        mix.r[at + j]! += rr;
      }
    });
    at += m.frames;
  }
  return { decks, mix, frames, ms };
}

const cut = (s: Stereo, a: number, b: number): Stereo => ({ l: s.l.slice(a, b), r: s.r.slice(a, b) });
const power = (s: Stereo) => {
  let e = 0;
  for (let i = 0; i < s.l.length; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return e / (2 * Math.max(1, s.l.length));
};
/** Power below 150 Hz. */
const low = (s: Stereo) => bandShare(s, SR, 0, 150) * power(s);
const db = (x: number) => 10 * Math.log10(Math.max(x, 1e-20));
const peak = (s: Stereo) => s.l.reduce((m, x, i) => Math.max(m, Math.abs(x), Math.abs(s.r[i]!)), 0);

/** The first transition of each type in sets over Claudia's pool, with the slices up to its end and a little after. */
function transitions(): Map<TransitionType, { seed: string; slices: Slice[]; start: number; bars: number; swap: number }> {
  const found = new Map<TransitionType, { seed: string; slices: Slice[]; start: number; bars: number; swap: number }>();
  for (let k = 0; found.size < 4 && k < 60; k++) {
    const seed = `decks-${k}`;
    const c = new SetConductor(claudia, seed, SET);
    const slices: Slice[] = [];
    for (let i = 0; i < 1200; i++) {
      const s = c.nextSlice();
      slices.push(s);
      const t = s.transition;
      if (!t || t.bar !== 0 || found.has(t.type)) continue;
      // Its whole length and four bars after.
      const plan = c.transitionPlan(t.from)!;
      for (let j = 0; j < t.bars + 4; j++) slices.push(c.nextSlice());
      found.set(t.type, { seed, slices, start: i, bars: t.type === "cut" ? t.bars : plan.bars, swap: plan.swap });
      break;
    }
  }
  return found;
}

test("two decks through the worker: one low end in a transition, a swap without a step, no clipping", async () => {
  const found = transitions();
  assert.deepEqual([...found.keys()].sort(), ["blend", "breakdown", "cut", "filter"]);
  const one: number[] = [];
  const two: number[] = [];
  for (const [type, { seed, slices, start, bars, swap }] of found) {
    // From 16 bars before (the levellers settle) to 4 after.
    const from = Math.max(0, start - 16);
    const heard = await play(slices, from, slices.length);
    const offset = (i: number) => heard.frames.slice(0, i - from).reduce((x, y) => x + y, 0);
    const barOf = (s: Stereo, i: number) => cut(s, offset(i), offset(i + 1));
    slices.slice(from).forEach((s, k) => (s.decks.length === 2 ? two : one).push(heard.ms[k]!));
    // A single deck: the eight bars before the transition, where one track plays alone (a cut: before its ramp).
    const before = start;
    const single = Array.from({ length: 8 }, (_, k) => low(barOf(heard.mix, before - 8 + k)));
    const ref = single.reduce((x, y) => x + y, 0) / single.length;
    const lines: string[] = [];
    if (type !== "cut") {
      // Bar by bar: what the deck without the low end adds below 150 Hz, against the dominant deck alone.
      const added: number[] = [];
      for (let k = 0; k < bars; k++) {
        const i = start + k;
        const s = slices[i]!;
        assert.equal(s.decks.length, 2, `${type} bar ${k} has two decks`);
        const dom = barOf(heard.decks[s.dominant], i);
        const sum = barOf(heard.mix, i);
        // The bar the low end changes hands in, last half beat: compare its first three and a half beats.
        const n = dom.l.length;
        const body = k === swap - 1 ? (x: Stereo) => cut(x, 0, Math.round((n * 3.5) / 4)) : (x: Stereo) => x;
        // (Where neither deck has a low end, a breakdown's second phrase, against a hundredth of the track's.)
        added.push(db(low(body(sum)) / Math.max(low(body(dom)), ref / 100)));
      }
      const levels = Array.from({ length: bars }, (_, k) => db(low(barOf(heard.mix, start + k)) / ref));
      lines.push(`  the other deck adds below 150 Hz, per bar: ${added.map((x) => x.toFixed(2)).join(" ")} dB`);
      lines.push(`  below 150 Hz against the 8 bars before, per bar: ${levels.map((x) => x.toFixed(1)).join(" ")} dB`);
      for (const [k, x] of added.entries()) assert.ok(x < 1, `${type} bar ${k}: the other deck adds ${x.toFixed(2)} dB below 150 Hz`);
    }
    // The swap (and a cut's change of tracks): the low end beat by beat across it, against beat-to-beat changes before.
    const at = type === "cut" ? start + bars : start + swap;
    const beat = (i: number, b: number) => {
      const s = barOf(heard.mix, i);
      const q = s.l.length / 4;
      return db(low(cut(s, Math.round(b * q), Math.round((b + 1) * q))));
    };
    // (A cut is a change of track on purpose: shown over two bars.)
    const across = [beat(at - 1, 2), beat(at - 1, 3), ...Array.from({ length: type === "cut" ? 8 : 2 }, (_, b) => beat(at + Math.floor(b / 4), b % 4))];
    const steps = across.slice(1).map((x, k) => Math.abs(x - across[k]!));
    const usual = Math.max(...Array.from({ length: 12 }, (_, k) => Math.abs(beat(before - 4 + Math.floor((k + 1) / 4), (k + 1) % 4) - beat(before - 4 + Math.floor(k / 4), k % 4))));
    lines.push(`  below 150 Hz beat by beat across the ${type === "cut" ? "cut" : "swap"}: ${across.map((x) => x.toFixed(1)).join(" ")} dB (steps up to ${Math.max(...steps).toFixed(1)} dB; before it, up to ${usual.toFixed(1)} dB)`);
    // Clipping: the stems' sum before the bus, against the track alone.
    const top = peak(cut(heard.mix, offset(start), offset(slices.length)));
    const alone = peak(cut(heard.mix, offset(before - 8), offset(before)));
    lines.push(`  peak ${top.toFixed(2)} in the transition, ${alone.toFixed(2)} in the 8 bars before`);
    console.log(`${type} (${seed}, slice ${start}, ${bars} bars${type === "cut" ? "" : `, swap at ${swap}`}):\n${lines.join("\n")}`);
    for (const s of [heard.mix, ...heard.decks]) for (let i = 0; i < s.l.length; i++) assert.ok(Number.isFinite(s.l[i]) && Number.isFinite(s.r[i]));
    // (A breakdown drops the low end at its swap on purpose.)
    if (type === "blend" || type === "filter") assert.ok(Math.max(...steps) < usual + 3, `${type}: the low end steps ${Math.max(...steps).toFixed(1)} dB across the swap`);
    // (Where a transition lands on an impact, that is the peak: about -12 dBFS, as on a drop.)
    assert.ok(top < 0.5, `${type}: peak ${top} against ${alone}`);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`render time per bar at ${SR} Hz: ${mean(one).toFixed(0)} ms with one deck, ${mean(two).toFixed(0)} ms with two (${one.length} and ${two.length} bars)`);
});
