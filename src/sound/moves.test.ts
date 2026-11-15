/**
 * Moves on the stems, measured: ramps without steps, cuts that end at their
 * value and open to the dry sound, state that never outlives its move, a
 * stutter that repeats what it names, and the riser and impact. Nobody has
 * listened to any of it; these numbers are what there is.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveValue } from "../engine/moves.js";
import { type Move, OPEN_HIGH, OPEN_LOW } from "../engine/types.js";
import { Noise, type Stereo, StemWindow, stereo } from "./dsp.js";
import { bandShare } from "./measure.js";
import { IMPACT, MoveRunner, impact, stutter } from "./moves.js";

const SR = 24000;
const BEATS = 4;
const FPB = SR / 2; // 120 bpm
const BAR = BEATS * FPB;

/** A bar of white noise, the same for a given seed. */
function noise(frames = BAR, seed = 1, level = 0.3): Stereo {
  const n = new Noise(seed);
  const s = stereo(frames);
  for (let i = 0; i < frames; i++) {
    s.l[i] = level * n.next();
    s.r[i] = level * n.next();
  }
  return s;
}
const copy = (s: Stereo): Stereo => ({ l: s.l.slice(), r: s.r.slice() });
const slice = (s: Stereo, from: number, to: number): Stereo => ({ l: s.l.slice(from, to), r: s.r.slice(from, to) });
const rms = (s: Stereo, from = 0, to = s.l.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return Math.sqrt(e / (2 * Math.max(1, to - from)));
};
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const sweep = (target: "highCut" | "lowCut", from: number, to: number, bar: number, of: number): Move => ({ scope: { part: "p" }, target, from, to, beats: BEATS, span: { bar, of } });

test("a gain move has no step larger than its ramp allows, and is at its end value after it", () => {
  const dc = stereo(BAR);
  dc.l.fill(0.5);
  dc.r.fill(0.5);
  const m: Move = { scope: "master", target: "gain", from: 1, to: 0.2, at: 1, beats: 2 };
  const r = new MoveRunner(SR);
  r.begin();
  r.apply(dc, "k", [m], FPB);
  r.end();
  const ramp = (0.8 * 0.5) / (2 * FPB);
  let worst = 0;
  for (let i = 1; i < BAR; i++) worst = Math.max(worst, Math.abs(dc.l[i]! - dc.l[i - 1]!));
  // (Float32 storage rounds each sample by up to 3e-8.)
  assert.ok(worst <= ramp + 1e-7, `largest step ${worst} against ${ramp}`);
  assert.equal(dc.l[FPB - 1], 0.5, "before it starts: as it was");
  for (let i = 3 * FPB; i < BAR; i++) assert.ok(Math.abs(dc.l[i]! - 0.1) < 1e-7, "after it: at its end value");
});

test("a cut moves in octaves with no step larger than its ramp, ends at its value, and open is the dry sound exactly", () => {
  // The cutoff's path: per sample, never more than the ramp's steepest (an ease is 1.5 times its mean slope).
  for (const m of [sweep("highCut", 300, OPEN_HIGH, 0, 1), { ...sweep("lowCut", 600, OPEN_LOW, 0, 1), curve: "ease" as const }]) {
    const octaves = Math.abs(Math.log2(m.to / m.from));
    let worst = 0;
    for (let i = 1; i <= BAR; i++) worst = Math.max(worst, Math.abs(Math.log2(moveValue(m, i / FPB) / moveValue(m, (i - 1) / FPB))));
    const allowed = (octaves / BAR) * (m.curve === "ease" ? 1.5 : 1);
    assert.ok(worst <= allowed * 1.001, `${m.target}: ${worst} octaves a sample against ${allowed}`);
    assert.equal(moveValue(m, BEATS), m.to);
  }
  // A high-cut opening over 4 bars on noise: brighter every beat, and the last block is the noise as it is.
  const r = new MoveRunner(SR);
  const dry: Stereo[] = [];
  const wet: Stereo[] = [];
  const from = 300;
  const at = (k: number) => from * Math.pow(OPEN_HIGH / from, k / 4);
  for (let k = 0; k < 5; k++) {
    const s = noise(BAR, 10 + k);
    dry.push(copy(s));
    r.begin();
    if (k < 4) r.apply(s, "part:p", [sweep("highCut", at(k), at(k + 1), k, 4)], FPB);
    r.end();
    wet.push(s);
  }
  const bright: number[] = [];
  // (From 10 ms in: a filter with no state fades in from the dry sound over its first 4 ms.)
  for (let k = 0; k < 4; k++) for (let b = 0; b < BEATS; b++) bright.push(bandShare(slice(wet[k]!, b * FPB + (k + b === 0 ? 240 : 0), (b + 1) * FPB), SR, 2000, Infinity));
  console.log(`high-cut 300 Hz to open over 4 bars, share of noise above 2 kHz per beat: ${bright.map((x) => x.toFixed(2)).join(" ")}`);
  for (let i = 1; i < bright.length; i++) assert.ok(bright[i]! >= bright[i - 1]! - 0.02, `beat ${i}: ${bright[i]} after ${bright[i - 1]}`);
  assert.ok(bright[0]! < 0.02 && bright.at(-1)! > 0.75);
  for (let i = BAR - 16; i < BAR; i++) assert.equal(wet[3]!.l[i], dry[3]!.l[i], "open at its end: the dry sound");
  assert.deepEqual(wet[4], dry[4], "the bar after: no filter at all");
  assert.equal(r.holding, false, "and nothing kept");
});

