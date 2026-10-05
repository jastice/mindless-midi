import assert from "node:assert/strict";
import { test } from "node:test";
import { Leveler, TARGET_RMS, softClip } from "./leveler.js";

const SR = 48000;

function rmsOf(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! ** 2;
  return Math.sqrt(s / (to - from));
}

function tone(amp: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  return out;
}

test("soft clip is transparent below the knee and bounded above", () => {
  assert.equal(softClip(0.5), 0.5);
  assert.equal(softClip(-0.8), -0.8);
  assert.ok(softClip(5) <= 1 && softClip(5) > 0.95);
  assert.ok(softClip(-5) >= -1);
});

test("a sudden loud entrance is pulled toward the target within a second", () => {
  const lev = new Leveler(SR);
  lev.setGain(1);
  const l = tone(0.6, 3); // ~0.42 rms, 4x the target
  const r = l.slice();
  lev.process(l, r, 0, l.length);
  const late = rmsOf(l, SR * 1, SR * 1.5);
  assert.ok(late < TARGET_RMS * 2.5, `rms after 1s = ${late}`);
  assert.ok(late > TARGET_RMS * 1.5, "never more than 6 dB of reduction");
});

test("quiet material is lifted by at most 6 dB, silence is left alone", () => {
  const lev = new Leveler(SR);
  lev.setGain(1);
  const l = tone(0.035, 12); // ~0.025 rms
  const r = l.slice();
  lev.process(l, r, 0, l.length);
  const end = rmsOf(l, SR * 11, SR * 12);
  assert.ok(end > 0.045 && end < 0.051, `lifted to ${end}`);
  const z = new Float32Array(SR);
  lev.process(z, z.slice(), 0, z.length);
  assert.ok(z.every((x) => x === 0));
});

test("style gain applies immediately on a new piece", () => {
  const lev = new Leveler(SR);
  lev.setGain(3);
  const l = tone(0.01, 0.1);
  lev.process(l, l.slice(), 0, l.length);
  assert.ok(Math.abs(rmsOf(l, 0, 100) - rmsOf(tone(0.03, 0.1), 0, 100)) < 0.002);
});
