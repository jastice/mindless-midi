import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../corpus/schema.js";
import { BLEND_BARS, PHRASE_BARS, SetConductor } from "../engine/set.js";
import type { Bar } from "../engine/types.js";
import { type LaneInput, type Lanes, deckLanes } from "./lanes.js";
import { SET_WORDS, isSetName, setName } from "./set_name.js";

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const P = PHRASE_BARS;
const states = (l: Lanes, d: 0 | 1) => l.decks[d].segs.map((s) => s.state).join(" ");
const base: LaneInput = { piece: 4, barInPiece: 0, pieceBars: 128, out: null, phraseBars: P };

test("a track alone, nothing planned: its deck plays on, the other idles", () => {
  const l = deckLanes({ ...base, barInPiece: 20 });
  assert.equal(states(l, 0), "on on on on");
  assert.equal(states(l, 1), "idle idle idle idle");
  assert.equal(l.decks[0].role, "air");
  assert.equal(l.decks[0].dominant, true);
  assert.equal(l.decks[1].role, "idle");
  assert.equal(l.decks[1].piece, null);
  assert.deepEqual([l.phrase, l.barInPhrase], [2, 4]);
  assert.equal(l.mix, null);
});

test("a planned blend past the lanes: the next track cued, its lane idle", () => {
  const l = deckLanes({ ...base, barInPiece: 60, out: { type: "blend", start: 112, bars: 16 } });
  assert.equal(states(l, 0), "on on on on");
  assert.equal(states(l, 1), "idle idle idle idle");
  assert.equal(l.decks[1].role, "cued");
  assert.equal(l.mix, null);
});

test("a planned blend two phrases ahead: out and in where they overlap, the next track cued", () => {
  // A 16-bar blend from bar 112 of 128, seen from bar 99 (phrase 12, bar 3).
  const l = deckLanes({ ...base, barInPiece: 99, out: { type: "blend", start: 112, bars: 16 } });
  assert.equal(states(l, 0), "on on out out");
  assert.equal(states(l, 1), "idle idle in in");
  assert.ok(l.decks[0].segs[2]!.level < l.decks[0].segs[3]!.level, "further through the fade");
  assert.deepEqual(l.mix, { type: "blend", from: 2, to: 3 });
  assert.equal(l.decks[1].role, "cued");
  assert.equal(l.decks[1].piece, 5);
});

test("in the overlap, before and after the swap", () => {
  const t = { type: "blend" as const, from: 4, to: 5, bar: 3, bars: 32, swap: 16 };
  const before = deckLanes({ ...base, barInPiece: 99, transition: t, out: null });
  assert.equal(states(before, 0), "out out out out");
  assert.equal(states(before, 1), "in in in in");
  assert.equal(before.decks[0].role, "out");
  assert.equal(before.decks[1].role, "in");
  assert.equal(before.decks[0].dominant, true);
  // After the swap the heard bar is the incoming track's.
  const after = deckLanes({ ...base, piece: 5, barInPiece: 24, pieceBars: 140, transition: { ...t, bar: 24 }, out: null });
  assert.equal(states(after, 0), "out idle idle idle");
  assert.equal(states(after, 1), "in on on on");
  assert.equal(after.decks[1].dominant, true);
  assert.deepEqual(after.mix, { type: "blend", from: 0, to: 0 });
});

test("a cut: no overlap, the incoming solid from the phrase it lands on", () => {
  const l = deckLanes({ ...base, barInPiece: 104, out: { type: "cut", start: 112, bars: 0 } });
  assert.equal(states(l, 0), "on idle idle idle");
  assert.equal(states(l, 1), "idle on on on");
  assert.deepEqual(l.mix, { type: "cut", from: 1, to: 1 });
});

test("the run-up to a cut: the outgoing alone, the incoming cued for the phrase after", () => {
  const t = { type: "cut" as const, from: 4, to: 5, bar: 2, bars: 8, swap: 8 };
  const l = deckLanes({ ...base, barInPiece: 106, transition: t, out: null });
  assert.equal(states(l, 0), "on idle idle idle");
  assert.equal(states(l, 1), "idle on on on");
  assert.equal(l.decks[0].role, "air");
  assert.equal(l.decks[1].role, "cued");
  assert.deepEqual(l.mix, { type: "cut", from: 1, to: 1 });
});

test("lanes from a real set: what a phrase's lane says comes next is what plays a phrase later", () => {
  for (const seed of ["KALT-7731", "NEBEL-0420", "mellow-tritone-waltz"]) {
    const set = new SetConductor(claudia, seed, { minSeconds: 60, maxSeconds: 150 });
    let predicted = null as { at: number; a: string; b: string } | null;
    let checked = 0;
    let mixes = 0;
    for (let n = 0; n < 900; n++) {
      const bar: Bar = set.nextBar();
      const i = bar.info;
      // As the page does: plan the handover once it could show on the lanes.
      if (!bar.transition && i.barInPiece >= i.pieceBars - BLEND_BARS - 4 * P) set.planTransition(i.pieceIndex);
      const l = deckLanes({ piece: i.pieceIndex, barInPiece: i.barInPiece, pieceBars: i.pieceBars, transition: bar.transition, out: bar.transition ? null : set.transitionPlan(i.pieceIndex), phraseBars: P });
      const dom = l.decks.find((d) => d.dominant)!;
      assert.ok(["on", "out", "in"].includes(dom.segs[0]!.state), `${seed} bar ${n}: the dominant deck sounds now`);
      if (l.mix) mixes++;
      if (i.barInPiece % P) continue;
      if (predicted?.at === n) {
        assert.equal(`${states(l, 0).split(" ")[0]} ${states(l, 1).split(" ")[0]}`, `${predicted.a} ${predicted.b}`, `${seed} bar ${n} (track ${i.pieceIndex + 1}, bar ${i.barInPiece + 1})`);
        checked++;
      }
      predicted = { at: n + P, a: l.decks[0].segs[1]!.state, b: l.decks[1].segs[1]!.state };
    }
    assert.ok(checked > 80, `${seed}: ${checked} phrases checked`);
    assert.ok(mixes > 0, `${seed}: some transitions shown`);
  }
});

test("set names: a German word and a cloakroom number, from the random source", () => {
  const seq = [0, 0.77315, 0.999, 0.04205];
  let k = 0;
  const r = () => seq[k++ % seq.length]!;
  assert.equal(setName(r), `${SET_WORDS[0]}-7731`);
  assert.equal(setName(r), `${SET_WORDS[SET_WORDS.length - 1]}-0420`);
  for (let j = 0; j < 200; j++) assert.ok(isSetName(setName()), "shape");
  assert.ok(!isSetName("mellow-tritone-waltz"));
});
