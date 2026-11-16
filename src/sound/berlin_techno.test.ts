/**
 * Berlin techno, Claudia's second style: the corpus is valid, its sounds
 * measure as what they are meant to be, a set travels between it and minimal
 * techno within the set's rules, and a whole track through the worker mixes
 * near minimal techno's level with a heavier low end.
 *
 * Nobody listened while it was written, so the numbers here are the ears.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROLES, type Role } from "../corpus/constants.js";
import type { Kit } from "../corpus/patch.js";
import type { StyleBundle } from "../corpus/schema.js";
import { validateCorpus } from "../corpus/validate.js";
import { velocityScale } from "../engine/parts.js";
import type { PieceOptions } from "../engine/piece.js";
import { MAX_TEMPO_STEP, PHRASE_BARS, SetConductor } from "../engine/set.js";
import type { Bar } from "../engine/types.js";
import { type ModeName, keysCompatible, pitchClass } from "../theory/theory.js";
import { type Stereo, stereo } from "./dsp.js";
import { lowCorrelation, measureWeight } from "./measure.js";
import { stemMoves } from "./moves.js";
import type { ToStems, ToWorker } from "./protocol.js";
import { barScore } from "./score.js";
import { partLevels, styleSound } from "./sound_set.js";
import { type SoundSet, renderSynthNote } from "./synth.js";
import type { ScoreNote } from "./types.js";

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const BERLIN = claudia.find((s) => s.id === "berlin_techno")!;
const MINIMAL = claudia.find((s) => s.id === "minimal_techno")!;
const corpus = BERLIN.corpus;
const SOUND = styleSound(corpus)!;
const KIT = corpus.synthKit!;

const SR = 48000;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const round = (x: number, digits = 2) => Number(x.toFixed(digits));
const numbers: Record<string, Record<string, number>> = {};

// --- The corpus --------------------------------------------------------------

test("the corpus is valid with no warnings, and is a Claudia style: parts, groups, a cap, moves, patches, a kit", () => {
  const v = validateCorpus(JSON.parse(readFileSync("styles/berlin_techno/corpus.json", "utf8")));
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  assert.deepEqual(v.warnings, []);
  const parts = corpus.parts!;
  assert.ok(parts.length >= 10 && parts.length <= 15, `${parts.length} parts`);
  assert.ok(parts.some((p) => p.roll) && corpus.moves?.build === 1, "a build with a roll before every drop");
  // Stricter than minimal techno: fewer parts at once, fewer pitched lines, and no more noise layers.
  const a = corpus.arrangement!;
  const m = MINIMAL.corpus.arrangement!;
  assert.ok(a.most! < m.most! && a.groups!.line! < m.groups!.line! && a.groups!.noise! <= m.groups!.noise!);
  assert.ok(parts.filter((p) => p.group === "noise").length < MINIMAL.corpus.parts!.filter((p) => p.group === "noise").length);
  // Every part but the drums plays a patch of the style's own, and none is one of minimal techno's.
  for (const p of parts) if (p.role !== "drums") assert.ok(corpus.patches!.some((x) => x.id === p.patch), p.id);
  for (const p of corpus.patches!) for (const q of MINIMAL.corpus.patches!) assert.notDeepEqual({ ...p, id: "" }, { ...q, id: "" }, `${p.id} is ${q.id}`);
  assert.notDeepEqual(KIT, MINIMAL.corpus.synthKit);
  assert.ok(KIT.rumble && KIT.kick.sub && KIT.ride && KIT.perc?.some((p) => p.tuned));
  // Long sections, a breakdown without the low end, a peak; every form long enough to play once through.
  for (const f of corpus.forms) {
    assert.ok(f.sections.every((s) => s.bars === 16 || s.bars === 32), f.id);
    assert.ok(f.sections.some((s) => !s.roles.includes("bass")), `${f.id} has a breakdown`);
    assert.ok(f.sections.some((s) => s.intensity >= 0.85), `${f.id} has a peak`);
    assert.ok(f.sections.reduce((n, s) => n + s.bars, 0) >= 112, f.id);
  }
});

test("tempo and keys: the range meets minimal techno's, and the keys are near each other and near minimal techno's", () => {
  assert.deepEqual(corpus.tempo, { min: 130, max: 138 });
  assert.equal(corpus.beatsPerBar, 4);
  assert.equal(corpus.swing, 0);
  assert.ok(corpus.tempo.min <= MINIMAL.corpus.tempo.max, "the ranges overlap");
  const key = (k: { tonic: string; mode: string }) => ({ tonic: pitchClass(k.tonic), mode: k.mode as ModeName });
  const mine = corpus.keys.map(key);
  const theirs = MINIMAL.corpus.keys.map(key);
  assert.ok(corpus.keys.every((k) => k.mode === "aeolian" || k.mode === "phrygian"));
  let across = 0;
  for (const k of mine) {
    assert.ok(mine.filter((o) => keysCompatible(k, o)).length >= 4, `${JSON.stringify(k)} has neighbours of its own`);
    if (theirs.some((o) => keysCompatible(k, o))) across++;
  }
  // And every key of minimal techno has one of these to go to.
  for (const k of theirs) assert.ok(mine.some((o) => keysCompatible(k, o)), JSON.stringify(k));
  assert.ok(across >= 10, `${across} of ${mine.length} keys are near one of minimal techno's`);
});

// --- A set over both styles ----------------------------------------------------

test("a set over both styles: both play, every change keeps tempo and key, and the grid's limits hold", () => {
  const { most, groups } = corpus.arrangement!;
  const groupOf = new Map(corpus.parts!.map((p) => [p.id, p.group]));
  const tracks: { style: string; bpm: number; key: { tonic: number; mode: ModeName }; bars: number }[] = [];
  const seen = new Set<string>();
  let fullest = 0;
  let builds = 0;
  for (const seed of ["berlin-a", "berlin-b", "berlin-c"]) {
    const c = new SetConductor([MINIMAL, BERLIN], seed);
    let last = -1;
    let before: (typeof tracks)[number] | undefined;
    for (let i = 0; i < 3000; i++) {
      const bar = c.nextBar();
      const info = bar.info;
      if (info.pieceIndex !== last) {
        last = info.pieceIndex;
        assert.equal(i % PHRASE_BARS, 0, "a track starts on a phrase");
        // (The bar's own tempo may be part way through the ramp from the track before: the track's is its plan's.)
        const track = { style: info.styleId, bpm: c.trackPlan(info.pieceIndex)!.bpm, key: { tonic: info.tonic, mode: info.mode }, bars: info.pieceBars };
        if (before) {
          assert.ok(Math.abs(track.bpm / before.bpm - 1) <= MAX_TEMPO_STEP + 1e-9, `${seed}: ${before.bpm} to ${track.bpm}`);
          assert.ok(keysCompatible(track.key, before.key), `${seed}: ${JSON.stringify(before.key)} to ${JSON.stringify(track.key)}`);
        }
        tracks.push(track);
        before = track;
      }
      if (info.styleId !== "berlin_techno") continue;
      const on = info.parts!;
      for (const id of on) seen.add(id);
      fullest = Math.max(fullest, on.length);
      assert.ok(on.length <= most!, `${seed} bar ${i}: ${on.length} parts: ${on}`);
      for (const [group, limit] of Object.entries(groups!)) assert.ok(on.filter((id) => groupOf.get(id) === group).length <= limit, `${seed} bar ${i}: ${group}: ${on}`);
      // The kick is out only in a build, or in a breakdown, where the sub is out too.
      if (!on.includes("kick")) assert.ok(info.build !== undefined || !on.includes("sub"), `${seed} bar ${i}: ${on}`);
      if (info.build?.bar === 0) {
        builds++;
        assert.ok(!on.includes("kick") && on.includes("roll"), "a build: kick out, roll in");
      }
      // The ride waits for a hot section.
      if (on.includes("ride")) assert.ok(info.intensity >= 0.8 - 1e-9, `ride at ${info.intensity}`);
    }
  }
  const berlin = tracks.filter((t) => t.style === "berlin_techno");
  const minimal = tracks.filter((t) => t.style === "minimal_techno");
  const tempos = (ts: typeof tracks) => `${Math.min(...ts.map((t) => t.bpm))} to ${Math.max(...ts.map((t) => t.bpm))} bpm`;
  console.log(`a set over both styles, 3 seeds of 3000 bars: ${berlin.length} Berlin techno tracks (${tempos(berlin)}), ${minimal.length} minimal techno (${tempos(minimal)}); parts in at most ${fullest}; ${builds} builds`);
  assert.ok(berlin.length >= 8 && minimal.length >= 8, "both styles play");
  assert.equal(fullest, most, "the cap is reached somewhere");
  assert.ok(builds >= berlin.length / 2, "most tracks have a build");
  assert.deepEqual([...seen].sort(), corpus.parts!.map((p) => p.id).sort(), "every part is heard");
});

// --- The sounds, measured ------------------------------------------------------

const cut = (s: Stereo, from: number, to: number): Stereo => ({ l: s.l.slice(Math.round(from * SR), Math.round(to * SR)), r: s.r.slice(Math.round(from * SR), Math.round(to * SR)) });
const rms = (s: Stereo, from = 0, to = s.l.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return Math.sqrt(e / (2 * Math.max(1, to - from)));
};
const peak = (s: Stereo) => s.l.reduce((m, x, i) => Math.max(m, Math.abs(x), Math.abs(s.r[i]!)), 0);
const minus = (a: Stereo, b: Stereo): Stereo => ({ l: a.l.map((x, i) => x - b.l[i]!), r: a.r.map((x, i) => x - b.r[i]!) });

/** Power per frequency bin of a channel (radix-2 FFT, zero-padded), and the bin width in Hz. */
function spectrum(x: Float32Array): { power: Float64Array; hz: number } {
  let n = 1;
  while (n < x.length) n *= 2;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j]!, re[i]!];
  }
  for (let len = 2; len <= n; len *= 2) {
    const wr = Math.cos((2 * Math.PI) / len);
    const wi = -Math.sin((2 * Math.PI) / len);
    for (let at = 0; at < n; at += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = at + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  const power = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) power[i] = re[i]! ** 2 + im[i]! ** 2;
  return { power, hz: SR / n };
}

