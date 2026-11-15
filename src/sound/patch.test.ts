/** Patches in the synth: movement on the beat clock, filter modes, FM, drive, glide, accent and stereo. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patch } from "../corpus/patch.js";
import { type Stereo, stereo } from "./dsp.js";
import { bandShare } from "./measure.js";
import { modValue, renderSynthNote } from "./synth.js";
import type { ScoreNote } from "./types.js";

const SR = 48000;
/** 120 BPM. */
const BEAT = 0.5;

const BASE: Patch = {
  osc: { wave: "saw", voices: 1, detune: 0 },
  filter: { type: "low", cutoff: 400, q: 1, keytrack: 0, env: 0, a: 0.002, d: 0.1, s: 1, r: 0.05 },
  amp: { a: 0.002, d: 0.1, s: 1, r: 0.05 },
  level: 0.5,
};
/** A cutoff that swings an octave each way through the low harmonics of A3 (key 57): the note's level follows the modulator. */
const wobble = (beats: number): Patch => ({ ...BASE, filter: { ...BASE.filter, cutoff: 600 }, mod: [{ target: "cutoff", shape: "sine", beats, depth: 1 }] });

const note = (t: number, dur: number, key: number, more: Partial<ScoreNote> = {}): ScoreNote => ({ t, dur, key, vel: 100, ch: 4, role: "comp", program: 90, patch: "p", beat: BEAT, pos: t / BEAT, ...more });

function render(patch: Patch, notes: ScoreNote[], seconds: number): Stereo {
  const out = stereo(Math.round(seconds * SR));
  notes.forEach((n, i) => renderSynthNote(out, n, SR, "none", notes[i - 1], false, { patches: { p: patch } }));
  return out;
}

const cut = (s: Stereo, from: number, to: number): Stereo => ({ l: s.l.slice(Math.round(from * SR), Math.round(to * SR)), r: s.r.slice(Math.round(from * SR), Math.round(to * SR)) });
const rms = (s: Stereo) => {
  let e = 0;
  for (let i = 0; i < s.l.length; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return Math.sqrt(e / (2 * Math.max(1, s.l.length)));
};
const peak = (s: Stereo) => s.l.reduce((m, x, i) => Math.max(m, Math.abs(x), Math.abs(s.r[i]!)), 0);

/** Level in windows of `hop` samples. */
function envelope(s: Stereo, hop: number): number[] {
  const out: number[] = [];
  for (let at = 0; at + hop <= s.l.length; at += hop) out.push(rms({ l: s.l.subarray(at, at + hop) as Stereo["l"], r: s.r.subarray(at, at + hop) as Stereo["r"] }));
  return out;
}

/** Correlation of a series with itself `lag` steps later. */
function selfCorrelation(x: number[], lag: number): number {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  let num = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i + lag < x.length; i++) {
    num += (x[i]! - mean) * (x[i + lag]! - mean);
    a += (x[i]! - mean) ** 2;
    b += (x[i + lag]! - mean) ** 2;
  }
  return num / Math.sqrt(a * b);
}

function correlation(x: number[], y: number[]): number {
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  let num = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    a += (x[i]! - mx) ** 2;
    b += (y[i]! - my) ** 2;
  }
  return num / Math.sqrt(a * b);
}

/** Amplitude of the component at `hz`. */
function partial(s: Stereo, hz: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < s.l.length; i++) {
    re += s.l[i]! * Math.cos((2 * Math.PI * hz * i) / SR);
    im += s.l[i]! * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  return (2 * Math.hypot(re, im)) / s.l.length;
}

/** Upward zero crossings per second: the pitch of a clean tone. */
function pitch(s: Stereo): number {
  let n = 0;
  for (let i = 1; i < s.l.length; i++) if (s.l[i - 1]! < 0 && s.l[i]! >= 0) n++;
  return (n * SR) / s.l.length;
}