test("seek safety: a bar of a move rendered alone is the bar rendered after the ones before it, once the filter has its first milliseconds", () => {
  const bars = [0, 1, 2, 3].map((k) => noise(BAR, 40 + k));
  const moves = [0, 1, 2, 3].map((k) => [sweep("lowCut", 2000 * Math.pow(0.5, k), 2000 * Math.pow(0.5, k + 1), k, 4), { scope: { part: "p" }, target: "gain", from: 1 - k / 8, to: 1 - (k + 1) / 8, beats: BEATS, span: { bar: k, of: 4 } } as Move]);
  const played = new MoveRunner(SR);
  const out = bars.map((s, k) => {
    const x = copy(s);
    played.begin();
    played.apply(x, "part:p", moves[k]!, FPB);
    played.end();
    return x;
  });
  for (const k of [3, 1, 2]) {
    const alone = new MoveRunner(SR);
    const x = copy(bars[k]!);
    alone.begin();
    alone.apply(x, "part:p", moves[k]!, FPB);
    alone.end();
    let worst = 0;
    for (let i = Math.round(0.05 * SR); i < BAR; i++) worst = Math.max(worst, Math.abs(x.l[i]! - out[k]!.l[i]!), Math.abs(x.r[i]! - out[k]!.r[i]!));
    assert.ok(worst < 1e-5, `bar ${k}: ${worst}`);
  }
  // A seek mid-move on a runner that was playing something else: cleared, it is the bar alone.
  const busy = new MoveRunner(SR);
  busy.begin();
  busy.apply(noise(BAR, 99), "part:p", [sweep("lowCut", 300, 900, 0, 8)], FPB);
  busy.end();
  busy.clear();
  const x = copy(bars[2]!);
  const y = copy(bars[2]!);
  const fresh = new MoveRunner(SR);
  for (const [r, s] of [[busy, x], [fresh, y]] as const) {
    r.begin();
    r.apply(s, "part:p", moves[2]!, FPB);
    r.end();
  }
  assert.deepEqual(x, y);
});

test("a bar without a move on a target is the sound as it is: the lows and the gain at rest change nothing", () => {
  const s = noise();
  const was = copy(s);
  const r = new MoveRunner(SR);
  r.begin();
  r.apply(s, "role:pad", [{ scope: { role: "pad" }, target: "lows", from: 0, to: 0, beats: BEATS }, { scope: { role: "pad" }, target: "gain", from: 1, to: 1, beats: BEATS }], FPB);
  r.end();
  assert.deepEqual(s, was);
  // The lows cut: less below 150 Hz, the rest as it was.
  const t = noise();
  r.begin();
  r.apply(t, "role:bass", [{ scope: { role: "bass" }, target: "lows", from: -24, to: -24, beats: BEATS }], FPB);
  r.end();
  const low = (x: Stereo) => bandShare(x, SR, 0, 80) * rms(x) ** 2;
  assert.ok(db(Math.sqrt(low(t) / low(was))) < -12, `${db(Math.sqrt(low(t) / low(was)))} dB below 80 Hz`);
});