/** Share of the energy between `lo` and `hi` Hz. */
function share(s: Stereo, lo: number, hi: number): number {
  let inside = 0;
  let total = 0;
  for (const ch of [s.l, s.r]) {
    const { power, hz } = spectrum(ch);
    for (let i = 0; i < power.length; i++) {
      total += power[i]!;
      if (i * hz >= lo && i * hz < hi) inside += power[i]!;
    }
  }
  return total > 0 ? inside / total : 0;
}

/** Seconds from the loudest 5 ms window until the level has stayed `drop` dB under it. */
function ringTime(s: Stereo, drop = 20): number {
  const hop = Math.round(0.005 * SR);
  const env: number[] = [];
  for (let at = 0; at + hop <= s.l.length; at += hop) env.push(rms(s, at, at + hop));
  const top = Math.max(...env);
  const from = env.indexOf(top);
  let last = from;
  for (let i = from; i < env.length; i++) if (db(env[i]! / top) > -drop) last = i;
  return ((last + 1 - from) * hop) / SR;
}

/** Cheap brightness: the mean frequency weighted by energy. */
function brightness(s: Stereo): number {
  let a = 0;
  let b = 0;
  for (let i = 1; i < s.l.length; i++) {
    a += (s.l[i]! - s.l[i - 1]!) ** 2;
    b += s.l[i]! ** 2;
  }
  return (Math.sqrt(a / Math.max(b, 1e-20)) * SR) / (2 * Math.PI);
}