test("a modulated patch is periodic at its stated rate", () => {
  // 24 windows per beat, each several cycles of the note. A held note's level follows the cutoff as it sweeps over the harmonics.
  const hop = (BEAT * SR) / 24;
  for (const beats of [1, 2, 3]) {
    const env = envelope(cut(render(wobble(beats), [note(0, 7, 57)], 7.2), 0.5, 6.5), hop);
    const period = 24 * beats;
    const sine = env.map((_, i) => Math.sin((2 * Math.PI * (24 + i + 0.5)) / period));
    assert.ok(selfCorrelation(env, period) > 0.98, `one period on, the same (${beats} beats): ${selfCorrelation(env, period)}`);
    assert.ok(selfCorrelation(env, period / 2) < 0, `half a period on, not the same (${beats} beats): ${selfCorrelation(env, period / 2)}`);
    // The level is not a straight line of the cutoff, so not a pure sine; but it leans on the sine and not on the cosine.
    const cosine = env.map((_, i) => Math.cos((2 * Math.PI * (24 + i + 0.5)) / period));
    assert.ok(correlation(env, sine) > 0.6 && Math.abs(correlation(env, cosine)) < 0.2, `in phase with the beat (${beats} beats): ${correlation(env, sine)}, ${correlation(env, cosine)}`);
  }
});

test("without a tempo on the note, modulators assume 120 BPM from time zero", () => {
  const withClock = render(wobble(1), [note(1, 1, 57)], 2.2);
  const without = render(wobble(1), [note(1, 1, 57, { beat: undefined, pos: undefined } as Partial<ScoreNote>)], 2.2);
  assert.deepEqual(without.l, withClock.l);
});

test("modulation phase belongs to the track, not the note", () => {
  const patch = wobble(4);
  // The same note a whole period later sounds the same; half a period later it does not.
  const at = (pos: number) => cut(render(patch, [note(0, 0.4, 57, { pos })], 0.5), 0, 0.5);
  const a = at(1);
  const b = at(5);
  const c = at(3);
  let same = 0;
  let other = 0;
  for (let i = 0; i < a.l.length; i++) {
    same = Math.max(same, Math.abs(a.l[i]! - b.l[i]!));
    other = Math.max(other, Math.abs(a.l[i]! - c.l[i]!));
  }
  assert.ok(same < 1e-4 * peak(a), `a period apart: ${same}`);
  assert.ok(other > 0.1 * peak(a), `half a period apart: ${other}`);

  // A run of 16th notes traces the modulator: each note's brightness is where the sine is at its onset.
  const notes = Array.from({ length: 32 }, (_, i) => note(i * 0.125, 0.1, 57));
  const out = render(patch, notes, 4.2);
  const bright = notes.map((n) => rms(cut(out, n.t + 0.02, n.t + 0.1)));
  const sine = notes.map((n) => Math.sin((2 * Math.PI * (n.pos! + 0.12)) / 4));
  assert.ok(correlation(bright, sine) > 0.95, `notes follow the sine: ${correlation(bright, sine)}`);
});

test("modulator shapes stay in range, repeat, and the random one holds a value per period", () => {
  for (const shape of ["sine", "saw", "square", "random"] as const) {
    const m = { target: "cutoff" as const, shape, beats: 2, depth: 1 };
    let jump = 0;
    for (let i = 0; i < 4000; i++) {
      const x = modValue(m, i / 500);
      assert.ok(x >= -1 && x <= 1, `${shape} in range`);
      jump = Math.max(jump, Math.abs(x - modValue(m, (i + 1) / 500)));
    }
    // No step from one sample to the next that would click: every edge is ramped.
    assert.ok(jump < 0.2, `${shape} has no hard edge: ${jump}`);
  }
  const r = { target: "cutoff" as const, shape: "random" as const, beats: 1, depth: 1 };
  assert.equal(modValue(r, 3.2), modValue(r, 3.9));
  assert.notEqual(modValue(r, 3.5), modValue(r, 4.5));
  assert.notEqual(modValue(r, 3.5, 0), modValue(r, 3.5, 1));
  const saw = { target: "cutoff" as const, shape: "saw" as const, beats: 4, depth: 1 };
  assert.ok(modValue(saw, 0.1) < modValue(saw, 2) && modValue(saw, 2) < modValue(saw, 3.8));
});

