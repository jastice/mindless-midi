/**
 * Hand-written sounds for minimal techno, in the shape a corpus declares them
 * (`patches` and `synthKit`): a 909-like kick with its rumble and noise hats in the
 * kit, and a stab, a bass and a pad as patches. A style copies these into its
 * corpus.json; nothing reads this file at run time.
 *
 * Tuned by measurement, not by ear: patch_library.test.ts holds what each one
 * must be (the kick has weight under 60 Hz and a click, the rumble fills the
 * gap between kicks, and so on).
 */
import type { Kit, NamedPatch } from "../../corpus/patch.js";

const kit: Kit = {
  // Punchy and deep: a fast sweep down to G#1 (about 47 Hz, between the usual techno keys), a clean tail after the driven body.
  kick: { f0: 190, f1: 47, sweep: 0.028, decay: 0.2, drive: 2.2, click: 0.35, sub: { level: 0.7, decay: 0.28 } },
  // About a beat long at 130 BPM, kept under 100 Hz, in behind the kick after 90 ms.
  rumble: { level: 0.5, cutoff: 95, decay: 0.55, duck: 0.09 },
  snare: { tone: 200, toneDecay: 0.07, noiseDecay: 0.16, noiseHp: 1800, mix: 0.7 },
  hatScale: 1.2,
  hatDecay: 0.04,
  // Half noise, half metal; nothing below 7 kHz; a tight tick closed, a fifth of a second open.
  hat: { tone: 9500, q: 1.2, hp: 7000, decay: 0.022, open: 0.2, metal: 0.5 },
  clap: { tone: 1150, q: 2, bursts: 4, decay: 0.11 },
  ride: { hp: 6000, decay: 0.4, level: 0.28 },
  perc: [
    { lane: "tomLow", freq: 110, bend: 5, sweep: 0.03, decay: 0.18, pan: -0.3, level: 0.6 },
    { lane: "tomHigh", freq: 440, bend: 2, sweep: 0.01, decay: 0.09, fm: { ratio: 1.48, amount: 2 }, pan: 0.3, level: 0.45 },
    { lane: "rim", freq: 1800, bend: 12, sweep: 0.004, decay: 0.02, noise: 0.3, pan: 0.15, level: 0.5 },
  ],
};

const patches: NamedPatch[] = [
  {
    // The chord stab: a detuned saw through a band-pass that snaps shut, so only a vowel-like blip is left. The band drifts over 8 bars.
    id: "stab",
    osc: { wave: "saw", voices: 3, detune: 12, spread: 0.6 },
    filter: { type: "band", cutoff: 500, q: 2.5, keytrack: 1, env: 3800, a: 0.002, d: 0.09, s: 0, r: 0.08 },
    amp: { a: 0.002, d: 0.22, s: 0, r: 0.12 },
    drive: 0.6,
    mod: [{ target: "cutoff", shape: "sine", beats: 32, depth: 0.6 }],
    hp: 180,
    level: 0.5,
  },
  {
    // One saw, mono, mostly fundamental; the filter follows the note and a 4-bar wobble. Slides glide and accents bark: an acid line when the notes ask for it.
    id: "bass",
    osc: { wave: "saw", voices: 1, detune: 0 },
    filter: { type: "low", cutoff: 90, q: 3, keytrack: 1.5, env: 900, a: 0.002, d: 0.14, s: 0.15, r: 0.06 },
    amp: { a: 0.003, d: 0.2, s: 0.75, r: 0.06 },
    drive: 0.8,
    mod: [{ target: "cutoff", shape: "sine", beats: 16, depth: 0.4 }],
    glide: 0.05,
    accent: { cutoff: 2200, q: 3 },
    level: 0.55,
  },
  {
    // Five saws wide apart, fading in over a second, with the filter opening and closing over 16 bars and the width breathing against it.
    id: "pad",
    osc: { wave: "saw", voices: 5, detune: 16, spread: 0.8 },
    filter: { type: "low", cutoff: 500, q: 1, keytrack: 1, env: 600, a: 1.5, d: 2, s: 0.7, r: 2 },
    amp: { a: 1.2, d: 1, s: 1, r: 2.2 },
    mod: [
      { target: "cutoff", shape: "sine", beats: 64, depth: 0.8 },
      { target: "width", shape: "sine", beats: 24, depth: 0.4 },
      { target: "pan", shape: "sine", beats: 12, depth: 0.15 },
    ],
    hp: 150,
    level: 0.4,
  },
];

export const MINIMAL_TECHNO = { patches, synthKit: kit };
