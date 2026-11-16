import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Role, StyleBundle } from "../corpus/schema.js";
import { keysCompatible } from "../theory/theory.js";
import type { PieceOptions } from "./piece.js";
import { MAX_LIFT, MAX_TEMPO_STEP, MIX_BARS, PHRASE_BARS, SetConductor, type Slice, WARMUP_SECONDS, deckOf, mixBars, mixLeaveOut } from "./set.js";
import type { Bar, Move, TransitionType } from "./types.js";

const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };
const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const byId = (id: string) => [...claudia, ...styles].find((s) => s.id === id)!;

// Claudia's own pack, which is one style so far.
const TECHNO = [byId("minimal_techno")];
/** The same style as it was before it had parts, for the conductor's mix by role (see grid.test.ts for the mix by part). */
function withoutParts(style: StyleBundle): StyleBundle {
  const { parts: _, arrangement: __, moves: ___, ...corpus } = style.corpus;
  const own = <T extends { material?: string | undefined }>(items: T[]) => items.filter((x) => x.material === undefined);
  return { ...style, corpus: { ...corpus, motifs: own(corpus.motifs), comping: own(corpus.comping), drums: own(corpus.drums) } };
}
const PLAIN_TECHNO = [withoutParts(byId("minimal_techno"))];
// Several 4/4 styles with spread tempos, for choosing between styles. Electro swing brings harmonic minor, which few keys of the others neighbour.
const POOL = ["synthwave", "disco", "funk", "electro_swing", "retro"].map(byId);
const SHORT: PieceOptions = { minSeconds: 60, maxSeconds: 150 };

function take(c: SetConductor, n: number): Bar[] {
  return Array.from({ length: n }, () => c.nextBar());
}

const key = (b: Bar) => JSON.stringify([b.beats, b.bpm, b.notes, b.info, b.moves, b.deck, b.transition, b.with && [b.with.notes, b.with.info, b.with.moves]]);

