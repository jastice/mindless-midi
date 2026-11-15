/**
 * Moves on the bar: builds before drops, sweeps, drift, stutters and throws
 * as minimal techno's tracks write them, and the same bars after a seek.
 * (What the worker does with them is in src/sound/moves.test.ts.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../corpus/schema.js";
import { Conductor } from "./conductor.js";
import { mixBars } from "./grid.js";
import { moveValue } from "./moves.js";
import { DEFAULT_PIECE_OPTIONS, Piece, type PieceOptions } from "./piece.js";
import { SetConductor } from "./set.js";
import { type Bar, type Move, OPEN_HIGH, OPEN_LOW } from "./types.js";

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };
const TECHNO = claudia.find((s) => s.id === "minimal_techno")!;
const SET: PieceOptions = { minSeconds: 180, maxSeconds: 360, frame: "set", expression: { gestures: true, velocityFloor: 0.42 } };
const SEEDS = Array.from({ length: 24 }, (_, i) => `moves-${i}`);
const LIFTS = [-0.3, 0, 0.3];

const track = (seed: string, lift = 0) => new Piece(TECHNO, seed, 0, { ...SET, lift });
const barsOf = (p: Piece): Bar[] => Array.from({ length: p.totalBars }, (_, b) => p.renderBar(b, b));
const find = (bar: Bar | undefined, target: Move["target"]) => bar?.moves?.filter((m) => m.target === target) ?? [];
const onsets = (bar: Bar, id: string) => bar.notes.filter((n) => n.part === id).map((n) => n.beat);

test("a build precedes every drop: kick out, a roll that doubles in rate, a rising high-pass and a riser, and an impact on the drop", () => {
  let builds = 0;
  const lengths = new Set<number>();
  for (const seed of SEEDS) {
    for (const lift of LIFTS) {
      const p = track(seed, lift);
      const bars = barsOf(p);
      const mix = mixBars(p.totalBars);
      bars.forEach((bar, b) => {
        const build = bar.info.build;
        if (bar.info.turn === "drop" && b - 4 >= mix && b < p.totalBars - mix) {
          // The bars before it are a build, counted up to the drop.
          const last = bars[b - 1]!.info.build;
          assert.ok(last && last.bar === last.bars - 1, `${seed} lift ${lift}: no build before the drop on bar ${b}`);
          for (let k = 0; k < last.bars; k++) assert.deepEqual(bars[b - last.bars + k]!.info.build, { bar: k, bars: last.bars });
          // The drop: kick back, roll out, an impact on the downbeat.
          assert.ok(bar.info.parts!.includes("kick") && !bar.info.parts!.includes("roll"));
          const impact = find(bar, "impact");
          assert.equal(impact.length, 1, `${seed}: impact on the drop at bar ${b}`);
          assert.equal(impact[0]!.at ?? 0, 0);
          assert.ok(impact[0]!.from > impact[0]!.to && impact[0]!.to < 60, "a thump falling into the sub");
        }
        if (!build) {
          assert.ok(!bar.info.parts!.includes("roll"), `${seed}: the roll outside a build on bar ${b}`);
          assert.equal(find(bar, "riser").length, 0);
          return;
        }
        if (build.bar === 0) {
          builds++;
          lengths.add(build.bars);
        }
        // Every build ends on a drop.
        if (build.bar === build.bars - 1) assert.equal(bars[b + 1]?.info.turn, "drop", `${seed}: a build ending on bar ${b} without a drop`);
        assert.ok(!bar.info.parts!.includes("kick"), `${seed}: the kick in a build on bar ${b}`);
        assert.ok(bar.info.parts!.includes("roll"));
        // The roll: a hit a beat, then twice as fast every quarter of the build, getting louder.
        const roll = bar.notes.filter((n) => n.part === "roll");
        assert.ok(roll.length > 0 && roll.every((n) => n.key === 38));
        const steps = onsets(bar, "roll").map((t, i, a) => (a[i + 1] ?? bar.beats) - t);
        for (let i = 0; i < steps.length; i++) {
          const x = (build.bar + onsets(bar, "roll")[i]! / bar.beats) / build.bars;
          assert.ok(Math.abs(steps[i]! - 1 / 2 ** Math.min(3, Math.floor(x * 4))) < 0.06, `${seed}: roll step ${steps[i]} at ${x.toFixed(2)} of the build`);
        }
        // A high-pass on everything and a riser, each bar starting where the last ended.
        const cut = find(bar, "lowCut").filter((m) => m.scope === "master");
        const riser = find(bar, "riser");
        assert.equal(cut.length, 1);
        assert.equal(riser.length, 1);
        if (build.bar === 0) assert.equal(cut[0]!.from, OPEN_LOW);
        else {
          assert.equal(cut[0]!.from, find(bars[b - 1], "lowCut").find((m) => m.scope === "master")!.to);
          assert.equal(riser[0]!.from, find(bars[b - 1], "riser")[0]!.to);
        }
        assert.ok(cut[0]!.to > cut[0]!.from && riser[0]!.to > riser[0]!.from, "both rise");
        assert.deepEqual(cut[0]!.span, { bar: build.bar, of: build.bars });
      });
    }
  }
  console.log(`builds: ${builds} over ${SEEDS.length * LIFTS.length} tracks, of ${[...lengths].sort()} bars`);
  assert.ok(builds > SEEDS.length * LIFTS.length, `${builds} builds`);
  assert.deepEqual([...lengths].sort(), [4, 8]);
});

test("the roll doubles in rate: quarters, eighths, sixteenths, thirty-seconds, one quarter of the build each", () => {
  const p = track("roll");
  const bars = barsOf(p);
  const start = bars.findIndex((b) => b.info.build?.bar === 0 && b.info.build.bars === 8);
  assert.ok(start >= 0, "an 8-bar build");
  const perBar = Array.from({ length: 8 }, (_, k) => onsets(bars[start + k]!, "roll").length);
  assert.deepEqual(perBar, [4, 4, 8, 8, 16, 16, 32, 32]);
  const vel = bars.slice(start, start + 8).flatMap((b) => b.notes.filter((n) => n.part === "roll").map((n) => n.vel));
  assert.ok(vel.at(-1)! > vel[0]! * 1.5, `the roll rises: ${vel[0]} to ${vel.at(-1)}`);
});

test("sweeps open a part as it enters and end open; drift ends where the patch has it; every move ends at a stated value", () => {
  let sweeps = 0;
  let drifts = 0;
  let stutters = 0;
  let throws = 0;
  let ends = 0;
  const cutoff = Object.fromEntries(TECHNO.corpus.patches!.map((x) => [x.id, x.filter.cutoff]));
  const patchOf = (id: string) => TECHNO.corpus.parts!.find((x) => x.id === id)!.patch!;
  for (const seed of SEEDS) {
    const bars = barsOf(track(seed));
    bars.forEach((bar, b) => {
      if (b % 8 === 7) ends++;
      for (const m of bar.moves ?? []) {
        assert.ok(Number.isFinite(m.from) && Number.isFinite(m.to) && m.beats > 0 && (m.at ?? 0) + m.beats <= bar.beats + 1e-9, JSON.stringify(m));
        // Part moves only while the part plays; the low end and the roll are never moved.
        if (m.scope !== "master" && m.scope.part !== undefined) {
          assert.ok(bar.info.parts!.includes(m.scope.part), `${seed}: a move on ${m.scope.part}, which is out, on bar ${b}`);
          assert.ok(!["kick", "sub", "roll"].includes(m.scope.part));
        }
        const span = m.span;
        const prev = span && span.bar > 0 ? bars[b - 1]!.moves?.find((x) => x.target === m.target && JSON.stringify(x.scope) === JSON.stringify(m.scope)) : undefined;
        if (span && span.bar > 0 && m.target !== "patch") assert.equal(m.from, prev!.to, `${seed}: ${m.target} carries on from where it was`);
        if (m.target === "highCut" || m.target === "lowCut") {
          if (m.scope === "master") continue;
          const open = m.target === "highCut" ? OPEN_HIGH : OPEN_LOW;
          if (span!.bar === 0) {
            sweeps++;
            assert.ok(!bars[b - 1]!.info.parts!.includes((m.scope as { part: string }).part), "a sweep starts as its part enters");
          }
          if (span!.bar === span!.of - 1) assert.equal(m.to, open, "and ends open");
          assert.ok(span!.of === 8 || span!.of === 16);
        }
        if (m.target === "patch") {
          assert.equal(m.param, "cutoff");
          const base = cutoff[patchOf((m.scope as { part: string }).part)]!;
          if (span!.bar === 0) {
            drifts++;
            assert.equal(m.from, base);
          }
          if (span!.bar === span!.of - 1) assert.equal(m.to, base, "a drift comes back to the patch's cutoff");
          assert.ok(m.from / base < 2.6 && base / m.from < 2.6);
        }
        if (m.target === "stutter") {
          stutters++;
          assert.equal(b % 8, 7, "a stutter ends a phrase");
          assert.ok(m.from > 0 && m.from <= m.beats / 2);
        }
        if (m.target === "delaySend") {
          throws++;
          assert.equal(bars[b + 1]!.info.turn, "break", "a throw is the last beat before a break");
        }
      }
    });
  }
  console.log(`over ${SEEDS.length} tracks: ${sweeps} sweeps, ${drifts} drifts, ${stutters} stutters at ${ends} phrase ends, ${throws} throws`);
  assert.ok(sweeps > SEEDS.length && drifts > SEEDS.length / 2 && throws > 0);
  assert.ok(stutters > 0 && stutters < ends * 0.1, "stutters are rare");
});

test("a move's value: held before it starts and after it ends, in octaves for Hz, straight for the rest", () => {
  const m: Move = { scope: "master", target: "lowCut", from: 100, to: 400, at: 1, beats: 2 };
  assert.equal(moveValue(m, 0), 100);
  assert.equal(moveValue(m, 1), 100);
  assert.ok(Math.abs(moveValue(m, 2) - 200) < 1e-9, "half way is one octave of two");
  assert.equal(moveValue(m, 3), 400);
  assert.equal(moveValue(m, 4), 400);
  const g: Move = { scope: "master", target: "gain", from: 1, to: 0, beats: 4 };
  assert.equal(moveValue(g, 2), 0.5);
  assert.ok(Math.abs(moveValue({ ...g, curve: "ease" }, 1) - 0.84375) < 1e-12);
});

test("moves are deterministic and the same after a seek, through the set conductor", () => {
  const key = (b: Bar) => JSON.stringify([b.notes, b.info, b.moves]);
  assert.deepEqual(barsOf(track("same")).map(key), barsOf(track("same")).map(key));
  // A bar reached directly has the moves playing to it gives.
  const p = track("same");
  const all = barsOf(track("same"));
  for (const b of [90, 7, 140, 60, 61, 62, 63]) assert.deepEqual(p.renderBar(b, b).moves, all[b]!.moves);
  const run = Array.from({ length: 1500 }, ((c) => () => c.nextBar())(new SetConductor([TECHNO], "seek-moves")));
  assert.ok(run.some((b) => b.info.build) && run.some((b) => b.moves?.length));
  for (const [t, bar] of [[1, 0], [2, 61], [3, 7], [4, 100]] as const) {
    const at = run.findIndex((b) => b.info.pieceIndex === t && b.info.barInPiece === bar);
    assert.ok(at >= 0);
    const c = new SetConductor([TECHNO], "seek-moves");
    c.seek(t, bar);
    for (let j = 0; j < 64; j++) assert.equal(key(c.nextBar()), key(run[at + j]!), `track ${t} bar ${bar} + ${j}`);
  }
});

test("a style without moves has none: no moves, no builds, on any bar", () => {
  for (const style of styles) {
    const c = new Conductor([style], `none-${style.id}`, DEFAULT_PIECE_OPTIONS);
    for (let i = 0; i < 200; i++) {
      const bar = c.nextBar();
      assert.equal(bar.moves, undefined);
      assert.equal(bar.info.build, undefined);
    }
  }
  // Minimal techno without its `moves` block: no builds, and the roll never plays.
  const { moves: _, ...corpus } = TECHNO.corpus;
  const still = new Piece({ ...TECHNO, corpus }, "still", 0, SET);
  for (const bar of barsOf(still)) {
    assert.equal(bar.moves, undefined);
    assert.equal(bar.info.build, undefined);
    assert.ok(!bar.info.parts!.includes("roll"));
  }
});
