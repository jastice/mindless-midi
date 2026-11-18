import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../corpus/schema.js";
import { PHRASE_BARS, SetConductor } from "../engine/set.js";
import { AHEAD, PAST, formatPins, moveTrack, nextTransition, parsePins, slotIndices, stepPhrase, transitionBar } from "./arranger_model.js";

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;

test("the running order is two tracks back, the one playing and five ahead", () => {
  assert.deepEqual(slotIndices(4), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(slotIndices(0).length, PAST + 1 + AHEAD);
  assert.deepEqual(slotIndices(0).slice(0, 3), [-2, -1, 0]);
});

test("phrase steps: forward to the next phrase, back to the start of this one, then the one before", () => {
  const bars = (p: number) => [96, 64, 128][p]!;
  // Forward.
  assert.deepEqual(stepPhrase({ piece: 0, bar: 0 }, 1, bars), { piece: 0, bar: 8, solo: false });
  assert.deepEqual(stepPhrase({ piece: 0, bar: 15 }, 1, bars), { piece: 0, bar: 16, solo: false });
  // The last phrase goes on to the next track, alone from its top.
  assert.deepEqual(stepPhrase({ piece: 1, bar: 60 }, 1, bars), { piece: 2, bar: 0, solo: true });
  // Back: a couple of bars into a phrase, to its start; at its start, the phrase before.
  assert.deepEqual(stepPhrase({ piece: 0, bar: 19 }, -1, bars), { piece: 0, bar: 16, solo: false });
  assert.deepEqual(stepPhrase({ piece: 0, bar: 17 }, -1, bars), { piece: 0, bar: 8, solo: false });
  assert.deepEqual(stepPhrase({ piece: 0, bar: 16 }, -1, bars), { piece: 0, bar: 8, solo: false });
  assert.deepEqual(stepPhrase({ piece: 0, bar: 8 }, -1, bars), { piece: 0, bar: 0, solo: false });
  // Before a track's first phrase, the last phrase of the track before; at the set's start, the start.
  assert.deepEqual(stepPhrase({ piece: 1, bar: 1 }, -1, bars), { piece: 0, bar: 88, solo: true });
  assert.deepEqual(stepPhrase({ piece: 0, bar: 1 }, -1, bars), { piece: 0, bar: 0, solo: false });
  // Repeated presses keep going, one phrase each.
  let at = { piece: 1, bar: 27 };
  const seen: number[] = [];
  for (let k = 0; k < 4; k++) {
    const s = stepPhrase(at, -1, bars);
    seen.push(s.bar);
    at = s;
  }
  assert.deepEqual(seen, [24, 16, 8, 0]);
});

test("the next transition is this track's until it has begun, then the next track's", () => {
  const shapes = [
    { bars: 96, out: { start: 64, bars: 32, ramp: 32 } }, // a long blend
    { bars: 80, out: { start: 64, bars: 0, ramp: 8 } }, // a cut: the tempo starts to move 8 bars before
    { bars: 72, out: { start: 64, bars: 8, ramp: 8 } },
  ];
  const shape = (p: number) => shapes[p]!;
  assert.equal(transitionBar(shape(0)), 64);
  assert.equal(transitionBar(shape(1)), 56);
  assert.deepEqual(nextTransition({ piece: 0, bar: 0 }, shape), { piece: 0, bar: 64, solo: false });
  assert.deepEqual(nextTransition({ piece: 0, bar: 63 }, shape), { piece: 0, bar: 64, solo: false });
  assert.deepEqual(nextTransition({ piece: 0, bar: 64 }, shape), { piece: 1, bar: 56, solo: false });
  assert.deepEqual(nextTransition({ piece: 1, bar: 20 }, shape), { piece: 1, bar: 56, solo: false });
});

test("pins travel as 1-based `track:style` pairs, a moved track `@` where it came from, and what does not parse is dropped", () => {
  const pin = (style: string, from: number) => ({ style, from });
  const pins = new Map([[4, pin("minimal_techno", 4)], [2, pin("berlin_techno", 2)], [6, pin("big_beat", 3)]]);
  assert.equal(formatPins(pins), "3:berlin_techno,5:minimal_techno,7:big_beat@4");
  assert.deepEqual([...parsePins("3:berlin_techno,5:minimal_techno@2")], [[2, pin("berlin_techno", 2)], [4, pin("minimal_techno", 1)]]);
  assert.deepEqual([...parsePins("0:x,abc,2:,:y,7:Bad,8:ok_1,9:ok@0,10:ok@x")], [[7, pin("ok_1", 7)]]);
  assert.equal(parsePins(null).size, 0);
  assert.equal(formatPins(parsePins(formatPins(pins))), formatPins(pins));
});

test("moveTrack: the moved track lands on its slot and the ones between shift a slot towards where it was", () => {
  const at = (i: number) => ({ style: `s${i}`, from: i });
  const names = (m: Map<number, { style: string }>) => [...m].map(([i, p]) => `${i}=${p.style}`);
  assert.deepEqual(names(moveTrack(3, 5, at)), ["3=s4", "4=s5", "5=s3"]);
  assert.deepEqual(names(moveTrack(5, 3, at)), ["3=s5", "4=s3", "5=s4"]);
  assert.deepEqual(names(moveTrack(4, 5, at)), ["4=s5", "5=s4"]);
  assert.equal(moveTrack(4, 4, at).size, 0);
  assert.deepEqual(moveTrack(3, 4, at).get(4), { style: "s3", from: 3 }, "it keeps the slot its music is seeded from");
});

// The conductor behind it: a hand-picked style is the style of that track, the set chooses around it, and a track
// the bars have already depended on cannot be changed.
test("pin: a slot takes the style it is given, the tracks after are chosen around it, and mixing tracks are settled", () => {
  const seed = "arranger-pins";
  const free = new SetConductor(claudia, seed);
  const styles = (c: SetConductor, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => c.trackInfo(from + k, false).styleId);
  const before = styles(free, 0, 6);
  const other = claudia.find((s) => s.id !== before[3])!.id;

  const c = new SetConductor(claudia, seed);
  assert.deepEqual(styles(c, 0, 6), before, "looking ahead chooses what the set would have");
  assert.equal(c.pin(3, other), true);
  const pinned = styles(c, 0, 6);
  assert.deepEqual(pinned.slice(0, 3), before.slice(0, 3), "the tracks before are as they were");
  assert.equal(pinned[3], other);
  assert.equal(c.trackInfo(3, false).pinned, true);
  assert.equal(c.pinnedStyle(3), other);
  // Every hand-over is of a track with the next, and the pinned track's tempo and key still follow from the one before it.
  const info = [0, 1, 2, 3, 4].map((i) => c.trackInfo(i));
  for (const t of info) assert.ok(t.out && t.bars % PHRASE_BARS === 0);
  assert.ok(Math.abs(info[3]!.bpm - info[2]!.bpm) <= info[2]!.bpm * 0.03 + 1e-9);

  // Clearing it puts back what the set chose (the seed is the set).
  assert.equal(c.pin(3, null), true);
  assert.deepEqual(styles(c, 0, 6), before);

  // Refused: an unknown style, and a style the set is not playing.
  assert.equal(c.pin(5, "no_such_style"), false);
  assert.equal(c.pin(-1, other), false);

  // The same pins on a fresh conductor give the same running order.
  const again = new SetConductor(claudia, seed);
  again.pin(3, other);
  again.pin(5, other);
  c.pin(3, other);
  c.pin(5, other);
  assert.deepEqual(styles(again, 0, 8), styles(c, 0, 8));
});

test("pin with `from`: a moved track keeps its style and its music's seed, and the set fits key and tempo around it", () => {
  const seed = "arranger-move";
  const c = new SetConductor(claudia, seed);
  const was = [2, 3, 4].map((i) => c.trackInfo(i, false));
  for (const t of was) assert.equal(t.origin, t.index, "a track the set chose is seeded from its own slot");
  for (const [i, p] of moveTrack(2, 4, (i) => ({ style: c.trackInfo(i, false).styleId, from: c.trackInfo(i, false).origin }))) assert.equal(c.pin(i, p.style, p.from), true);
  const now = [2, 3, 4].map((i) => c.trackInfo(i));
  assert.deepEqual(now.map((t) => [t.styleId, t.origin]), [[was[1]!.styleId, 3], [was[2]!.styleId, 4], [was[0]!.styleId, 2]]);
  for (const t of now) assert.ok(t.out && t.bars % PHRASE_BARS === 0);
  // The same moves on a fresh conductor give the same set.
  const again = new SetConductor(claudia, seed);
  again.pin(2, was[1]!.styleId, 3);
  again.pin(3, was[2]!.styleId, 4);
  again.pin(4, was[0]!.styleId, 2);
  assert.deepEqual([2, 3, 4, 5].map((i) => again.trackInfo(i)), [2, 3, 4, 5].map((i) => c.trackInfo(i)));
  assert.equal(c.pin(3, was[0]!.styleId, -1), false);
});

test("pin: tracks the bars depend on are settled, and seeking back opens the later ones again", () => {
  const c = new SetConductor(claudia, "arranger-settled");
  c.seek(0, 0);
  assert.equal(c.settled, 0);
  assert.equal(c.pin(0, "berlin_techno"), false, "the track playing");
  assert.equal(c.pin(1, "berlin_techno"), true, "the next one, while the bars are far from its hand-over");
  // Play on to within the longest hand-over of the end of track 0: now track 1 is part of the bars.
  const bars = c.trackInfo(0).bars;
  for (let k = 0; k < bars - 32; k++) c.nextBar();
  assert.equal(c.settled, 0);
  assert.equal(c.pin(1, "minimal_techno"), true);
  c.nextBar();
  assert.equal(c.settled, 1);
  assert.equal(c.pin(1, "psychedelic_house"), false, "its hand-over has been looked up");
  assert.equal(c.pin(2, "psychedelic_house"), true);
  // Seeking back to the start of track 0 relaxes it again.
  c.seek(0, 0);
  assert.equal(c.settled, 0);
  assert.equal(c.pin(1, "berlin_techno"), true);
  // A track played alone from its first bar is not heard inside its overlap with the one before.
  const first = (solo: boolean) => {
    const k = new SetConductor(claudia, "arranger-solo");
    k.seek(1, 0, solo);
    return k.nextBar();
  };
  assert.equal(first(true).info.pieceIndex, 1);
  assert.equal(first(true).info.barInPiece, 0);
  assert.equal(first(true).with, undefined);
});