test("a stutter repeats exactly the audio it names, pitched and gated if asked, and meets the barline at silence", () => {
  const s = noise(BAR, 7);
  const was = copy(s);
  const m: Move = { scope: "master", target: "stutter", from: 0.25, to: 0, at: 3, beats: 1 };
  stutter(s, m, FPB, SR);
  const at = 3 * FPB;
  const len = 0.25 * FPB;
  const fade = Math.round(0.001 * SR);
  for (let i = 0; i < at; i++) assert.equal(s.l[i], was.l[i], "before it: untouched");
  for (let k = 0; k < 4; k++) {
    for (let i = fade + 1; i < len - fade - 1; i++) {
      assert.equal(s.l[at + k * len + i], was.l[at + i], `repeat ${k}, sample ${i}`);
      assert.equal(s.r[at + k * len + i], was.r[at + i]);
    }
    for (let i = 0; i < len; i++) assert.ok(Math.abs(s.l[at + k * len + i]!) <= Math.abs(was.l[at + i]!) + 1e-9, "the fades only lower it");
  }
  assert.equal(s.l[BAR - 1], 0, "silent at the barline");
  // Gated: each repeat's second half is silent. Pitched down an octave by the last: it reads the slice at half speed.
  const g = noise(BAR, 7);
  stutter(g, { ...m, param: "gate" }, FPB, SR);
  for (let k = 0; k < 4; k++) assert.equal(rms(g, at + k * len + len / 2, at + (k + 1) * len), 0);
  const p = noise(BAR, 7);
  stutter(p, { ...m, to: -12 }, FPB, SR);
  const last = at + 3 * len;
  for (let i = fade + 2; i < len / 2 - fade; i += 2) assert.ok(Math.abs(p.l[last + i]! - was.l[at + i / 2]!) < 1e-6, `pitched read at ${i}`);
});

test("a riser climbs in brightness and level over its bars and ends in silence", () => {
  const r = new MoveRunner(SR);
  const bars = 4;
  const w = new StemWindow(0, BAR * (bars + 1));
  const at = (k: number) => 200 * Math.pow(6000 / 200, k / bars);
  let until = 0;
  for (let k = 0; k < bars; k++) {
    r.begin();
    until = r.riser(w, "pad", { scope: { role: "pad" }, target: "riser", from: at(k), to: at(k + 1), beats: BEATS, span: { bar: k, of: bars } }, k * BAR, FPB);
    r.end();
  }
  assert.equal(until, bars * BAR);
  const level: number[] = [];
  const bright: number[] = [];
  for (let b = 0; b < bars * BEATS; b++) {
    const part = slice(w, b * FPB, (b + 1) * FPB);
    level.push(db(rms(part)));
    bright.push(bandShare(part, SR, 1500, Infinity));
  }
  console.log(`riser over 4 bars, per beat: level ${level.map((x) => x.toFixed(0)).join(" ")} dB; share above 1.5 kHz ${bright.map((x) => x.toFixed(2)).join(" ")}`);
  for (let i = 1; i < level.length; i++) assert.ok(level[i]! > level[i - 1]! - 0.5, `level at beat ${i}`);
  assert.ok(level.at(-1)! - level[0]! > 20, "it rises by more than 20 dB");
  assert.ok(bright[0]! < 0.1 && bright.at(-1)! > 0.6, "and from dark to bright");
  for (let i = 1; i < bright.length; i++) assert.ok(bright[i]! >= bright[i - 1]! - 0.05, `brightness at beat ${i}`);
  assert.ok(Math.abs(w.l[bars * BAR - 1]!) < 1e-9 && Math.abs(w.r[bars * BAR - 1]!) < 1e-9, "silent at its end");
  assert.equal(rms(w, bars * BAR), 0, "and nothing after");
  // Its loudest beat sits near a stem at full level (bus STEM_REF 0.05).
  assert.ok(Math.abs(level.at(-1)! - db(0.05)) < 6, `${level.at(-1)} dB`);
});

test("an impact is a thump below 120 Hz with a noise tail, and ends in silence", () => {
  const frames = Math.ceil((IMPACT.tail + 1) * SR);
  const w = new StemWindow(0, frames);
  const end = impact(w, { scope: { role: "drums" }, target: "impact", from: 90, to: 38, beats: 0.5 }, 0, FPB, SR);
  assert.equal(end, Math.round(IMPACT.tail * SR));
  const head = slice(w, 0, Math.round(0.3 * SR));
  const tail = slice(w, Math.round(0.8 * SR), Math.round(1.8 * SR));
  const low = bandShare(head, SR, 0, 120);
  const hiss = bandShare(tail, SR, 300, Infinity);
  console.log(`impact: first 300 ms ${(low * 100).toFixed(0)}% below 120 Hz, peak ${db(Math.max(...head.l.map(Math.abs))).toFixed(1)} dBFS, rms ${db(rms(head)).toFixed(1)} dB; 0.8-1.8 s ${db(rms(tail)).toFixed(1)} dB, ${(hiss * 100).toFixed(0)}% above 300 Hz; silent after ${(end / SR).toFixed(1)} s`);
  assert.ok(low > 0.8, `${low} of the head below 120 Hz`);
  assert.ok(hiss > 0.5 && db(rms(tail)) > db(rms(head)) - 32, "a noise tail, not nothing");
  assert.ok(Math.abs(w.l[end - 1]!) < 1e-9);
  assert.equal(rms(w, end), 0, "silent after it");
});
