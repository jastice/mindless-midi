import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Role, StyleBundle } from "../corpus/schema.js";
import { keysCompatible } from "../theory/theory.js";
import type { PieceOptions } from "./piece.js";
import { MAX_LIFT, MAX_TEMPO_STEP, MIX_BARS, PHRASE_BARS, SetConductor, WARMUP_SECONDS, mixBars, mixLeaveOut } from "./set.js";
import type { Bar } from "./types.js";

const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };
const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const byId = (id: string) => [...claudia, ...styles].find((s) => s.id === id)!;

// Claudia's own pack, which is one style so far.
const TECHNO = [byId("minimal_techno")];
// Several 4/4 styles with spread tempos, for choosing between styles. Electro swing brings harmonic minor, which few keys of the others neighbour.
const POOL = ["synthwave", "disco", "funk", "electro_swing", "retro"].map(byId);
const SHORT: PieceOptions = { minSeconds: 60, maxSeconds: 150 };

function take(c: SetConductor, n: number): Bar[] {
  return Array.from({ length: n }, () => c.nextBar());
}

const key = (b: Bar) => JSON.stringify([b.beats, b.bpm, b.notes, b.info]);

test("tempo and key carry across every transition, and every cut is on a phrase", () => {
  for (const [seed, pool] of [["one", TECHNO], ["two", TECHNO], ["three", POOL], ["four", POOL]] as const) {
    const bars = take(new SetConductor(pool, `set-${seed}`, SHORT), 4000);
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
  const a = take(new SetConductor(TECHNO, "det", SHORT), 600).map(key);
  const b = take(new SetConductor(TECHNO, "det", SHORT), 600).map(key);
  const c = take(new SetConductor(TECHNO, "other", SHORT), 600).map(key);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("seeking to a track and bar gives the bars playing through gives", () => {
  const run = take(new SetConductor(TECHNO, "seek", SHORT), 3000);
  for (const [track, bar] of [[0, 0], [0, 9], [1, 0], [3, 17], [6, 40], [9, 3]] as const) {
    const at = run.findIndex((b) => b.info.pieceIndex === track && b.info.barInPiece === bar);
    assert.ok(at >= 0, `track ${track} bar ${bar} reached`);
    const c = new SetConductor(TECHNO, "seek", SHORT);
    const landing = c.seek(track, bar);
    assert.deepEqual([landing.piece, landing.bar], [track, bar]);
    const resumed = take(c, 200);
    resumed.forEach((b, j) => assert.equal(key(b), key(run[at + j]!), `track ${track} bar ${bar} + ${j}`));
    const setup = run.slice(at - bar, at + 1).flatMap((b) => b.controls.map((x) => ({ ...x, beat: 0 })));
    assert.deepEqual(resumed[0]!.controls, setup);
  }
  const c = new SetConductor(TECHNO, "seek", SHORT);
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
  for (const [seed, pool] of [["m1", TECHNO], ["m2", TECHNO], ["m3", POOL]] as const) {
    const c = new SetConductor(pool, `mix-${seed}`, SHORT);
    for (let i = 0; i < 3000; i++) {
      const bar = c.nextBar();
      const piece = c.currentPiece!;
      const b = bar.info.barInPiece;
      const out = mixLeaveOut(piece, b);
      for (const n of bar.notes) assert.ok(!out?.has(n.role), `${n.role} in bar ${b} of ${bar.info.pieceBars}`);
      const edge = Math.min(b, piece.totalBars - 1 - b);
      const mix = mixBars(piece.totalBars);
      if (edge >= mix) assert.equal(out, undefined, `bar ${b} of ${piece.totalBars} plays everything`);
      else if (piece.sectionAt(b)!.roles.includes("drums")) {
        const allowed: Role[] = edge < mix / 2 ? ["drums"] : ["drums", "bass"];
        assert.deepEqual([...out!].sort(), (["lead", "counter", "arp", "pad", "comp", "bass", "drums"] as Role[]).filter((r) => !allowed.includes(r)).sort());
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `${checked} mix bars with drums checked`);

  // Disco (on tracks long enough for the full mix) mostly opens on drums and bass: the first phrase is drums alone, the second adds the bass,
  // and the last phrase goes back to drums alone (unless the outro has none, when it plays as written).
  const c = new SetConductor([byId("disco")], "disco-mix", { minSeconds: 100, maxSeconds: 150 });
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

test("a short track mixes in and out over fewer bars, so its ends never overlap", () => {
  assert.equal(mixBars(400), MIX_BARS);
  assert.equal(mixBars(40), 16);
  assert.equal(mixBars(32), 8);
  assert.equal(mixBars(24), 8);
  assert.equal(mixBars(16), 0);
  for (let total = 8; total <= 64; total += PHRASE_BARS) {
    const mix = mixBars(total);
    assert.ok(2 * mix + PHRASE_BARS <= total || mix === 0, `${total} bars mix over ${mix}`);
  }
  // Short tracks in a set: no bar is both mixing in and mixing out. (Minimal techno's forms are
  // never shorter than 112 bars; synthwave's can be 32.)
  const c = new SetConductor([byId("synthwave")], "tiny", { minSeconds: 20, maxSeconds: 40 });
  const shortened = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const bar = c.nextBar();
    const piece = c.currentPiece!;
    const b = bar.info.barInPiece;
    const mix = mixBars(piece.totalBars);
    assert.ok(!(b < mix && piece.totalBars - 1 - b < mix), `bar ${b} of ${piece.totalBars}`);
    if (mix < MIX_BARS) shortened.add(piece.index);
  }
  assert.ok(shortened.size > 0, "some tracks mixed over fewer bars");
});

/** The plans of every track a set of `bars` bars started. */
function plans(c: SetConductor, bars: number) {
  const seen = new Set<number>();
  for (const bar of take(c, bars)) seen.add(bar.info.pieceIndex);
  return [...seen].map((i) => c.trackPlan(i)!);
}

test("the set heads for each leg's tempo, a step at a time", () => {
  for (const [seed, pool] of [["t1", TECHNO], ["t2", TECHNO], ["t3", POOL], ["t4", POOL], ["t5", POOL]] as const) {
    const ps = plans(new SetConductor(pool, `travel-${seed}`, SHORT), 4000);
    const lo = Math.min(...pool.map((s) => s.corpus.tempo.min));
    const hi = Math.max(...pool.map((s) => s.corpus.tempo.max));
    const targets = new Set<number>();
    ps.forEach((p, i) => {
      assert.ok(p.target >= lo && p.target <= hi, `target ${p.target}`);
      targets.add(p.target);
      const before = ps[i - 1];
      if (!before) return;
      assert.equal(p.start, before.start + before.seconds, "set time is the tracks' lengths end to end");
      const gap = p.target - before.bpm;
      const style = byId(p.styleId).corpus.tempo;
      // Unless it is already near, or its style cannot go further, the tempo moves toward the target.
      const blocked = (gap > 0 && p.bpm >= style.max) || (gap < 0 && p.bpm <= style.min);
      if (Math.abs(p.bpm - p.target) > 2.5 && !blocked) assert.ok((p.bpm - before.bpm) * gap > 0, `${before.bpm} -> ${p.bpm}, heading for ${p.target.toFixed(1)}`);
    });
    assert.ok(targets.size >= 2, `${targets.size} legs in ${Math.round(ps.at(-1)!.start / 60)} minutes`);
  }
  // Across styles, the set goes somewhere.
  const ps = plans(new SetConductor(POOL, "travel-far", SHORT), 6000);
  const bpms = ps.map((p) => p.bpm);
  assert.ok(Math.max(...bpms) - Math.min(...bpms) >= 12, `${Math.min(...bpms)} to ${Math.max(...bpms)} bpm`);
});

test("energy rises and falls, and the set starts cooler", () => {
  let early = 0;
  let earlyN = 0;
  let later = 0;
  let laterN = 0;
  for (const seed of ["e1", "e2", "e3", "e4", "e5", "e6"]) {
    const c = new SetConductor(TECHNO, `energy-${seed}`, SHORT);
    const ps = plans(c, 4000);
    const lifts = ps.map((p) => p.lift);
    for (const p of ps) {
      assert.ok(Math.abs(p.lift) <= MAX_LIFT, `lift ${p.lift}`);
      assert.equal(p.lift, Math.round(c.liftAt(p.start) * 1000) / 1000);
      if (p.start < WARMUP_SECONDS / 3) (early += p.lift), earlyN++;
      else if (p.start > WARMUP_SECONDS) (later += p.lift), laterN++;
    }
    assert.ok(Math.max(...lifts) - Math.min(...lifts) > 0.1, `lift ranges ${Math.min(...lifts)} to ${Math.max(...lifts)}`);
  }
  assert.ok(early / earlyN < later / laterN, `early ${(early / earlyN).toFixed(3)}, later ${(later / laterN).toFixed(3)}`);
});
