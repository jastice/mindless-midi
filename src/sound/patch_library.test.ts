/**
 * The sounds that ship as data: they fit the schema, they reach a note
 * through the corpus, and the six for minimal techno measure as what they are
 * meant to be. Nobody listened while they were written, so the numbers here
 * are the ears.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Kit, type NamedPatch, Patch } from "../corpus/patch.js";
import type { StyleBundle } from "../corpus/schema.js";
import { kitWarnings, patchWarnings, validateCorpus } from "../corpus/validate.js";
import { Conductor } from "../engine/conductor.js";
import { DEFAULT_PIECE_OPTIONS } from "../engine/piece.js";
import { SetConductor } from "../engine/set.js";
import { type Stereo, stereo } from "./dsp.js";
import { lowCorrelation } from "./measure.js";
import { GM_PATCHES } from "./patches/gm.js";
import { KITS } from "./patches/kits.js";
import { MINIMAL_TECHNO } from "./patches/minimal_techno.js";
import { barScore } from "./score.js";
import { type SoundSet, renderSynthNote, styleSound } from "./synth.js";
import type { ScoreNote } from "./types.js";

const SR = 48000;
/** 130 BPM. */
const BEAT = 60 / 130;
const SOUND = styleSound(MINIMAL_TECHNO)!;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const round = (x: number, digits = 2) => Number(x.toFixed(digits));

