import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../corpus/schema.js";
import { PHRASE_BARS, SetConductor } from "../engine/set.js";
import { AHEAD, PAST, formatPins, nextTransition, parsePins, slotIndices, stepPhrase, transitionBar } from "./arranger_model.js";

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

test("pins travel as 1-based `track:style` pairs, and what does not parse is dropped", () => {
  const pins = new Map([[4, "minimal_techno"], [2, "berlin_techno"]]);
  assert.equal(formatPins(pins), "3:berlin_techno,5:minimal_techno");
  assert.deepEqual([...parsePins("3:berlin_techno,5:minimal_techno")], [[2, "berlin_techno"], [4, "minimal_techno"]]);
  assert.deepEqual([...parsePins("0:x,abc,2:,:y,7:Bad,8:ok_1")], [[7, "ok_1"]]);
  assert.equal(parsePins(null).size, 0);
  assert.equal(formatPins(parsePins(formatPins(pins))), formatPins(pins));
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
