import assert from "node:assert/strict";
import { test } from "node:test";
import { Rng } from "./rng.js";
import {
  chordName,
  chordPitchClasses,
  chordScale,
  degreeToMidi,
  foldIntoRange,
  parseRoman,
  pitchClass,
  snapToPitchClasses,
  stableMelodyPitchClasses,
  voiceChord,
} from "./theory.js";

test("pitch classes", () => {
  assert.equal(pitchClass("C"), 0);
  assert.equal(pitchClass("Eb"), 3);
  assert.equal(pitchClass("F#"), 6);
  assert.equal(pitchClass("Cb"), 11);
});

test("roman numerals: case, accidentals, qualities", () => {
  assert.deepEqual(chordPitchClasses(0, parseRoman("I")), [0, 4, 7]);
  assert.deepEqual(chordPitchClasses(0, parseRoman("vi")), [9, 0, 4]);
  assert.deepEqual(chordPitchClasses(0, parseRoman("V7")), [7, 11, 2, 5]);
  assert.deepEqual(chordPitchClasses(0, parseRoman("ii7")), [2, 5, 9, 0]);
  assert.deepEqual(chordPitchClasses(0, parseRoman("IVmaj7")), [5, 9, 0, 4]);
  assert.deepEqual(chordPitchClasses(0, parseRoman("bVI")), [8, 0, 3]);
  assert.deepEqual(chordPitchClasses(0, parseRoman("viiø7")), [11, 2, 5, 9]);
  assert.deepEqual(chordPitchClasses(9, parseRoman("i")), [9, 0, 4]); // A minor
  assert.deepEqual(chordPitchClasses(0, parseRoman("i5")), [0, 7]);
  assert.deepEqual(chordPitchClasses(0, parseRoman("Isus4")), [0, 5, 7]);
  assert.deepEqual(chordPitchClasses(0, parseRoman("ii9")), [2, 5, 9, 0, 4]);
  assert.throws(() => parseRoman("H7"));
  assert.throws(() => parseRoman("Iwhat"));
});

test("chord scale keeps chord tones on their slots and stays in mode", () => {
  // V7 in C ionian: G mixolydian
  assert.deepEqual(chordScale("ionian", parseRoman("V7")), [0, 2, 4, 5, 7, 9, 10]);
  // ii7 in C dorian-ish ionian: D dorian
  assert.deepEqual(chordScale("ionian", parseRoman("ii7")), [0, 2, 3, 5, 7, 9, 10]);
  // i in phrygian keeps the b2
  assert.deepEqual(chordScale("phrygian", parseRoman("i")), [0, 1, 3, 5, 7, 8, 10]);
  // monotonic for every quality
  for (const sym of ["I", "isus2", "Isus4", "i5", "viio7", "bVII9", "IV6", "#ivø7"]) {
    const sc = chordScale("aeolian", parseRoman(sym));
    for (let i = 1; i < sc.length; i++) assert.ok(sc[i]! >= sc[i - 1]!, `${sym}: ${sc}`);
  }
});

test("degree arithmetic wraps octaves", () => {
  const major = [0, 2, 4, 5, 7, 9, 11];
  assert.equal(degreeToMidi(major, 0, 60), 60);
  assert.equal(degreeToMidi(major, 2, 60), 64);
  assert.equal(degreeToMidi(major, 7, 60), 72);
  assert.equal(degreeToMidi(major, -1, 60), 59);
  assert.equal(degreeToMidi(major, -7, 60), 48);
});

test("snap and fold", () => {
  assert.equal(snapToPitchClasses(61, [0, 4, 7]), 60);
  assert.equal(snapToPitchClasses(66, [0, 4, 7]), 67);
  assert.equal(foldIntoRange(30, 48, 72), 54);
  assert.equal(foldIntoRange(90, 48, 72), 66);
});

test("voice leading prefers small movement", () => {
  const c = voiceChord(0, parseRoman("I"), "close", 60, null);
  const f = voiceChord(0, parseRoman("IV"), "close", 60, c);
  const moved = f.reduce((acc, n, i) => acc + Math.abs(n - (c[i] ?? n)), 0);
  assert.ok(moved <= 6, `C ${c} -> F ${f} moved ${moved}`);
  for (const v of ["open", "shell", "spread", "power", "rootless", "triad"] as const) {
    const notes = voiceChord(2, parseRoman("V7"), v, 60, null);
    assert.ok(notes.length >= 2, v);
    for (const n of notes) assert.ok(n > 30 && n < 90, `${v}: ${notes}`);
  }
});

test("rng is deterministic and forks are independent", () => {
  const a = new Rng("seed");
  const b = new Rng("seed");
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  const f1 = new Rng("x").fork("drums").next();
  const f2 = new Rng("x").fork("bass").next();
  assert.notEqual(f1, f2);
  const r = new Rng(1);
  for (let i = 0; i < 1000; i++) {
    const n = r.int(3, 5);
    assert.ok(n >= 3 && n <= 5);
  }
});

test("lead-sheet chord names", () => {
  assert.equal(chordName(0, "ii7"), "Dm7");
  assert.equal(chordName(0, "V7"), "G7");
  assert.equal(chordName(0, "bVImaj7"), "Abmaj7");
  assert.equal(chordName(9, "i"), "Am");
  assert.equal(chordName(0, "viiø7"), "Bø7");
  assert.equal(chordName(4, "bII"), "F");
  assert.equal(chordName(0, "i5"), "C5");
});

test("stable melody tones avoid half-step clashes", () => {
  assert.deepEqual(stableMelodyPitchClasses(0, parseRoman("Imaj7")), [4, 7, 11]);
  assert.deepEqual(stableMelodyPitchClasses(0, parseRoman("V7")), [7, 11, 2, 5]);
  assert.deepEqual(stableMelodyPitchClasses(0, parseRoman("ii9")), [2, 9, 0]);
});