const cut = (s: Stereo, from: number, to: number): Stereo => ({ l: s.l.slice(Math.round(from * SR), Math.round(to * SR)), r: s.r.slice(Math.round(from * SR), Math.round(to * SR)) });
const rms = (s: Stereo) => {
  let e = 0;
  for (let i = 0; i < s.l.length; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return Math.sqrt(e / (2 * Math.max(1, s.l.length)));
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

/** Share of the energy between `lo` and `hi` Hz, read off the spectrum (so a band's edge is an edge). */
function share(s: Stereo, _sr: number, lo: number, hi: number): number {
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
  for (let at = 0; at + hop <= s.l.length; at += hop) env.push(rms({ l: s.l.subarray(at, at + hop) as Stereo["l"], r: s.r.subarray(at, at + hop) as Stereo["r"] }));
  const top = Math.max(...env);
  const from = env.indexOf(top);
  let last = from;
  for (let i = from; i < env.length; i++) if (db(env[i]! / top) > -drop) last = i;
  return ((last + 1 - from) * hop) / SR;
}

/** Mean frequency weighted by energy, by zero-crossing rate of the difference: cheap brightness. */
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

const drumNote = (t: number, key: number, vel = 110): ScoreNote => ({ t, dur: 0.1, key, vel, ch: 9, role: "drums", program: 0 });
const patchNote = (patch: string, t: number, dur: number, key: number, more: Partial<ScoreNote> = {}): ScoreNote => ({ t, dur, key, vel: 100, ch: 0, role: "comp", program: 90, patch, beat: BEAT, pos: t / BEAT, ...more });

function render(notes: ScoreNote[], seconds: number, sound: SoundSet = SOUND): Stereo {
  const out = stereo(Math.round(seconds * SR));
  notes.forEach((n, i) => renderSynthNote(out, n, SR, "none", notes[i - 1], false, sound));
  return out;
}

// --- The schema ------------------------------------------------------------

test("the GM families and the built-in kits fit the schema", () => {
  for (const [name, p] of Object.entries(GM_PATCHES)) {
    const r = Patch.safeParse(p);
    assert.ok(r.success, `${name}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
    assert.deepEqual(r.data, p, `${name} survives parsing unchanged`);
  }
  for (const [name, k] of Object.entries(KITS)) {
    const r = Kit.safeParse(k);
    assert.ok(r.success, `${name}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
    assert.deepEqual(r.data, k, `${name} survives parsing unchanged`);
  }
});

test("the minimal techno sounds fit the schema, with nothing in them that does nothing", () => {
  assert.deepEqual(MINIMAL_TECHNO.patches.map((p) => p.id), ["stab", "bass", "pad", "acid", "bleep", "chord", "air"]);
  for (const p of MINIMAL_TECHNO.patches) {
    const r = Patch.safeParse(p);
    assert.ok(r.success, `${p.id}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
    assert.deepEqual(patchWarnings(p), [], p.id);
  }
  const k = Kit.safeParse(MINIMAL_TECHNO.synthKit);
  assert.ok(k.success, k.success ? "" : JSON.stringify(k.error.issues));
  assert.deepEqual(kitWarnings(MINIMAL_TECHNO.synthKit), []);
});

test("minimal_techno's corpus declares exactly these sounds, on its instruments and its parts", () => {
  const corpus = JSON.parse(readFileSync("styles/minimal_techno/corpus.json", "utf8"));
  assert.deepEqual(corpus.patches, MINIMAL_TECHNO.patches);
  assert.deepEqual(corpus.synthKit, MINIMAL_TECHNO.synthKit);
  const named = Object.fromEntries(corpus.instruments.filter((i: { patch?: string }) => i.patch).map((i: { role: string; patch: string }) => [i.role, i.patch]));
  assert.deepEqual(named, { pad: "pad", comp: "stab", bass: "bass" });
  // Every patch is some part's sound; the drum parts play the kit.
  const byPart = Object.fromEntries(corpus.parts.filter((p: { patch?: string }) => p.patch).map((p: { id: string; patch: string }) => [p.id, p.patch]));
  assert.deepEqual(byPart, { sub: "bass", acid: "acid", bleep: "bleep", stab: "stab", chord: "chord", pad: "pad", air: "air" });
  const v = validateCorpus(corpus);
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  assert.ok(!v.warnings.some((w) => /patch|synthKit/.test(w)), v.warnings.join("\n"));
});

// --- From the corpus to the note -------------------------------------------

const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };

/** Synthwave, with the techno sounds declared and its bass and pad playing them. */
function patched(): StyleBundle {
  const style = structuredClone(styles.find((s) => s.id === "synthwave")!);
  style.corpus.patches = structuredClone(MINIMAL_TECHNO.patches) as NamedPatch[];
  style.corpus.synthKit = structuredClone(MINIMAL_TECHNO.synthKit);
  for (const inst of style.corpus.instruments) if (inst.role === "bass" || inst.role === "pad") inst.patch = inst.role;
  return style;
}

test("a corpus that declares the sounds is valid, and its notes carry patch, beat and position", () => {
  const style = patched();
  const v = validateCorpus(style.corpus);
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  assert.ok(v.warnings.some((w) => /patch "stab" is not used/.test(w)), "an unused patch is a warning");
  assert.deepEqual(Object.keys(styleSound(style.corpus)!.patches!), MINIMAL_TECHNO.patches.map((p) => p.id));
  assert.equal(styleSound(styles[0]!.corpus), undefined, "a style without sounds has no sound set");

  const c = new Conductor([style], "patches", DEFAULT_PIECE_OPTIONS);
  const programs = new Map<number, number>();
  const patches = new Map<number, string>();
  let seen = 0;
  for (let i = 0; i < 24; i++) {
    const bar = c.nextBar();
    if (bar.info.gap) break;
    const spb = 60 / bar.bpm;
    for (const n of barScore(bar, programs, { patches })) {
      if (n.role === "bass" || n.role === "pad") {
        seen++;
        assert.equal(n.patch, n.role);
        assert.equal(n.beat, spb);
        // Position in beats from the start of the piece: the bar's, plus the note's place in it.
        assert.ok(Math.abs(n.pos! - (bar.info.barInPiece * bar.beats + n.t / spb)) < 1e-9);
      } else {
        assert.equal(n.patch, undefined);
        assert.equal(n.pos, undefined);
      }
    }
  }
  assert.ok(seen > 20, `patched notes: ${seen}`);

  // Without the map (the other apps), or for a style without patches, notes are as they were.
  const plain = new Conductor([style], "patches", DEFAULT_PIECE_OPTIONS);
  for (const n of barScore(plain.nextBar(), new Map())) assert.ok(!("patch" in n) && !("beat" in n) && !("pos" in n));
  const old = new Conductor([styles.find((s) => s.id === "synthwave")!], "patches", DEFAULT_PIECE_OPTIONS);
  const bar = old.nextBar();
  assert.ok(!JSON.stringify(bar).includes('"patch"'), "no patch on a program change that has none");
  for (const n of barScore(bar, new Map(), { patches: new Map() })) assert.ok(!("patch" in n));
});

test("in a style with parts, a note carries its part and plays that part's patch, whatever else is on its channel", () => {
  const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
  const techno = claudia.find((s) => s.id === "minimal_techno")!;
  const want = Object.fromEntries(techno.corpus.parts!.map((p) => [p.id, p.role === "drums" ? undefined : p.patch]));
  const c = new SetConductor([techno], "part-patches");
  const programs = new Map<number, number>();
  const patches = new Map<number | string, string>();
  const seen = new Map<string, Set<number>>();
  for (let i = 0; i < 400; i++) {
    const bar = c.nextBar();
    const score = barScore(bar, programs, { patches });
    score.forEach((n, k) => {
      assert.equal(n.part, bar.notes[k]!.part);
      assert.ok(n.part !== undefined);
      assert.equal(n.patch, want[n.part], `${n.part} plays ${n.patch}`);
      seen.set(n.part, (seen.get(n.part) ?? new Set()).add(n.ch));
    });
  }
  // Two parts of one role share a channel and still play their own sounds.
  for (const pair of [["acid", "bleep"], ["stab", "chord"], ["pad", "air"]]) {
    assert.ok(pair.every((id) => seen.has(id)), `${pair} were heard`);
    assert.deepEqual([...seen.get(pair[0]!)!], [...seen.get(pair[1]!)!]);
    assert.notEqual(want[pair[0]!], want[pair[1]!]);
  }
});

// --- The six sounds, measured ------------------------------------------------

const numbers: Record<string, Record<string, number>> = {};

test("kick: weight under 60 Hz, a click on top, and a tail that outlasts the body", () => {
  const { rumble: _, ...dry } = MINIMAL_TECHNO.synthKit;
  const kick = render([drumNote(0, 36)], 1.5, { kit: dry });
  const { sub: __, ...noTail } = dry.kick;
  const plain = render([drumNote(0, 36)], 1.5, { kit: { ...dry, kick: noTail } });
  const m = (numbers.kick = {
    below60: round(share(kick, SR, 0, 60)),
    below120: round(share(kick, SR, 0, 120)),
    // The first 4 ms against the 4 ms after them, above 3 kHz.
    clickDb: round(db(rms(cut(highs(kick, 3000), 0, 0.004)) / rms(cut(highs(kick, 3000), 0.006, 0.01))), 1),
    ringSeconds: round(ringTime(kick)),
    ringWithoutTail: round(ringTime(plain)),
    peak: round(peak(kick)),
  });
  assert.ok(m.below60 > 0.5, `energy under 60 Hz: ${m.below60}`);
  assert.ok(m.below120 > 0.8, `energy under 120 Hz: ${m.below120}`);
  assert.ok(m.clickDb > 15, `click: ${m.clickDb} dB`);
  assert.ok(m.ringSeconds > m.ringWithoutTail + 0.05, `tail: ${m.ringSeconds} s against ${m.ringWithoutTail} s`);
  assert.ok(m.ringSeconds < BEAT, "and is gone by the next kick");
  assert.deepEqual(kick.l, kick.r);
});

/** What is above `hz`. */
function highs(s: Stereo, hz: number): Stereo {
  const a = Math.exp((-2 * Math.PI * hz) / SR);
  const one = (x: Stereo["l"]) => {
    const out = new Float32Array(x.length);
    let lp1 = 0;
    let lp2 = 0;
    for (let i = 0; i < x.length; i++) {
      lp1 = a * lp1 + (1 - a) * x[i]!;
      lp2 = a * lp2 + (1 - a) * (x[i]! - lp1);
      out[i] = x[i]! - lp1 - lp2;
    }
    return out;
  };
  return { l: one(s.l), r: one(s.r) };
}

test("rumble: low-passed, out of the kick's way, and sounding between kicks", () => {
  const { rumble: _, ...dry } = MINIMAL_TECHNO.synthKit;
  // Four on the floor; the rumble is what the declared kit adds to the dry kick.
  const hits = [0, 1, 2, 3, 4, 5].map((i) => drumNote(i * BEAT, 36));
  const both = render(hits, 6 * BEAT + 1);
  const kick = render(hits, 6 * BEAT + 1, { kit: dry });
  const wet = minus(both, kick);
  // The last quarter of a beat, before the next kick lands: the gap the rumble is there to fill.
  const gap = (s: Stereo) => rms(cut(s, 4.75 * BEAT, 5 * BEAT));
  const m = (numbers.rumble = {
    below150: round(share(cut(wet, 2 * BEAT, 6 * BEAT), SR, 0, 150), 3),
    above300: round(share(cut(wet, 2 * BEAT, 6 * BEAT), SR, 300, Infinity), 4),
    // Against the kick itself, over a whole beat.
    levelDb: round(db(rms(cut(wet, 4 * BEAT, 5 * BEAT)) / rms(cut(kick, 4 * BEAT, 5 * BEAT))), 1),
    // In the first 40 ms of a beat, where the kick's punch is.
    onPunchDb: round(db(rms(cut(wet, 4 * BEAT, 4 * BEAT + 0.04)) / rms(cut(kick, 4 * BEAT, 4 * BEAT + 0.04))), 1),
    gapDb: round(db(gap(wet) / gap(kick)), 1),
    // How even it is once it has swelled in: its quietest 50 ms against its loudest, from 100 ms after the kick to the next.
    evenDb: round(evenness(cut(wet, 4 * BEAT + 0.1, 5 * BEAT)), 1),
    tailSeconds: round(ringTime(cut(wet, 5 * BEAT, 6 * BEAT + 1), 30)),
  });
  assert.ok(m.below150 > 0.95, `energy under 150 Hz: ${m.below150}`);
  assert.ok(m.above300 < 0.01, `energy over 300 Hz: ${m.above300}`);
  assert.ok(m.levelDb > -14 && m.levelDb < -3, `level under the kick: ${m.levelDb} dB`);
  assert.ok(m.onPunchDb < -12, `on the punch: ${m.onPunchDb} dB`);
  assert.ok(m.gapDb > -3, `in the gap it is about as loud as what is left of the kick: ${m.gapDb} dB`);
  assert.ok(m.evenDb > -14, `sustained across the beat: ${m.evenDb} dB`);
  assert.ok(m.tailSeconds < 1.2, `it dies away after the last kick: ${m.tailSeconds} s`);
  assert.deepEqual(wet.l, wet.r);
});

function evenness(s: Stereo): number {
  const hop = Math.round(0.05 * SR);
  const env: number[] = [];
  for (let at = 0; at + hop <= s.l.length; at += hop) env.push(rms({ l: s.l.subarray(at, at + hop) as Stereo["l"], r: s.r.subarray(at, at + hop) as Stereo["r"] }));
  return db(Math.min(...env) / Math.max(...env));
}

test("hat: above 6 kHz and short; the open hat is the same sound, longer", () => {
  const closed = render([drumNote(0.01, 42)], 0.6);
  const open = render([drumNote(0.01, 46)], 1.5);
  const m = (numbers.hat = {
    above6k: round(share(closed, SR, 6000, Infinity), 3),
    below3k: round(share(closed, SR, 0, 3000), 5),
    ringSeconds: round(ringTime(closed), 3),
    openRingSeconds: round(ringTime(open), 3),
    openAbove6k: round(share(open, SR, 6000, Infinity), 3),
    peak: round(peak(closed)),
  });
  assert.ok(m.above6k > 0.9, `energy over 6 kHz: ${m.above6k}`);
  assert.ok(m.below3k < 0.001, `energy under 3 kHz: ${m.below3k}`);
  assert.ok(m.ringSeconds <= 0.06, `closed: ${m.ringSeconds} s`);
  assert.ok(m.openRingSeconds > 3 * m.ringSeconds && m.openRingSeconds < BEAT, `open: ${m.openRingSeconds} s`);
  assert.ok(m.openAbove6k > 0.9);
  assert.ok(m.peak > 0.1 && m.peak < 1);
});

test("clap, ride and tuned percussion sound where they should", () => {
  const clap = render([drumNote(0.01, 39)], 1);
  const ride = render([drumNote(0.01, 51)], 2.5);
  const tom = render([drumNote(0.01, 45)], 1.5);
  const bleep = render([drumNote(0.01, 50)], 1);
  const m = (numbers.kitRest = {
    clapBand: round(share(clap, SR, 500, 3000)),
    clapRing: round(ringTime(clap)),
    rideAbove5k: round(share(ride, SR, 5000, Infinity)),
    rideRing: round(ringTime(ride)),
    tomBand: round(share(cut(tom, 0.1, 0.5), SR, 80, 160)),
    bleepBrightness: round(brightness(bleep), 0),
  });
  assert.ok(m.clapBand > 0.8 && m.clapRing > 0.08 && m.clapRing < 0.5, JSON.stringify(m));
  assert.ok(m.rideAbove5k > 0.9 && m.rideRing > 0.3 && m.rideRing < 1.5, JSON.stringify(m));
  assert.ok(m.tomBand > 0.9, `the low tom settles on 110 Hz: ${m.tomBand}`);
  assert.ok(m.bleepBrightness > 400, `the high tom is an FM bleep around 440 Hz and up: ${m.bleepBrightness}`);
  // Each takes its lane from the built-in model.
  const { perc: _, clap: __, ride: ___, ...stock } = MINIMAL_TECHNO.synthKit;
  for (const key of [39, 51, 45, 50, 37]) assert.notDeepEqual(render([drumNote(0.01, key)], 0.5).l, render([drumNote(0.01, key)], 0.5, { kit: stock }).l, `key ${key}`);
});

test("stab: band-limited, and the filter snaps shut", () => {
  // A minor triad around middle C, an 8th note long.
  const chord = [60, 63, 67].map((key) => patchNote("stab", 0.01, BEAT / 2, key));
  const stab = render(chord, 1.5);
  const m = (numbers.stab = {
    band200to5k: round(share(stab, SR, 200, 5000), 3),
    below150: round(share(stab, SR, 0, 150), 4),
    brightStart: round(brightness(cut(stab, 0.012, 0.03)), 0),
    brightLater: round(brightness(cut(stab, 0.13, 0.2)), 0),
    ringSeconds: round(ringTime(stab)),
    correlation: round(correlation(stab)),
    peak: round(peak(stab)),
  });
  assert.ok(m.band200to5k > 0.9, `energy from 200 Hz to 5 kHz: ${m.band200to5k}`);
  assert.ok(m.below150 < 0.01, `energy under 150 Hz: ${m.below150}`);
  assert.ok(m.brightStart > 2 * m.brightLater, `filter decay: ${m.brightStart} Hz falling to ${m.brightLater} Hz`);
  assert.ok(m.ringSeconds < 0.3, `length: ${m.ringSeconds} s`);
  assert.ok(m.correlation > 0.3 && m.correlation < 0.98, `stereo, not out of phase: ${m.correlation}`);
});

test("bass: mono, mostly fundamental, with slides and accents that make it acid", () => {
  // E1 to E2, the octave a techno bass lives in.
  const m: Record<string, number> = (numbers.bass = {});
  for (const key of [28, 33, 40]) {
    const hz = 440 * Math.pow(2, (key - 69) / 12);
    const note = render([patchNote("bass", 0.01, BEAT / 2, key, { role: "bass" })], 0.6);
    assert.deepEqual(note.l, note.r, "left and right are the same samples");
    m[`fundamental${key}`] = round(share(cut(note, 0.05, 0.2), SR, hz / 1.35, hz * 1.35));
    assert.ok(m[`fundamental${key}`]! > 0.5, `key ${key}: fundamental holds ${m[`fundamental${key}`]}`);
  }
  const line = render([28, 28, 40, 33].map((key, i) => patchNote("bass", i * BEAT / 2, BEAT / 2, key, { role: "bass" })), 1.5);
  m.lowCorrelation = round(lowCorrelation(line, SR), 3);
  m.below200 = round(share(line, SR, 0, 200));
  m.peak = round(peak(line));
  assert.equal(m.lowCorrelation, 1);
  assert.ok(m.below200 > 0.8, `energy under 200 Hz: ${m.below200}`);

  const plain = render([patchNote("bass", 0.01, BEAT / 2, 33, { role: "bass" })], 0.6);
  const accented = render([patchNote("bass", 0.01, BEAT / 2, 33, { role: "bass", gesture: "accent" })], 0.6);
  m.accentBrightness = round(brightness(cut(accented, 0.01, 0.1)) / brightness(cut(plain, 0.01, 0.1)));
  assert.ok(m.accentBrightness > 1.5, `an accent is brighter: ${m.accentBrightness}x`);
  // A slide up an octave starts near the lower note.
  const before = patchNote("bass", 0, 0.2, 28, { role: "bass" });
  const to = patchNote("bass", 0.2, 0.3, 40, { role: "bass", gesture: "slide", curves: { bend: [[0, -2], [0.1, 0]] } });
  const slid = render([before, to], 0.8);
  const straight = render([before, { ...to, gesture: undefined, curves: undefined } as ScoreNote], 0.8);
  assert.notDeepEqual(cut(slid, 0.2, 0.3).l, cut(straight, 0.2, 0.3).l);
  // By four glide times on it has arrived: the two notes hold the same pitch (the same brightness).
  assert.ok(Math.abs(brightness(cut(slid, 0.42, 0.5)) / brightness(cut(straight, 0.42, 0.5)) - 1) < 0.1);
});

test("pad: slow to arrive, wide, and moving over bars", () => {
  const chord = (pos: number, dur = 6) => [57, 60, 64].map((key) => patchNote("pad", 0.01, dur, key, { role: "pad", pos }));
  const pad = render(chord(0), 9);
  // The cutoff modulator is a sine over 64 beats: highest 16 beats in, lowest 48 beats in.
  const open = render(chord(16 - 3 / BEAT, 4), 4.5);
  const shut = render(chord(48 - 3 / BEAT, 4), 4.5);
  const mid = (s: Stereo): Stereo => ({ l: s.l.map((x, i) => (x + s.r[i]!) / 2), r: s.l.map((x, i) => (x + s.r[i]!) / 2) });
  const m = (numbers.pad = {
    attackDb: round(db(rms(cut(pad, 0.01, 0.21)) / rms(cut(pad, 3, 5))), 1),
    secondsTo90: round(riseTime(pad), 2),
    releaseSeconds: round(ringTime(cut(pad, 6, 9)), 2),
    correlation: round(correlation(cut(pad, 2, 6))),
    monoLossDb: round(db(rms(mid(cut(pad, 2, 6))) / rms(cut(pad, 2, 6))), 1),
    below150: round(share(cut(pad, 2, 6), SR, 0, 150), 3),
    brightOpen: round(brightness(cut(open, 2.5, 3.5)), 0),
    brightShut: round(brightness(cut(shut, 2.5, 3.5)), 0),
    peak: round(peak(pad)),
  });
  assert.ok(m.attackDb < -12, `the first 200 ms: ${m.attackDb} dB under the held level`);
  assert.ok(m.secondsTo90 > 0.6, `rise: ${m.secondsTo90} s`);
  assert.ok(m.releaseSeconds > 0.8, `release: ${m.releaseSeconds} s`);
  assert.ok(m.correlation < 0.85 && m.correlation > 0.2, `wide but not out of phase: ${m.correlation}`);
  assert.ok(m.monoLossDb > -3, `in mono it loses ${m.monoLossDb} dB`);
  assert.ok(m.below150 < 0.05, `it leaves the low end alone: ${m.below150}`);
  assert.ok(m.brightOpen > 1.4 * m.brightShut, `slow movement: ${m.brightOpen} Hz open, ${m.brightShut} Hz shut`);
});

/** Seconds until the level first reaches 90% of what it holds at. */
function riseTime(s: Stereo): number {
  const hop = Math.round(0.05 * SR);
  const env: number[] = [];
  for (let at = 0; at + hop <= s.l.length; at += hop) env.push(rms({ l: s.l.subarray(at, at + hop) as Stereo["l"], r: s.r.subarray(at, at + hop) as Stereo["r"] }));
  const held = Math.max(...env);
  return (env.findIndex((x) => x > 0.9 * held) * hop) / SR;
}

// --- The four sounds the parts added, measured ---------------------------------

/** How far the sound sits to the left (positive) or right, dB. */
const lean = (s: Stereo) => db(rms({ l: s.l, r: s.l }) / rms({ l: s.r, r: s.r }));

test("acid: resonant and mono, above the sub, with a filter that snaps shut, sweeps over bars, and barks and slides", () => {
  // The acid part sits an octave above the bass: A2.
  const note = (more: Partial<ScoreNote> = {}) => patchNote("acid", 0.01, BEAT / 4, 45, { role: "arp", ...more });
  const plain = render([note()], 0.8);
  const accented = render([note({ gesture: "accent" })], 0.8);
  // The cutoff modulator is a sine over 48 beats: highest 12 beats in, lowest 36 beats in.
  const open = render([note({ pos: 12 })], 0.8);
  const shut = render([note({ pos: 36 })], 0.8);
  const m = (numbers.acid = {
    below60: round(share(plain, SR, 0, 60), 4),
    band100to4k: round(share(plain, SR, 100, 4000), 3),
    brightStart: round(brightness(cut(plain, 0.012, 0.03)), 0),
    brightLater: round(brightness(cut(plain, 0.09, 0.13)), 0),
    accentBrightness: round(brightness(cut(accented, 0.01, 0.1)) / brightness(cut(plain, 0.01, 0.1))),
    sweepBrightness: round(brightness(cut(open, 0.01, 0.1)) / brightness(cut(shut, 0.01, 0.1))),
    ringSeconds: round(ringTime(plain)),
    peak: round(peak(plain)),
  });
  assert.deepEqual(plain.l, plain.r, "mono");
  assert.ok(m.below60 < 0.05, `under 60 Hz, where the sub is: ${m.below60}`);
  assert.ok(m.band100to4k > 0.9, `from 100 Hz to 4 kHz: ${m.band100to4k}`);
  assert.ok(m.brightStart > 1.5 * m.brightLater, `the filter closes: ${m.brightStart} Hz to ${m.brightLater} Hz`);
  assert.ok(m.accentBrightness > 1.3, `an accent barks: ${m.accentBrightness}x`);
  assert.ok(m.sweepBrightness > 1.5, `the slow sweep: ${m.sweepBrightness}x`);
  assert.ok(m.ringSeconds < 0.3, `a sixteenth stays short: ${m.ringSeconds} s`);
  assert.ok(m.peak > 0.05 && m.peak < 1);
  const before = patchNote("acid", 0, 0.12, 45, { role: "arp" });
  const to = patchNote("acid", 0.12, 0.12, 52, { role: "arp", gesture: "slide", curves: { bend: [[0, -2], [0.06, 0]] } });
  assert.notDeepEqual(cut(render([before, to], 0.6), 0.12, 0.2).l, cut(render([before, { ...to, gesture: undefined, curves: undefined } as ScoreNote], 0.6), 0.12, 0.2).l, "a slide glides");
});

test("bleep: a short blip above the low end that lands somewhere else each beat", () => {
  const at = (pos: number) => render([patchNote("bleep", 0.01, BEAT / 4, 72, { role: "arp", pos })], 0.6);
  const blip = at(0.2);
  const leans = [0.2, 1.2, 2.2, 3.2, 4.2, 5.2].map((pos) => round(lean(at(pos)), 1));
  const m = (numbers.bleep = {
    below250: round(share(blip, SR, 0, 250), 4),
    band400to6k: round(share(blip, SR, 400, 6000), 3),
    ringSeconds: round(ringTime(blip), 3),
    leanSpreadDb: round(Math.max(...leans) - Math.min(...leans), 1),
    peak: round(peak(blip)),
  });
  assert.ok(m.below250 < 0.02 && m.band400to6k > 0.9, JSON.stringify(m));
  assert.ok(m.ringSeconds < 0.2, `length: ${m.ringSeconds} s`);
  assert.ok(m.leanSpreadDb > 3, `it moves between beats: ${leans} dB left`);
  assert.equal(new Set(leans).size > 3, true, "to more than a couple of places");
  assert.ok(m.peak > 0.05 && m.peak < 1);
});

test("chord: the stab's longer cousin, wide, without lows, closing over half a second", () => {
  const notes = (patch: string) => [57, 60, 64, 67].map((key) => patchNote(patch, 0.01, BEAT * 1.5, key));
  const chord = render(notes("chord"), 2.5);
  const stab = render(notes("stab"), 2.5);
  const m = (numbers.chord = {
    below150: round(share(chord, SR, 0, 150), 4),
    band200to5k: round(share(chord, SR, 200, 5000), 3),
    brightStart: round(brightness(cut(chord, 0.012, 0.05)), 0),
    brightLater: round(brightness(cut(chord, 0.4, 0.6)), 0),
    ringSeconds: round(ringTime(chord)),
    stabRingSeconds: round(ringTime(stab)),
    correlation: round(correlation(chord)),
    peak: round(peak(chord)),
  });
  assert.ok(m.below150 < 0.02 && m.band200to5k > 0.9, JSON.stringify(m));
  assert.ok(m.brightStart > 1.5 * m.brightLater, `the filter closes: ${m.brightStart} Hz to ${m.brightLater} Hz`);
  assert.ok(m.ringSeconds > 2 * m.stabRingSeconds && m.ringSeconds < 1.5, `it rings ${m.ringSeconds} s, the stab ${m.stabRingSeconds} s`);
  assert.ok(m.correlation > 0.2 && m.correlation < 0.98, `stereo, not out of phase: ${m.correlation}`);
  assert.ok(m.peak < 1);
});

test("air: a slow wash of noise with nothing in the low end, that moves", () => {
  const chord = (pos: number, dur = 6) => [45, 52, 57].map((key) => patchNote("air", 0.01, dur, key, { role: "pad", pos }));
  const air = render(chord(0), 9);
  const held = cut(air, 3, 6);
  // The cutoff sweeps over 24 beats (highest 6 beats in, lowest 18), and the pan over 10.
  const high = render(chord(6 - 3 / BEAT, 4), 4.5);
  const low = render(chord(18 - 3 / BEAT, 4), 4.5);
  const left = render(chord(2.5 - 3 / BEAT, 4), 4.5);
  const right = render(chord(7.5 - 3 / BEAT, 4), 4.5);
  const { power } = spectrum(held.l);
  // How far the loudest bin stands over the mean: a tone is thousands of times, noise a few dozen.
  const tonal = power.reduce((a, x) => Math.max(a, x), 0) / (power.reduce((a, x) => a + x, 0) / power.length);
  const m = (numbers.air = {
    below400: round(share(held, SR, 0, 400), 4),
    attackDb: round(db(rms(cut(air, 0.01, 0.21)) / rms(held)), 1),
    releaseSeconds: round(ringTime(cut(air, 6, 9)), 2),
    brightHigh: round(brightness(cut(high, 2.5, 3.5)), 0),
    brightLow: round(brightness(cut(low, 2.5, 3.5)), 0),
    leanLeftDb: round(lean(cut(left, 2.8, 3.2)), 1),
    leanRightDb: round(lean(cut(right, 2.8, 3.2)), 1),
    peakOverMean: round(tonal, 0),
    peak: round(peak(air)),
  });
  assert.ok(m.below400 < 0.01, `under 400 Hz: ${m.below400}`);
  assert.ok(m.attackDb < -10, `it fades in: ${m.attackDb} dB in the first 200 ms`);
  assert.ok(m.releaseSeconds > 0.8, `and out: ${m.releaseSeconds} s`);
  assert.ok(m.brightHigh > 1.5 * m.brightLow, `the sweep: ${m.brightHigh} Hz to ${m.brightLow} Hz`);
  assert.ok(m.leanLeftDb - m.leanRightDb > 4 || m.leanRightDb - m.leanLeftDb > 4, `it wanders: ${m.leanLeftDb} dB and ${m.leanRightDb} dB`);
  assert.ok(m.peakOverMean < 2000, `noise, not a tone: ${m.peakOverMean}`);
  assert.ok(m.peak < 1);
});

test("eight bars of all six are a mix with a mono low end", () => {
  const notes: ScoreNote[] = [];
  for (let b = 0; b < 8; b++) {
    notes.push(drumNote(b * BEAT, 36), drumNote((b + 0.5) * BEAT, 46, 90));
    for (let s = 0; s < 4; s++) notes.push(drumNote((b + s / 4) * BEAT, 42, s === 0 ? 100 : 70));
    notes.push(patchNote("bass", (b + 0.5) * BEAT, BEAT / 4, 33, { role: "bass" }));
    if (b % 4 === 1) for (const key of [60, 63, 67]) notes.push(patchNote("stab", (b + 0.75) * BEAT, BEAT / 4, key));
  }
  for (const key of [57, 60, 64]) notes.push(patchNote("pad", 0, 8 * BEAT, key, { role: "pad" }));
  notes.sort((a, b) => a.t - b.t);
  const out = stereo(Math.round((8 * BEAT + 2) * SR));
  const prev = new Map<string, ScoreNote>();
  for (const n of notes) {
    renderSynthNote(out, n, SR, "none", prev.get(n.role), false, SOUND);
    prev.set(n.role, n);
  }
  const body = cut(out, 2 * BEAT, 8 * BEAT);
  const mix = (numbers.mix = { below100: round(share(body, SR, 0, 100)), above6k: round(share(body, SR, 6000, Infinity), 3), lowCorrelation: round(lowCorrelation(body, SR), 3), peak: round(peak(body)) });
  assert.ok(mix.below100 > 0.3 && mix.lowCorrelation > 0.95, JSON.stringify(mix));
  for (let i = 0; i < out.l.length; i++) assert.ok(Number.isFinite(out.l[i]) && Number.isFinite(out.r[i]));
  console.log("measured:", JSON.stringify(numbers, null, 1));
});