function correlation(s: Stereo): number {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < s.l.length; i++) {
    lr += s.l[i]! * s.r[i]!;
    ll += s.l[i]! ** 2;
    rr += s.r[i]! ** 2;
  }
  return lr / Math.sqrt(ll * rr);
}

/** How far the sound sits to the left (positive) or right, dB. */
const lean = (s: Stereo) => db(rms({ l: s.l, r: s.l }) / rms({ l: s.r, r: s.r }));

const drumNote = (t: number, key: number, more: Partial<ScoreNote> = {}): ScoreNote => ({ t, dur: 0.1, key, vel: 110, ch: 9, role: "drums", program: 0, ...more });

function render(notes: ScoreNote[], seconds: number, sound: SoundSet = SOUND): Stereo {
  const out = stereo(Math.round(seconds * SR));
  notes.forEach((n, i) => renderSynthNote(out, n, SR, "none", notes[i - 1], false, sound));
  return out;
}

/** A patch as its part plays it, at 134 BPM: `pos` is where in the track the note starts, in beats. */
const BEAT = 60 / 134;
function play(patch: string, role: Role, keys: number[], dur: number, seconds: number, pos = 0): Stereo {
  return render(keys.map((key) => ({ t: 0.01, dur, key, vel: 100, ch: 0, role, program: 90, patch, beat: BEAT, pos })), seconds);
}

/** Four on the floor at `bpm`, with the rumble (`both`), without (`kick`), and the rumble alone (`wet`). */
function floor(kit: Kit, bpm: number) {
  const beat = 60 / bpm;
  const { rumble: _, ...dry } = kit;
  const hits = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => drumNote(i * beat, 36));
  const both = render(hits, 8 * beat + 2, { kit });
  const kick = render(hits, 8 * beat + 2, { kit: dry });
  const wet = minus(both, kick);
  // The seventh beat: its first 40 ms are the punch, its last quarter the gap before the next kick.
  const punch = (s: Stereo) => rms(cut(s, 6 * beat, 6 * beat + 0.04));
  const gap = (s: Stereo) => rms(cut(s, 6.75 * beat, 7 * beat));
  return {
    beat,
    both,
    wet,
    levelDb: db(rms(cut(wet, 6 * beat, 7 * beat)) / rms(cut(kick, 6 * beat, 7 * beat))),
    onPunchDb: db(punch(wet) / punch(kick)),
    gapDb: db(gap(wet) / gap(kick)),
    // What is left in the gap against the punch of the kick: how far the low end breathes.
    gapUnderPunchDb: db(gap(both) / punch(both)),
    below60: share(cut(both, 4 * beat, 8 * beat), 0, 60),
  };
}

