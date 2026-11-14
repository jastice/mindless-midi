import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOOP, beatPhase, clipBpm, diff, findBoomerang, findLoop, motion } from "./analyse.js";

const N = 160 * 90;

/** A synthetic clip: a bright blob nodding up and down with period `period` frames, plus slow drift that never repeats exactly. */
function nodding(count: number, period: number, phase = 0, drift = 0): Uint8Array[] {
  return Array.from({ length: count }, (_, t) => {
    const f = new Uint8Array(N);
    const y = 45 + 12 * Math.cos((2 * Math.PI * (t - phase)) / period);
    const x = 80 + drift * t;
    for (let i = 0; i < N; i++) {
      const px = i % 160;
      const py = Math.floor(i / 160);
      f[i] = (px - x) ** 2 + (py - y) ** 2 < 200 ? 220 : 40;
    }
    return f;
  });
}

test("diff is the mean absolute grey difference", () => {
  const a = new Uint8Array(N).fill(10);
  const b = new Uint8Array(N).fill(13);
  assert.equal(diff(a, b), 3);
  assert.equal(diff(a, a), 0);
});

test("the loop search finds a whole-bar loop that closes", () => {
  // 11.25 frames per beat is 128 bpm at 24 fps: 45 frames a bar.
  const frames = nodding(241, 11.25);
  const loop = findLoop(frames, { ...DEFAULT_LOOP, targetBpm: 128 })!;
  assert.ok(loop.closeDiff < 0.5, `closes at ${loop.closeDiff}`);
  assert.equal(loop.frames % 45, 0, `${loop.frames} frames is whole bars at 128`);
  assert.ok(Math.abs(loop.bpm - 128) < 1e-9);
  assert.ok(loop.start + loop.frames < frames.length);
  assert.ok(loop.bars >= 3, "prefers the longer loop");
});

test("a take that drifts away does not close, and says so", () => {
  const frames = nodding(145, 11.25, 0, 0.4);
  const loop = findLoop(frames, { ...DEFAULT_LOOP, bars: [3] })!;
  assert.ok(loop.closeDiff > 3, `close ${loop.closeDiff}`);
  assert.ok(loop.closeDiff > loop.stepDiff);
});

test("bpm from frames and bars", () => {
  assert.equal(clipBpm(135, 3, 24), 128);
  assert.equal(clipBpm(144, 3, 24), 120);
});

test("the beat phase lands on the fastest motion of each nod", () => {
  // The blob moves fastest when cos crosses zero: a quarter period after `phase`.
  for (const phase of [0, 3, 7]) {
    const m = motion(nodding(135, 11.25, phase)).slice(1);
    const { phase: found, strength } = beatPhase(m, 11.25);
    const expected = (phase + 11.25 / 4 - 1) % 11.25; // motion[i] is the step into frame i+1
    const off = Math.min(Math.abs(found - expected), 11.25 - Math.abs(found - expected));
    // Fastest twice per period (down and up): accept either half.
    const offHalf = Math.min(off, Math.abs(off - 11.25 / 2));
    assert.ok(offHalf < 1.2, `phase ${phase}: found ${found}, expected ${expected}`);
    assert.ok(strength > 1.1, `strength ${strength}`);
  }
});

test("a boomerang turns on a still moment and fills whole bars", () => {
  // The blob is still at the top and bottom of each nod.
  const frames = nodding(241, 22.5, 0, 0);
  const b = findBoomerang(frames, 0, { ...DEFAULT_LOOP, targetBpm: 128 })!;
  assert.equal(b.frames, 2 * (b.turn - b.start));
  assert.ok(Math.abs(128 / b.bpm - 1) <= 0.08);
  assert.ok(b.turnMotion < 0.6, `turn motion ${b.turnMotion}`);
});