test("band-pass and high-pass keep the lows out; low-pass keeps them", () => {
  const share = (type: Patch["filter"]["type"]) => bandShare(cut(render({ ...BASE, filter: { ...BASE.filter, type, cutoff: 2000 } }, [note(0, 1, 33)], 1.2), 0.1, 1), SR, 0, 400);
  const low = share("low");
  const band = share("band");
  const high = share("high");
  assert.ok(low > 0.7, `low-pass: ${low}`);
  assert.ok(band < 0.25, `band-pass: ${band}`);
  assert.ok(high < 0.03, `high-pass: ${high}`);
  // And a band-pass keeps the top out as well, where a high-pass does not.
  const top = (type: Patch["filter"]["type"]) => bandShare(cut(render({ ...BASE, filter: { ...BASE.filter, type, cutoff: 800, q: 3 } }, [note(0, 1, 33)], 1.2), 0.1, 1), SR, 4000, Infinity);
  assert.ok(top("band") < 0.1 * top("high"), `tops: band ${top("band")}, high ${top("high")}`);
});

test("FM and drive add harmonics to a sine, and noise is unpitched", () => {
  const sine: Patch = { ...BASE, osc: { wave: "sine", voices: 1, detune: 0 }, filter: { ...BASE.filter, cutoff: 16000 } };
  const above = (p: Patch) => bandShare(cut(render(p, [note(0, 1, 57)], 1.2), 0.1, 1), SR, 660, Infinity);
  const plain = above(sine);
  const fm = above({ ...sine, osc: { ...sine.osc, fm: { ratio: 2, amount: 2 } } });
  const driven = above({ ...sine, drive: 4 });
  assert.ok(plain < 0.001, `a sine is its fundamental: ${plain}`);
  assert.ok(fm > 0.15, `FM: ${fm}`);
  assert.ok(driven > 0.02, `drive: ${driven}`);
  // An FM amount that decays leaves the plain sine behind.
  const struck = render({ ...sine, osc: { ...sine.osc, fm: { ratio: 2, amount: 3, decay: 0.05 } } }, [note(0, 1, 57)], 1.2);
  const [early, late] = [bandShare(cut(struck, 0, 0.05), SR, 660, Infinity), bandShare(cut(struck, 0.6, 1), SR, 660, Infinity)];
  assert.ok(early > 0.1 && late < 0.001, `struck FM: ${early} early, ${late} late`);
  // Drive never pushes a note past its level.
  const loudest = peak(render({ ...sine, drive: 8, level: 0.5 }, [note(0, 0.5, 57, { vel: 127 })], 0.7));
  assert.ok(loudest <= 0.5, `driven peak: ${loudest}`);
  const hiss: Patch = { ...BASE, osc: { wave: "noise", voices: 1, detune: 0 }, filter: { ...BASE.filter, cutoff: 16000 } };
  const a = render(hiss, [note(0, 0.5, 40)], 0.6);
  assert.ok(rms(a) > 0.01 && bandShare(a, SR, 2000, Infinity) > 0.7, `noise: ${rms(a)}, ${bandShare(a, SR, 2000, Infinity)}`);
});

test("a slide on a patch with glide comes in from the note before, and an accent opens the filter", () => {
  const tone: Patch = { ...BASE, osc: { wave: "sine", voices: 1, detune: 0 }, filter: { ...BASE.filter, cutoff: 16000 }, glide: 0.05 };
  const before = note(0, 0.25, 72);
  const slid = render(tone, [before, note(0.3, 0.5, 84, { gesture: "slide", curves: { bend: [[0, -2], [0.1, 0]] } })], 1);
  const plain = render(tone, [before, note(0.3, 0.5, 84)], 1);
  // C6 is 1046.5 Hz, C5 half that. The slide starts near C5 and arrives; the plain note starts on pitch.
  assert.ok(Math.abs(pitch(cut(plain, 0.3, 0.33)) - 1046.5) < 40, `plain: ${pitch(cut(plain, 0.3, 0.33))}`);
  const early = pitch(cut(slid, 0.3, 0.33));
  assert.ok(early > 550 && early < 900, `sliding: ${early}`);
  assert.ok(Math.abs(pitch(cut(slid, 0.6, 0.8)) - 1046.5) < 10, `arrived: ${pitch(cut(slid, 0.6, 0.8))}`);
  // Without glide the slide is the note's curve, as for a GM program: it starts two semitones under.
  const { glide: _, ...fixed } = tone;
  const bent = pitch(cut(render(fixed, [before, note(0.3, 0.5, 84, { gesture: "slide", curves: { bend: [[0, -2], [0.1, 0]] } })], 1), 0.3, 0.33));
  assert.ok(bent > 930 && bent < 1040, `bent: ${bent}`);

  const acid: Patch = { ...BASE, filter: { ...BASE.filter, cutoff: 200, q: 2, env: 800, d: 0.15, s: 0 }, accent: { cutoff: 3000, q: 4 } };
  const top = (more: Partial<ScoreNote>) => bandShare(render(acid, [note(0, 0.3, 36, more)], 0.5), SR, 800, Infinity);
  assert.ok(top({ gesture: "accent" }) > 4 * top({}), `accent: ${top({ gesture: "accent" })} against ${top({})}`);
});