test("kick: deeper and duller than minimal techno's, mono, and gone before the next one", () => {
  const { rumble: _, ...dry } = KIT;
  const { rumble: __, ...theirs } = MINIMAL.corpus.synthKit!;
  const kick = render([drumNote(0, 36)], 1.5, { kit: dry });
  const other = render([drumNote(0, 36)], 1.5, { kit: theirs });
  const m = (numbers.kick = {
    below60: round(share(kick, 0, 60)),
    below120: round(share(kick, 0, 120)),
    above1k: round(share(kick, 1000, Infinity), 4),
    minimalAbove1k: round(share(other, 1000, Infinity), 4),
    ringSeconds: round(ringTime(kick)),
    peak: round(peak(kick)),
  });
  assert.ok(m.below60 > 0.5 && m.below120 > 0.9, JSON.stringify(m));
  assert.ok(m.below120 > share(other, 0, 120), "more of it is low than minimal techno's");
  assert.ok(m.above1k < m.minimalAbove1k, "and less of it is click");
  assert.ok(m.ringSeconds < 60 / 138, `it is gone by the next kick at 138 BPM: ${m.ringSeconds} s`);
  assert.ok(m.peak < 1);
  assert.deepEqual(kick.l, kick.r);
});

test("rumble: a sub wall between kicks that leaves the punch alone, across the tempo range", () => {
  const theirs = floor(MINIMAL.corpus.synthKit!, 130);
  const m: Record<string, number> = (numbers.rumble = {});
  for (const bpm of [129, 134, 139]) {
    const f = floor(KIT, bpm);
    m[`levelDb${bpm}`] = round(f.levelDb, 1);
    m[`onPunchDb${bpm}`] = round(f.onPunchDb, 1);
    m[`gapDb${bpm}`] = round(f.gapDb, 1);
    m[`gapUnderPunchDb${bpm}`] = round(f.gapUnderPunchDb, 1);
    assert.ok(f.levelDb > -9 && f.levelDb < -3, `${bpm}: level under the kick ${f.levelDb} dB`);
    assert.ok(f.onPunchDb < -10, `${bpm}: on the punch ${f.onPunchDb} dB`);
    assert.ok(f.gapDb > 2, `${bpm}: in the gap it is louder than what is left of the kick: ${f.gapDb} dB`);
    assert.ok(f.gapUnderPunchDb < -5, `${bpm}: the low end still falls before the next kick: ${f.gapUnderPunchDb} dB`);
    // Fuller between kicks than minimal techno's, which is the point of the style.
    assert.ok(f.gapUnderPunchDb > theirs.gapUnderPunchDb + 3, `${bpm}: ${f.gapUnderPunchDb} dB against minimal techno's ${theirs.gapUnderPunchDb} dB`);
    assert.deepEqual(f.wet.l, f.wet.r);
  }
  const f = floor(KIT, 134);
  m.below150 = round(share(cut(f.wet, 4 * f.beat, 8 * f.beat), 0, 150), 3);
  m.above300 = round(share(cut(f.wet, 4 * f.beat, 8 * f.beat), 300, Infinity), 4);
  m.barBelow60 = round(f.below60);
  m.minimalBarBelow60 = round(theirs.below60);
  m.minimalGapUnderPunchDb = round(theirs.gapUnderPunchDb, 1);
  m.tailSeconds = round(ringTime(cut(f.wet, 7 * f.beat, 8 * f.beat + 2), 30));
  m.peak = round(peak(f.both));
  assert.ok(m.below150 > 0.97 && m.above300 < 0.01, JSON.stringify(m));
  assert.ok(m.barBelow60 > m.minimalBarBelow60, "more of a bar is under 60 Hz than in minimal techno");
  assert.ok(m.tailSeconds < 1, `it dies away after the last kick: ${m.tailSeconds} s`);
  assert.ok(m.peak < 1.2, `kick and rumble together: ${m.peak}`);
});

