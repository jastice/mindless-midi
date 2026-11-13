import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Role, StyleBundle } from "../corpus/schema.js";
import { keysCompatible } from "../theory/theory.js";
import type { PieceOptions } from "./piece.js";
import { MAX_TEMPO_STEP, MIX_BARS, PHRASE_BARS, SetConductor, mixLeaveOut } from "./set.js";
import type { Bar } from "./types.js";

const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };
const byId = (id: string) => styles.find((s) => s.id === id)!;

// No techno corpus yet: 4/4 styles stand in. Electro swing brings harmonic minor, which few keys of the others neighbour.
const POOL = ["synthwave", "disco", "funk", "electro_swing", "retro"].map(byId);
const SHORT: PieceOptions = { minSeconds: 60, maxSeconds: 150 };

function take(c: SetConductor, n: number): Bar[] {
  return Array.from({ length: n }, () => c.nextBar());
}

const key = (b: Bar) => JSON.stringify([b.beats, b.bpm, b.notes, b.info]);

test("tempo and key carry across every transition, and every cut is on a phrase", () => {
  for (const seed of ["one", "two", "three"]) {
    const bars = take(new SetConductor(POOL, `set-${seed}`, SHORT), 4000);
    let transitions = 0;
    let moves = 0;
    bars.forEach((bar, i) => {
      assert.equal(bar.beats, 4);
      const before = bars[i - 1];
      if (!before || before.info.pieceIndex === bar.info.pieceIndex) {
        if (before) assert.equal(bar.info.barInPiece, before.info.barInPiece + 1);
        return;
      }
      transitions++;
      if (before.bpm !== bar.bpm) moves++;
      assert.equal(bar.info.pieceIndex, before.info.pieceIndex + 1);
      assert.equal(bar.info.barInPiece, 0);
      assert.equal(before.info.barInPiece, before.info.pieceBars - 1, "the track before played to its last bar");
      assert.equal(before.info.pieceBars % PHRASE_BARS, 0);
      assert.equal(i % PHRASE_BARS, 0, `track ${bar.info.pieceIndex} starts on bar ${i}`);
      assert.ok(Math.abs(bar.bpm - before.bpm) <= before.bpm * MAX_TEMPO_STEP + 1e-9, `${before.bpm} -> ${bar.bpm} bpm`);
      assert.ok(keysCompatible(before.info, bar.info), `${before.info.keyName} -> ${bar.info.keyName}`);
    });
    assert.ok(transitions >= 15, `${transitions} transitions`);
    assert.ok(moves > 0, "the tempo moves");
    // No ending, no gap; a track keeps its tempo and key throughout.
    for (const bar of bars) {
      assert.equal(bar.info.gap, false);
      assert.notEqual(bar.info.section, "ending");
    }
    const first = new Map<number, Bar>();
    for (const bar of bars) {
      const f = first.get(bar.info.pieceIndex) ?? (first.set(bar.info.pieceIndex, bar), bar);
      assert.equal(bar.bpm, f.bpm);
      assert.equal(bar.info.tonic, f.info.tonic);
      assert.equal(bar.info.mode, f.info.mode);
    }
  }
});

test("a style with no key near the last one moves one of its modes to a tonic that is", () => {
  const swing = byId("electro_swing");
  const far = { ...swing, corpus: { ...swing.corpus, keys: [{ tonic: "Eb" as const, mode: "harmonicMinor" }] } };
  let moved = 0;
  for (const seed of ["x", "y", "z", "w"]) {
    const c = new SetConductor([byId("synthwave")], `move-${seed}`, SHORT);
    const last = take(c, 400).at(-1)!;
    c.setStyles([far]);
    c.skip();
    const next = c.nextBar();
    assert.equal(next.info.styleId, "electro_swing");
    assert.equal(next.info.mode, "harmonicMinor");
    assert.ok(keysCompatible(last.info, next.info), `${last.info.keyName} -> ${next.info.keyName}`);
    if (next.info.tonic !== 3) moved++;
  }
  assert.ok(moved > 0, "Eb harmonic minor was too far, and moved");
});