// Styles without parts: a set of them is one stream of bars, cut at each track's end, as it was before two decks.
test("without parts: tempo and key carry across every transition, and every cut is on a phrase", () => {
  for (const [seed, pool] of [["one", PLAIN_TECHNO], ["two", PLAIN_TECHNO], ["three", POOL], ["four", POOL]] as const) {
    const bars = take(new SetConductor(pool, `set-${seed}`, SHORT), 4000);
    let transitions = 0;
    let moves = 0;
    bars.forEach((bar, i) => {
      assert.equal(bar.beats, 4);
      assert.equal(bar.deck, undefined);
      assert.equal(bar.with, undefined);
      assert.equal(bar.transition, undefined);
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

const sliceKey = (s: Slice) => JSON.stringify([s.bpm, s.dominant, s.transition, s.moves, s.decks.map((d) => [d.deck, d.bar.beats, d.bar.bpm, d.bar.notes, d.bar.info, d.bar.moves])]);
const slices = (c: SetConductor, n: number): Slice[] => Array.from({ length: n }, () => c.nextSlice());
const has = (s: Slice, track: number, bar: number) => s.decks.some((d) => d.bar.info.pieceIndex === track && d.bar.info.barInPiece === bar);

test("seeking to a track and bar gives the slices playing through gives, with both decks in a transition", () => {
  const run = slices(new SetConductor(TECHNO, "seek", SHORT), 3000);
  // Places in the body of a track, and in every transition the run has: each track's first bars, and the last of the one before.
  const places: [number, number][] = [[0, 0], [0, 9], [3, 17], [6, 40], [9, 3]];
  for (const s of run) {
    if (s.transition?.bar === 3 && s.decks.length === 2) for (const d of s.decks) places.push([d.bar.info.pieceIndex, d.bar.info.barInPiece]);
  }
  assert.ok(places.length > 20, `${places.length} places`);
  let overlaps = 0;
  for (const [track, bar] of places) {
    const at = run.findIndex((s) => has(s, track, bar));
    // (A track cut into starts past its mix-in: its first bars are only reached by a seek.)
    if (at < 0) continue;
    const c = new SetConductor(TECHNO, "seek", SHORT);
    const landing = c.seek(track, bar);
    assert.deepEqual([landing.piece, landing.bar], [track, bar]);
    const resumed = slices(c, 120);
    if (resumed[0]!.decks.length === 2) overlaps++;
    resumed.forEach((s, j) => assert.equal(sliceKey(s), sliceKey(run[at + j]!), `track ${track} bar ${bar} + ${j}`));
    // Each deck's first bar carries the setup of its track so far.
    for (const d of resumed[0]!.decks) {
      const i = d.bar.info.pieceIndex;
      const setup = run.slice(0, at + 1).flatMap((s) => s.decks.filter((x) => x.bar.info.pieceIndex === i).flatMap((x) => x.bar.controls.map((k) => ({ ...k, beat: 0 }))));
      assert.deepEqual(d.bar.controls.map((k) => ({ ...k, beat: 0 })), setup);
    }
  }
  assert.ok(overlaps >= 10, `${overlaps} seeks landed in an overlap`);

  const bars = take(new SetConductor(TECHNO, "seek", SHORT), 3000);
  const c = new SetConductor(TECHNO, "seek", SHORT);
  const landing = c.seekSegment(2, 1);
  const bar = c.nextBar();
  assert.equal(bar.info.pieceIndex, 2);
  assert.equal(bar.info.sectionIndex, 1);
  assert.equal(bar.info.barInSection, 0);
  assert.equal(key(bar), key(bars.find((b) => b.info.pieceIndex === 2 && b.info.barInPiece === landing.bar)!));
  const layout = c.layout(2)!;
  assert.equal(layout.length, bar.info.sectionCount, "no ending segment");
  assert.equal(layout.at(-1)!.start + layout.at(-1)!.bars, bar.info.pieceBars);
  assert.equal(c.layout(50), null);
});

test("a track mixes in drums first, then bass, then the rest, and out in reverse", () => {
  let checked = 0;
  for (const [seed, pool] of [["m1", PLAIN_TECHNO], ["m2", PLAIN_TECHNO], ["m3", POOL]] as const) {
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

// --- Two decks ---------------------------------------------------------------

const isKick = (n: { role: Role; key: number }) => n.role === "drums" && (n.key === 35 || n.key === 36);
const deckMoves = (s: Slice, deck: 0 | 1, target: Move["target"]) => s.moves.filter((m) => m.scope !== "master" && m.scope.deck === deck && m.target === target);
const SEEDS = ["d1", "d2", "d3", "d4", "d5", "d6"];
/** Long runs of Claudia's set, shared by the tests below. */
const RUNS = new Map(SEEDS.map((seed) => [seed, slices(new SetConductor(TECHNO, `decks-${seed}`, SHORT), 5000)]));

test("two decks: tracks overlap in transitions of four types, on the phrase, at one tempo", () => {
  const types = new Map<TransitionType, number>();
  let overlapping = 0;
  for (const [seed, run] of RUNS) {
    let transitions = 0;
    run.forEach((s, i) => {
      const before = run[i - 1];
      assert.equal(s.index, i);
      // One tempo for everything in the slice, never more than half a percent from the bar before.
      for (const d of s.decks) {
        assert.equal(d.bar.bpm, s.bpm);
        assert.equal(d.bar.beats, 4);
        assert.equal(d.bar.deck, d.deck);
        assert.equal(d.deck, deckOf(d.bar.info.pieceIndex));
        assert.equal(d.bar.info.gap, false);
      }
      if (before) assert.ok(Math.abs(s.bpm - before.bpm) <= before.bpm * 0.005 + 1e-9, `${seed} slice ${i}: ${before.bpm} -> ${s.bpm} bpm`);
      assert.ok(s.decks.length === 1 || s.decks.length === 2);
      assert.ok(s.decks.some((d) => d.deck === s.dominant));
      if (s.decks.length === 2) {
        overlapping++;
        const [out, inc] = s.decks as [Slice["decks"][0], Slice["decks"][0]];
        const t = s.transition!;
        assert.notEqual(t.type, "cut");
        assert.deepEqual([t.from, t.to], [out.bar.info.pieceIndex, inc.bar.info.pieceIndex]);
        assert.equal(t.to, t.from + 1);
        assert.notEqual(out.deck, inc.deck);
        // The mix-out over the mix-in, ending with the outgoing track.
        assert.equal(inc.bar.info.barInPiece, t.bar);
        assert.equal(out.bar.info.barInPiece, out.bar.info.pieceBars - t.bars + t.bar);
        assert.ok(keysCompatible(out.bar.info, inc.bar.info), `${out.bar.info.keyName} with ${inc.bar.info.keyName}`);
        // It starts and ends on a phrase, and the low end changes hands on one.
        if (t.bar === 0) {
          assert.equal(i % PHRASE_BARS, 0, `${seed}: a ${t.type} starts on slice ${i}`);
          assert.equal(t.bars % PHRASE_BARS, 0);
          types.set(t.type, (types.get(t.type) ?? 0) + 1);
          transitions++;
        }
        if (before?.decks.length === 2 && before.dominant !== s.dominant) {
          assert.equal(i % PHRASE_BARS, 0, `${seed}: the swap on slice ${i}`);
          assert.equal(s.dominant, inc.deck);
        }
        if (t.bar === 0 && t.type !== "filter") assert.equal(s.dominant, out.deck);
        if (t.bar === t.bars - 1) assert.equal(s.dominant, inc.deck);
      } else if (before && before.decks.at(-1)!.bar.info.pieceIndex !== s.decks[0]!.bar.info.pieceIndex) {
        // A cut: no overlap. The track before stops a phrase short of its mix-out; this one starts past its mix-in.
        const last = before.decks[0]!.bar.info;
        const info = s.decks[0]!.bar.info;
        assert.equal(before.decks.length, 1);
        assert.equal(info.pieceIndex, last.pieceIndex + 1);
        assert.equal(i % PHRASE_BARS, 0);
        assert.equal(last.barInPiece, last.pieceBars - MIX_BARS - 1);
        assert.equal(info.barInPiece, MIX_BARS);
        assert.equal(before.transition?.type, "cut");
        assert.ok(keysCompatible(last, info));
        assert.ok(before.moves.some((m) => m.target === "delaySend"), "an echo throw on the last bar");
        assert.ok(s.moves.some((m) => m.target === "impact"), "an impact on the first");
        assert.ok(s.decks[0]!.bar.controls.some((c) => c.kind === "program"), "the track's setup rides on its first bar");
        types.set("cut", (types.get("cut") ?? 0) + 1);
        transitions++;
      }
    });
    assert.ok(transitions >= 20, `${seed}: ${transitions} transitions`);
    // A track's own tempo outside transitions; across one, at most 3%.
    const c = new SetConductor(TECHNO, `decks-${seed}`, SHORT);
    slices(c, 5000);
    for (let k = 1; c.trackPlan(k); k++) assert.ok(Math.abs(c.trackPlan(k)!.bpm - c.trackPlan(k - 1)!.bpm) <= c.trackPlan(k - 1)!.bpm * MAX_TEMPO_STEP + 1e-9);
    for (const s of run) if (!s.transition) assert.equal(s.bpm, c.trackPlan(s.decks[0]!.bar.info.pieceIndex)!.bpm);
  }
  console.log(`transitions over ${SEEDS.length} sets: ${[...types].map(([t, n]) => `${t} ${n}`).join(", ")}; ${overlapping} bars with two tracks`);
  for (const t of ["blend", "filter", "cut", "breakdown"] as const) assert.ok((types.get(t) ?? 0) >= 3, `${t}: ${types.get(t) ?? 0}`);
  assert.ok(types.get("blend")! > types.get("cut")!, "mostly blends");
});

test("two decks: one low end, one set of pitched parts, and the styles' limits across both", () => {
  const arrangement = TECHNO[0]!.corpus.arrangement!;
  const part = new Map(TECHNO[0]!.corpus.parts!.map((p) => [p.id, p]));
  let bothKicks = 0;
  let most = 0;
  let noKick = 0;
  const dropped = new Set<string>();
  for (const [seed, run] of RUNS) {
    const c = new SetConductor(TECHNO, `decks-${seed}`, SHORT);
    run.forEach((s, i) => {
      // What each track's grid had, before the decks were interleaved.
      const whole = c.nextSlice();
      assert.equal(whole.index, i);
      if (s.decks.length < 2) return;
      const t = s.transition!;
      const dom = s.decks.find((d) => d.deck === s.dominant)!;
      const other = s.decks.find((d) => d.deck !== s.dominant)!;
      const where = `${seed} slice ${i} (${t.type} ${t.bar}/${t.bars})`;
      // The other deck plays drums only: never two basses, two pads or two lines.
      for (const n of other.bar.notes) assert.equal(n.role, "drums", where);
      assert.ok(!(dom.bar.notes.some((n) => n.role === "bass") && other.bar.notes.some((n) => n.role === "bass")));
      for (const d of s.decks) for (const n of d.bar.notes) assert.ok(d.bar.info.parts!.includes(n.part!), `${where}: ${n.part} plays`);
      // The limits hold for the sum.
      const ids = s.decks.flatMap((d) => d.bar.info.parts!);
      assert.ok(ids.length <= arrangement.most!, `${where}: ${ids.length} parts`);
      most = Math.max(most, ids.length);
      for (const [g, limit] of Object.entries(arrangement.groups!)) assert.ok(ids.filter((id) => part.get(id)!.group === g).length <= limit, `${where}: group ${g}: ${ids}`);
      // Two kicks: the other deck's has its lows cut, but for the half beat in which the low end changes hands.
      const kicks = s.decks.filter((d) => d.bar.notes.some(isKick));
      if (kicks.length === 2) {
        bothKicks++;
        const cut = deckMoves(s, other.deck, "lowCut")[0];
        assert.ok(cut && cut.from >= 150, `${where}: the other kick's lows`);
        if (cut.to < 150) assert.ok((cut.at ?? 0) >= 3.5 && run[i + 1]!.dominant === other.deck, `${where}: opens only into the swap`);
        assert.equal(deckMoves(s, dom.deck, "lowCut").filter((m) => m.from >= 150 && (m.at ?? 0) === 0).length, 0, `${where}: the dominant kick's lows are open`);
      }
      // A breakdown's second phrase has no kick and no bass at all.
      if (t.type === "breakdown" && t.bar >= t.bars / 2) {
        assert.equal(kicks.length, 0, where);
        assert.ok(!s.decks.some((d) => d.bar.notes.some((n) => n.role === "bass")), where);
        noKick++;
      }
      // Every move names a deck in the slice, and each deck's bar carries its own.
      for (const m of s.moves) {
        assert.ok(m.scope !== "master" && m.scope.deck !== undefined);
        const bar = s.decks.find((d) => d.deck === (m.scope as { deck: number }).deck)!.bar;
        assert.ok(bar.moves!.includes(m));
      }
    });
    // Moves carry on from bar to bar: where one ends the next starts.
    for (let i = 1; i < run.length; i++) {
      for (const deck of [0, 1] as const) {
        for (const target of ["lowCut", "gain", "riser"] as const) {
          const a = deckMoves(run[i - 1]!, deck, target)[0];
          const b = deckMoves(run[i]!, deck, target)[0];
          if (a && b) assert.ok(Math.abs(a.to - b.from) < 1e-9, `${seed} slice ${i}: ${target} on deck ${deck} steps from ${a.to} to ${b.from}`);
        }
      }
    }
  }
  console.log(`in transitions: ${bothKicks} bars with both kicks, ${noKick} breakdown bars with none; at most ${most} parts across both decks`);
  assert.ok(bothKicks > 500 && noKick > 20);
  void dropped;
});

test("two decks: nextBar gives the dominant deck's bar, with the other beside it", () => {
  const a = new SetConductor(TECHNO, "decks-d1", SHORT);
  const b = new SetConductor(TECHNO, "decks-d1", SHORT);
  let withOther = 0;
  for (let i = 0; i < 1500; i++) {
    const s = a.nextSlice();
    const bar = b.nextBar();
    const dom = s.decks.find((d) => d.deck === s.dominant)!.bar;
    const other = s.decks.find((d) => d.deck !== s.dominant)?.bar;
    assert.equal(bar.info, dom.info === bar.info ? bar.info : bar.info);
    assert.deepEqual([bar.info.pieceIndex, bar.info.barInPiece, bar.deck], [dom.info.pieceIndex, dom.info.barInPiece, s.dominant]);
    assert.deepEqual(bar.notes, dom.notes);
    assert.deepEqual(bar.with?.notes, other?.notes);
    assert.deepEqual(bar.transition, s.transition);
    assert.equal(b.currentPiece!.index, dom.info.pieceIndex);
    if (bar.with) withOther++;
  }
  assert.ok(withOther > 50);
});

test("two decks: a skip in a transition goes on with the incoming track alone; outside one, the next from its top", () => {
  const run = RUNS.get("d2")!;
  const at = run.findIndex((s) => s.decks.length === 2 && s.transition!.bar === 2);
  const c = new SetConductor(TECHNO, "decks-d2", SHORT);
  slices(c, at + 1);
  c.skip();
  const next = c.nextSlice();
  assert.equal(next.decks.length, 1);
  assert.deepEqual([next.decks[0]!.bar.info.pieceIndex, next.decks[0]!.bar.info.barInPiece], [run[at]!.transition!.to, 3]);
  assert.equal(next.moves.length, 0);
  c.skip();
  const after = c.nextSlice();
  assert.deepEqual([after.decks.length, after.decks[0]!.bar.info.pieceIndex, after.decks[0]!.bar.info.barInPiece], [1, run[at]!.transition!.to + 1, 0]);
});

test("two decks: between two styles, each deck plays its own style and the lower of their limits holds for the sum", () => {
  const both = [byId("minimal_techno"), byId("berlin_techno")];
  const most = Math.min(...both.map((s) => s.corpus.arrangement!.most!));
  const types = new Map<string, number>();
  let across = 0;
  for (const seed of ["x1", "x2", "x3"]) {
    const c = new SetConductor(both, `styles-${seed}`);
    for (let i = 0; i < 3000; i++) {
      const s = c.nextSlice();
      if (s.decks.length < 2) continue;
      const [a, b] = s.decks.map((d) => d.bar.info) as [Bar["info"], Bar["info"]];
      if (a.styleId === b.styleId) continue;
      across++;
      if (s.transition!.bar === 0) types.set(s.transition!.type, (types.get(s.transition!.type) ?? 0) + 1);
      assert.ok(a.parts!.length + b.parts!.length <= most, `${seed} slice ${i}: ${a.parts} + ${b.parts}`);
      for (const d of s.decks) assert.equal(d.bar.deck, d.deck);
    }
  }
  console.log(`between the two styles: ${across} bars with both, ${[...types].map(([t, n]) => `${t} ${n}`).join(", ")}`);
  assert.ok(across > 200 && types.size >= 3);
});