test("the rest of the kit: hats above 6 kHz, a roomy clap, a ride for eighths, toms on the key, a metal tick", () => {
  const one = (key: number, seconds: number, more: Partial<ScoreNote> = {}) => render([drumNote(0.01, key, more)], seconds);
  const closed = one(42, 0.6);
  const open = one(46, 1.5);
  const clap = one(39, 1.5);
  const ride = one(51, 3);
  const tick = one(37, 0.6);
  const low = one(45, 2);
  const high = one(50, 2);
  const m = (numbers.kit = {
    hatAbove6k: round(share(closed, 6000, Infinity), 3),
    hatBelow3k: round(share(closed, 0, 3000), 5),
    hatRing: round(ringTime(closed), 3),
    openRing: round(ringTime(open), 3),
    clapBand: round(share(clap, 500, 3000)),
    clapRing: round(ringTime(clap)),
    rideAbove4k: round(share(ride, 4000, Infinity)),
    rideRing: round(ringTime(ride)),
    tickBand: round(share(tick, 800, 8000), 3),
    tickBelow500: round(share(tick, 0, 500), 4),
    tickRing: round(ringTime(tick), 3),
    tomLowOn110: round(share(cut(low, 0.1, 0.5), 98, 123)),
    tomHighOn165: round(share(cut(high, 0.1, 0.5), 147, 185)),
    tomLowRing: round(ringTime(low)),
    tomBelow60: round(share(low, 0, 60), 3),
  });
  assert.ok(m.hatAbove6k > 0.9 && m.hatBelow3k < 0.001 && m.hatRing <= 0.06, JSON.stringify(m));
  assert.ok(m.openRing > 3 * m.hatRing && m.openRing < 60 / 138, `open hat: ${m.openRing} s`);
  assert.ok(m.clapBand > 0.8 && m.clapRing > 0.25 && m.clapRing < 60 / 138, JSON.stringify(m));
  assert.ok(m.rideAbove4k > 0.9 && m.rideRing > 0.4 && m.rideRing < 1, JSON.stringify(m));
  assert.ok(m.tickBand > 0.8 && m.tickBelow500 < 0.01 && m.tickRing < 0.12, JSON.stringify(m));
  assert.ok(m.tomLowOn110 > 0.9 && m.tomHighOn165 > 0.9, "the toms are the root and the fifth of a track on A");
  assert.ok(m.tomLowRing < 60 / 138 && m.tomBelow60 < 0.02, "short, and above the rumble");
  // On E the low tom is a fourth down, at 82 Hz.
  assert.ok(share(cut(one(45, 2, { tonic: 4 }), 0.1, 0.5), 74, 92) > 0.9);
});

test("sub: a mono, nearly pure thud or drone in the octave above the rumble", () => {
  // The bass part's notes lie from B1 to B flat 2.
  const m: Record<string, number> = (numbers.sub = {});
  for (const key of [35, 40, 46]) {
    const hz = 440 * Math.pow(2, (key - 69) / 12);
    const note = play("sub", "bass", [key], 2 * BEAT, 2);
    assert.deepEqual(note.l, note.r);
    m[`fundamental${key}`] = round(share(cut(note, 0.1, 0.8), hz / 1.3, hz * 1.3));
    assert.ok(m[`fundamental${key}`]! > 0.8, `key ${key}: ${m[`fundamental${key}`]}`);
  }
  const held = play("sub", "bass", [40], 8 * BEAT, 5);
  m.above300 = round(share(held, 300, Infinity), 4);
  m.heldDb = round(db(rms(cut(held, 2, 3)) / rms(cut(held, 0.1, 0.4))), 1);
  m.lowCorrelation = round(lowCorrelation(held, SR), 3);
  m.peak = round(peak(held));
  assert.ok(m.above300 < 0.02, `dull: ${m.above300} above 300 Hz`);
  assert.ok(m.heldDb > -6, `a held note stays: ${m.heldDb} dB after two seconds`);
  assert.equal(m.lowCorrelation, 1);
  assert.ok(m.peak < 1);
});

test("stab: dark, wide, and with a tail of its own that outlasts minimal techno's stab", () => {
  const stab = play("stab", "comp", [57, 60, 64], 0.3 * BEAT, 3);
  const theirs = render([57, 60, 64].map((key) => ({ t: 0.01, dur: 0.3 * BEAT, key, vel: 100, ch: 0, role: "comp" as Role, program: 90, patch: "stab", beat: BEAT, pos: 0 })), 3, styleSound(MINIMAL.corpus)!);
  const m = (numbers.stab = {
    below150: round(share(stab, 0, 150), 3),
    band150to2k: round(share(stab, 150, 2000), 3),
    above2k: round(share(stab, 2000, Infinity), 3),
    brightStart: round(brightness(cut(stab, 0.012, 0.04)), 0),
    brightTail: round(brightness(cut(stab, 0.3, 0.5)), 0),
    ringSeconds: round(ringTime(stab)),
    minimalRingSeconds: round(ringTime(theirs)),
    minimalAbove2k: round(share(theirs, 2000, Infinity), 3),
    correlation: round(correlation(stab)),
    peak: round(peak(stab)),
  });
  assert.ok(m.below150 < 0.05 && m.band150to2k > 0.9, JSON.stringify(m));
  assert.ok(m.above2k < m.minimalAbove2k / 4, `darker than minimal techno's: ${m.above2k} against ${m.minimalAbove2k} above 2 kHz`);
  assert.ok(m.brightStart > 1.5 * m.brightTail, `the filter closes: ${m.brightStart} Hz to ${m.brightTail} Hz`);
  assert.ok(m.ringSeconds > 0.4 && m.ringSeconds < 1.2 && m.ringSeconds > 2 * m.minimalRingSeconds, `it rings ${m.ringSeconds} s, minimal techno's ${m.minimalRingSeconds} s`);
  assert.ok(m.correlation > 0.2 && m.correlation < 0.98, `stereo, not out of phase: ${m.correlation}`);
  assert.ok(m.peak < 1);
});