test("same seed and pool, same set; another seed, another set", () => {
  const a = take(new SetConductor(POOL, "det", SHORT), 600).map(key);
  const b = take(new SetConductor(POOL, "det", SHORT), 600).map(key);
  const c = take(new SetConductor(POOL, "other", SHORT), 600).map(key);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("seeking to a track and bar gives the bars playing through gives", () => {
  const run = take(new SetConductor(POOL, "seek", SHORT), 3000);
  for (const [track, bar] of [[0, 0], [0, 9], [1, 0], [3, 17], [6, 40], [9, 3]] as const) {
    const at = run.findIndex((b) => b.info.pieceIndex === track && b.info.barInPiece === bar);
    assert.ok(at >= 0, `track ${track} bar ${bar} reached`);
    const c = new SetConductor(POOL, "seek", SHORT);
    const landing = c.seek(track, bar);
    assert.deepEqual([landing.piece, landing.bar], [track, bar]);
    const resumed = take(c, 200);
    resumed.forEach((b, j) => assert.equal(key(b), key(run[at + j]!), `track ${track} bar ${bar} + ${j}`));
    const setup = run.slice(at - bar, at + 1).flatMap((b) => b.controls.map((x) => ({ ...x, beat: 0 })));
    assert.deepEqual(resumed[0]!.controls, setup);
  }
  const c = new SetConductor(POOL, "seek", SHORT);
  const landing = c.seekSegment(2, 1);
  const bar = c.nextBar();
  assert.equal(bar.info.pieceIndex, 2);
  assert.equal(bar.info.sectionIndex, 1);
  assert.equal(bar.info.barInSection, 0);
  assert.equal(key(bar), key(run.find((b) => b.info.pieceIndex === 2 && b.info.barInPiece === landing.bar)!));
  const layout = c.layout(2)!;
  assert.equal(layout.length, bar.info.sectionCount, "no ending segment");
  assert.equal(layout.at(-1)!.start + layout.at(-1)!.bars, bar.info.pieceBars);
  assert.equal(c.layout(50), null);
});

test("a track mixes in drums first, then bass, then the rest, and out in reverse", () => {
  let checked = 0;
  for (const seed of ["m1", "m2", "m3"]) {
    const c = new SetConductor(POOL, `mix-${seed}`, SHORT);
    for (let i = 0; i < 3000; i++) {
      const bar = c.nextBar();
      const piece = c.currentPiece!;
      const b = bar.info.barInPiece;
      const out = mixLeaveOut(piece, b);
      for (const n of bar.notes) assert.ok(!out?.has(n.role), `${n.role} in bar ${b} of ${bar.info.pieceBars}`);
      const edge = Math.min(b, piece.totalBars - 1 - b);
      if (edge >= MIX_BARS) assert.equal(out, undefined, `bar ${b} of ${piece.totalBars} plays everything`);
      else if (piece.sectionAt(b)!.roles.includes("drums")) {
        const allowed: Role[] = edge < MIX_BARS / 2 ? ["drums"] : ["drums", "bass"];
        assert.deepEqual([...out!].sort(), (["lead", "counter", "arp", "pad", "comp", "bass", "drums"] as Role[]).filter((r) => !allowed.includes(r)).sort());
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `${checked} mix bars with drums checked`);

  // Disco mostly opens on drums and bass: the first phrase is drums alone, the second adds the bass,
  // and the last phrase goes back to drums alone (unless the outro has none, when it plays as written).
  const c = new SetConductor([byId("disco")], "disco-mix", SHORT);
  const heard = new Map<string, Set<Role>>();
  for (let i = 0; i < 1500; i++) {
    const bar = c.nextBar();
    const piece = c.currentPiece!;
    const b = bar.info.barInPiece;
    const edge = Math.min(b, piece.totalBars - 1 - b);
    const stage = edge < MIX_BARS / 2 ? (b < MIX_BARS ? "first" : "last") : edge < MIX_BARS ? "second" : "middle";
    const roles = bar.notes.map((n) => n.role);
    if (piece.sectionAt(b)!.roles.includes("drums")) {
      const allowed: Role[] = stage === "middle" ? roles : stage === "second" ? ["drums", "bass"] : ["drums"];
      for (const r of roles) assert.ok(allowed.includes(r), `${r} in the ${stage} phrase, bar ${b}`);
    }
    const set = heard.get(stage) ?? new Set();
    for (const r of roles) set.add(r);
    heard.set(stage, set);
  }
  assert.ok(heard.get("first")!.has("drums"));
  assert.ok(heard.get("second")!.has("bass"));
  assert.ok(heard.get("last")!.has("drums"));
  assert.ok(heard.get("middle")!.size > 3, `the middle plays more: ${[...heard.get("middle")!]}`);
});

test("only 4/4 styles play in a set", () => {
  assert.throws(() => new SetConductor([byId("musette")], "waltz"));
  const c = new SetConductor([byId("musette"), byId("disco")], "mixed", SHORT);
  for (const bar of take(c, 300)) assert.equal(bar.info.styleId, "disco");
});