test("spread is stereo that sums to the mono sound; pan and width modulators move it", () => {
  const mono: Patch = { ...BASE, osc: { wave: "saw", voices: 3, detune: 12 } };
  const wide: Patch = { ...mono, osc: { ...mono.osc, spread: 0.8 } };
  const m = render(mono, [note(0, 1, 57)], 1.2);
  const w = render(wide, [note(0, 1, 57)], 1.2);
  assert.deepEqual(m.l, m.r);
  let differ = 0;
  let sum = 0;
  for (let i = 0; i < w.l.length; i++) {
    differ = Math.max(differ, Math.abs(w.l[i]! - w.r[i]!));
    sum = Math.max(sum, Math.abs((w.l[i]! + w.r[i]!) / 2 - m.l[i]!));
  }
  assert.ok(differ > 0.05, `left and right differ: ${differ}`);
  assert.ok(sum < 1e-6, `the sum is the mono voice: ${sum}`);

  // Pan, one cycle a beat: left is loud where right is quiet.
  const panned = render({ ...BASE, mod: [{ target: "pan", shape: "sine", beats: 1, depth: 0.8 }] }, [note(0, 2, 57)], 2.2);
  const hop = (BEAT * SR) / 48;
  const side = (ch: "l" | "r") => envelope({ l: panned[ch], r: panned[ch] }, hop).slice(8, 180);
  assert.ok(correlation(side("l"), side("r")) < -0.9, `pan: ${correlation(side("l"), side("r"))}`);
  // Width: the difference between the channels comes and goes, the sum does not.
  const breathing = render({ ...wide, mod: [{ target: "width", shape: "sine", beats: 1, depth: 1 }] }, [note(0, 2, 57)], 2.2);
  const diff = stereo(breathing.l.length);
  for (let i = 0; i < diff.l.length; i++) diff.l[i] = diff.r[i] = breathing.l[i]! - breathing.r[i]!;
  const narrow = rms(cut(diff, 0.75 * BEAT - 0.03, 0.75 * BEAT + 0.03));
  const full = rms(cut(diff, 0.25 * BEAT - 0.03, 0.25 * BEAT + 0.03));
  assert.ok(full > 5 * narrow, `width: ${full} against ${narrow}`);
});

test("amp and pw modulators: a square gate chops the note, pulse width moves the tone", () => {
  const gated = render({ ...BASE, mod: [{ target: "amp", shape: "square", beats: 1, depth: 1 }] }, [note(0, 2, 45)], 2.2);
  assert.ok(rms(cut(gated, 0.3, 0.45)) < 0.01 * rms(cut(gated, 0.05, 0.2)), "second half of each beat is silent");
  const pulse: Patch = { ...BASE, osc: { wave: "pulse", pw: 0.5, voices: 1, detune: 0 }, filter: { ...BASE.filter, cutoff: 8000 } };
  const still = render(pulse, [note(0, 2, 45)], 2.2);
  const moving = render({ ...pulse, mod: [{ target: "pw", shape: "sine", beats: 2, depth: 0.35 }] }, [note(0, 2, 45)], 2.2);
  // A square has no second harmonic (220 Hz for this A); a narrower pulse does.
  const second = (s: Stereo) => partial(cut(s, 0.2, 0.3), 220) / partial(cut(s, 0.2, 0.3), 110);
  assert.ok(second(still) < 0.02 && second(moving) > 0.5, `second harmonic: ${second(still)} still, ${second(moving)} moving`);
});