test("tone and bell: one struck inharmonic note in the low mids, and a small bell above that rings and moves", () => {
  const tone = play("tone", "arp", [45], 0.3 * BEAT, 2);
  const bell = (pos: number) => play("bell", "arp", [76], 1.5 * BEAT, 3, pos);
  const leans = [0.5, 4.5, 8.5, 12.5, 16.5, 20.5].map((pos) => round(lean(bell(pos)), 1));
  // Inharmonic: the loudest partial is not the note (110 Hz) or a whole multiple of it.
  const { power, hz } = spectrum(tone.l);
  let top = 0;
  for (let i = 0; i < power.length; i++) if (power[i]! > power[top]!) top = i;
  const ratio = (top * hz) / 110;
  const m = (numbers.toneAndBell = {
    toneBelow150: round(share(tone, 0, 150), 3),
    toneBand150to2k: round(share(tone, 150, 2000), 3),
    toneLoudestPartial: round(ratio),
    toneRing: round(ringTime(tone)),
    toneBrightStart: round(brightness(cut(tone, 0.012, 0.04)), 0),
    toneBrightTail: round(brightness(cut(tone, 0.2, 0.4)), 0),
    tonePeak: round(peak(tone)),
    bellBelow400: round(share(bell(0.5), 0, 400), 4),
    bellBand600to6k: round(share(bell(0.5), 600, 6000), 3),
    bellRing: round(ringTime(bell(0.5))),
    bellLeanSpreadDb: round(Math.max(...leans) - Math.min(...leans), 1),
    bellPeak: round(peak(bell(0.5))),
  });
  assert.ok(m.toneBelow150 < 0.02 && m.toneBand150to2k > 0.95, JSON.stringify(m));
  assert.ok(Math.abs(m.toneLoudestPartial - Math.round(m.toneLoudestPartial)) > 0.2, `partial at ${m.toneLoudestPartial} times the note`);
  assert.ok(m.toneRing > 0.15 && m.toneRing < 0.5 && m.toneBrightStart > 1.5 * m.toneBrightTail, JSON.stringify(m));
  assert.ok(m.bellBelow400 < 0.01 && m.bellBand600to6k > 0.95, JSON.stringify(m));
  assert.ok(m.bellRing > 0.7 && m.bellRing < 2, `the bell rings ${m.bellRing} s`);
  assert.ok(m.bellLeanSpreadDb > 3 && new Set(leans).size > 3, `it lands somewhere else each bar: ${leans} dB left`);
  assert.ok(m.tonePeak > 0.05 && m.tonePeak < 1 && m.bellPeak < 1);
});

test("drone and wash: slow, out of the low end, and moving over many bars", () => {
  // A power chord on A2, as the drone's patterns voice it; the wash is noise, whatever the keys.
  const keys = [45, 52, 57];
  const at = (patch: string, pos: number) => cut(play(patch, "pad", keys, 4, 4.5, pos - 3 / BEAT), 2.5, 3.5);
  const drone = play("drone", "pad", keys, 6, 12);
  const wash = play("wash", "pad", keys, 6, 12);
  const pad = render(keys.map((key) => ({ t: 0.01, dur: 6, key: key + 12, vel: 100, ch: 0, role: "pad" as Role, program: 89, patch: "pad", beat: BEAT, pos: 0 })), 12, styleSound(MINIMAL.corpus)!);
  const { power } = spectrum(cut(wash, 3, 6).l);
  const m = (numbers.droneAndWash = {
    droneBelow100: round(share(cut(drone, 3, 6), 0, 100), 3),
    droneBand150to600: round(share(cut(drone, 3, 6), 150, 600), 3),
    droneAbove2k: round(share(cut(drone, 3, 6), 2000, Infinity), 4),
    droneBrightness: round(brightness(cut(drone, 3, 6)), 0),
    minimalPadBrightness: round(brightness(cut(pad, 3, 6)), 0),
    droneAttackDb: round(db(rms(cut(drone, 0.01, 0.21)) / rms(cut(drone, 3, 6))), 1),
    droneReleaseSeconds: round(ringTime(cut(drone, 6, 12)), 2),
    droneCorrelation: round(correlation(cut(drone, 3, 6))),
    // The drone's filter moves over 96 beats: most open 24 beats in, most closed 72 beats in.
    droneBrightOpen: round(brightness(at("drone", 24)), 0),
    droneBrightShut: round(brightness(at("drone", 72)), 0),
    dronePeak: round(peak(drone)),
    washBelow200: round(share(cut(wash, 3, 6), 0, 200), 4),
    washAttackDb: round(db(rms(cut(wash, 0.01, 0.21)) / rms(cut(wash, 3, 6))), 1),
    // The wash's band climbs through 32 beats and starts again.
    washBrightEarly: round(brightness(at("wash", 3)), 0),
    washBrightLate: round(brightness(at("wash", 30)), 0),
    washPeakOverMean: round(power.reduce((a, x) => Math.max(a, x), 0) / (power.reduce((a, x) => a + x, 0) / power.length), 0),
    washPeak: round(peak(wash)),
  });
  assert.ok(m.droneBelow100 < 0.02 && m.droneBand150to600 > 0.6 && m.droneAbove2k < 0.01, JSON.stringify(m));
  assert.ok(m.droneBrightness < 0.7 * m.minimalPadBrightness, `darker than minimal techno's pad: ${m.droneBrightness} Hz against ${m.minimalPadBrightness} Hz`);
  assert.ok(m.droneAttackDb < -12 && m.droneReleaseSeconds > 1, `slow in and out: ${m.droneAttackDb} dB, ${m.droneReleaseSeconds} s`);
  assert.ok(m.droneCorrelation > 0.2 && m.droneCorrelation < 0.9, `wide, not out of phase: ${m.droneCorrelation}`);
  assert.ok(m.droneBrightOpen > 1.3 * m.droneBrightShut, `it barely moves, but it moves: ${m.droneBrightOpen} Hz to ${m.droneBrightShut} Hz`);
  assert.ok(m.washBelow200 < 0.01 && m.washAttackDb < -12, JSON.stringify(m));
  assert.ok(m.washBrightLate > 1.5 * m.washBrightEarly, `the wash climbs through the phrase: ${m.washBrightEarly} Hz to ${m.washBrightLate} Hz`);
  assert.ok(m.washPeakOverMean < 2000, `noise, not a tone: ${m.washPeakOverMean}`);
  assert.ok(m.dronePeak < 1 && m.washPeak < 1);
  console.log("measured:", JSON.stringify(numbers, null, 1));
});

// --- A whole track through the worker --------------------------------------------

// The worker is a module worker: it listens on `self`. (As in worker.test.ts.)
const WSR = 24000;
const FLOOR = 0.42;
const scope: { onmessage: ((e: { data: ToWorker }) => void) | null } = { onmessage: null };
(globalThis as unknown as { self: typeof scope }).self = scope;
await import("./worker.js");
let posted: ToStems[] = [];
let cleared: (() => void) | null = null;
const port = {
  postMessage(msg: ToStems) {
    if (msg.type === "clear") cleared?.();
    else posted.push(msg);
  },
};
const send = (data: ToWorker) => scope.onmessage!({ data });
send({ type: "init", sampleRate: WSR, port } as unknown as ToWorker);

/** Bars of a style through the worker (synth, weighted mix), as the player sends them; the stems per role and their sum. */
async function run(style: StyleBundle, bars: Bar[]): Promise<{ roles: Map<Role, Stereo>; mix: Stereo; frames: number }> {
  posted = [];
  const parts = partLevels(style.corpus);
  const levels = Object.fromEntries(style.corpus.instruments.map((i) => [i.role, i.volume])) as Partial<Record<Role, number>>;
  const sound = styleSound(style.corpus);
  const programs = new Map<number, number>();
  const patches = new Map<number | string, string>();
  let start = 0;
  let frames = 0;
  for (const bar of bars) {
    frames = Math.round(((bar.beats * 60) / bar.bpm) * WSR);
    const notes = barScore(bar, programs, { legato: true, gestures: true, patches }).map((n) => ({ ...n, t: n.t + start / WSR }));
    const moves = stemMoves(bar);
    send({
      type: "bar",
      engine: "synth",
      start,
      frames,
      styleId: style.id,
      newPiece: bar.info.barInPiece === 0,
      levels,
      ...(parts && { partLevels: parts }),
      notes,
      mix: { intensity: bar.info.intensity, lean: velocityScale(bar.info.intensity, FLOOR) },
      touch: true,
      ...(sound && { sound }),
      ...(moves && { moves }),
    });
    start += frames;
  }
  await new Promise<void>((resolve) => {
    cleared = resolve;
    send({ type: "clear", from: start });
  });
  const pcm = posted.filter((m) => m.type === "pcm");
  const total = pcm.reduce((a, m) => a + m.frames, 0);
  const roles = new Map<Role, Stereo>();
  const mix = stereo(total);
  let at = 0;
  for (const m of pcm) {
    m.roles.forEach((r, i) => {
      const role = ROLES[r]!;
      const s = roles.get(role) ?? stereo(total);
      roles.set(role, s);
      s.l.set(m.data[2 * i]!, at);
      s.r.set(m.data[2 * i + 1]!, at);
      for (let k = 0; k < m.frames; k++) {
        mix.l[at + k]! += m.data[2 * i]![k]!;
        mix.r[at + k]! += m.data[2 * i + 1]![k]!;
      }
    });
    at += m.frames;
  }
  return { roles, mix, frames };
}

/** The first whole track of a set over one style, at a tempo both styles can play. */
function track(style: StyleBundle, seed: string): Bar[] {
  const opts: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: FLOOR } };
  // The track's own bars, at its own tempo: in the set its last bars overlap the next track's.
  const piece = new SetConductor([style], seed, opts).trackPiece(0);
  return Array.from({ length: piece.totalBars }, (_, b) => piece.renderBar(b, b));
}

test("a whole track through the worker: near minimal techno's level, heavier below 100 Hz, mono lows, nothing clipping", async () => {
  const bars = track(BERLIN, "berlin-worker");
  const t0 = performance.now();
  const mine = await run(BERLIN, bars);
  const ms = (performance.now() - t0) / bars.length;
  const theirBars = track(MINIMAL, "berlin-worker");
  const theirs = await run(MINIMAL, theirBars);
  // Past the mix-in and before the mix-out.
  const body = (r: { mix: Stereo; frames: number }, n: number): Stereo => ({ l: r.mix.l.slice(16 * r.frames, (n - 16) * r.frames), r: r.mix.r.slice(16 * r.frames, (n - 16) * r.frames) });
  const m = measureWeight(body(mine, bars.length), WSR);
  const was = measureWeight(body(theirs, theirBars.length), WSR);
  const line = (x: typeof m) => `rms ${db(x.rms).toFixed(1)} dB, crest ${x.crest.toFixed(1)} dB, range ${x.range.toFixed(1)} dB, sub ${(x.sub * 100).toFixed(0)}%, low-mid ${(x.lowMid * 100).toFixed(0)}%, low corr ${x.lowCorrelation.toFixed(2)}`;
  const top = peak(mine.mix);
  const on = bars.reduce((a, b) => a + b.info.parts!.length, 0) / bars.length;
  // Each role where it plays hardest: its loudest bar outside builds (there the pad's stem carries the riser).
  const loudest = (r: typeof mine, list: Bar[]) =>
    [...r.roles].map(([role, s]) => `${role} ${db(Math.max(...list.map((b, i) => (b.info.build ? 0 : rms(s, i * r.frames, (i + 1) * r.frames))))).toFixed(1)} dB`).join(", ");
  console.log(
    `one track through the worker (weighted mix, synth, ${WSR} Hz):\n` +
      `  berlin techno  ${line(m)} (${bars.length} bars at ${bars[0]!.bpm} bpm, ${on.toFixed(1)} parts in on average, peak ${top.toFixed(2)})\n` +
      `  minimal techno ${line(was)} (${theirBars.length} bars at ${theirBars[0]!.bpm} bpm, peak ${peak(theirs.mix).toFixed(2)})\n` +
      `  loudest bar per role, berlin:  ${loudest(mine, bars)}\n` +
      `  loudest bar per role, minimal: ${loudest(theirs, theirBars)}\n` +
      `  render time ${ms.toFixed(0)} ms per bar (a bar is ${((mine.frames / WSR) * 1000).toFixed(0)} ms)`,
  );
  for (const s of [mine.mix, ...mine.roles.values()]) for (let i = 0; i < s.l.length; i++) assert.ok(Number.isFinite(s.l[i]) && Number.isFinite(s.r[i]));
  // No bar is silent: a breakdown keeps at least the drone.
  const quietest = Math.min(...bars.map((_, i) => rms(mine.mix, i * mine.frames, (i + 1) * mine.frames)));
  assert.ok(db(quietest) > -55, `the quietest bar: ${db(quietest).toFixed(1)} dB`);
  assert.ok(Math.abs(db(m.rms / was.rms)) < 3, `level: ${db(m.rms / was.rms).toFixed(1)} dB against minimal techno`);
  assert.ok(m.sub > was.sub && m.sub < 0.85, `sub share ${m.sub.toFixed(2)} against minimal techno's ${was.sub.toFixed(2)}`);
  assert.ok(m.lowCorrelation > 0.95, `the low end is mono: ${m.lowCorrelation}`);
  // The stems' sum before the bus: its limiter has minimal techno's peaks to deal with already, and these are no higher by much.
  assert.ok(top < 1 && top < peak(theirs.mix) * 1.5, `peak ${top} against ${peak(theirs.mix)}`);
  assert.ok(ms < ((mine.frames / WSR) * 1000) / 4, `${ms} ms per bar`);
});
