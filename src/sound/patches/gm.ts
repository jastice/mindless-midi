/**
 * The subtractive General MIDI families as patches: what a program number
 * sounds like when a style names no patch of its own. Changing a number here
 * changes how the shipped apps sound (baseline.test.ts holds them).
 */
import type { Patch } from "../../corpus/patch.js";

const STRINGS: Patch = { osc: { wave: "saw", voices: 3, detune: 10 }, filter: { type: "low", cutoff: 1500, q: 0.7, keytrack: 1.2, env: 900, a: 0.4, d: 0.6, s: 0.8, r: 0.8 }, amp: { a: 0.35, d: 0.5, s: 0.9, r: 0.8 }, vibrato: { rate: 5.2, depth: 8, delay: 0.3 }, level: 0.5 };
const PAD: Patch = { osc: { wave: "saw", voices: 4, detune: 14 }, filter: { type: "low", cutoff: 700, q: 1, keytrack: 1, env: 900, a: 1.2, d: 1.5, s: 0.6, r: 1.4 }, amp: { a: 0.8, d: 1, s: 1, r: 1.4 }, level: 0.45 };
const POLY: Patch = { osc: { wave: "saw", voices: 2, detune: 8, sub: 0.3 }, filter: { type: "low", cutoff: 500, q: 2, keytrack: 2, env: 3500, a: 0.003, d: 0.35, s: 0.15, r: 0.25 }, amp: { a: 0.004, d: 0.3, s: 0.6, r: 0.25 }, level: 0.5 };
const CHOIR: Patch = { osc: { wave: "saw", voices: 3, detune: 9 }, filter: { type: "low", cutoff: 1100, q: 0.7, keytrack: 0.5, env: 0, a: 0.1, d: 0.1, s: 1, r: 0.9 }, amp: { a: 0.45, d: 0.3, s: 1, r: 0.9 }, vibrato: { rate: 5, depth: 10, delay: 0.3 }, formants: [{ freq: 700, q: 6, gain: 1.4 }, { freq: 1200, q: 6, gain: 0.9 }, { freq: 2600, q: 8, gain: 0.5 }], level: 0.45 };
const SQUARE_LEAD: Patch = { osc: { wave: "pulse", pw: 0.5, voices: 2, detune: 6 }, filter: { type: "low", cutoff: 1200, q: 1.5, keytrack: 3, env: 2500, a: 0.004, d: 0.4, s: 0.4, r: 0.15 }, amp: { a: 0.005, d: 0.2, s: 0.8, r: 0.15 }, vibrato: { rate: 5.5, depth: 12, delay: 0.25 }, glide: 0.05, level: 0.4 };
const SAW_LEAD: Patch = { osc: { wave: "saw", voices: 2, detune: 9 }, filter: { type: "low", cutoff: 1500, q: 1.2, keytrack: 2, env: 3000, a: 0.004, d: 0.35, s: 0.45, r: 0.15 }, amp: { a: 0.005, d: 0.2, s: 0.85, r: 0.15 }, vibrato: { rate: 5.5, depth: 12, delay: 0.25 }, glide: 0.06, level: 0.4 };
const SYNTH_BASS: Patch = { osc: { wave: "saw", voices: 1, detune: 0, sub: 0.6 }, filter: { type: "low", cutoff: 200, q: 2.5, keytrack: 1, env: 2500, a: 0.002, d: 0.18, s: 0.1, r: 0.08 }, amp: { a: 0.002, d: 0.2, s: 0.7, r: 0.08 }, level: 0.6 };
const BRASS: Patch = { osc: { wave: "saw", voices: 2, detune: 7 }, filter: { type: "low", cutoff: 500, q: 0.9, keytrack: 1.2, env: 3000, a: 0.06, d: 0.3, s: 0.4, r: 0.12 }, amp: { a: 0.03, d: 0.2, s: 0.85, r: 0.12 }, vibrato: { rate: 5.5, depth: 8, delay: 0.35 }, scoop: -40, level: 0.45 };
const MUTED_TRUMPET: Patch = { ...BRASS, osc: { ...BRASS.osc, voices: 1 }, filter: { ...BRASS.filter, cutoff: 900, env: 1800 }, hp: 600, formants: [{ freq: 1500, q: 4, gain: 1.5 }, { freq: 3000, q: 5, gain: 0.6 }] };
const SAX: Patch = { osc: { wave: "saw", voices: 1, detune: 0 }, filter: { type: "low", cutoff: 900, q: 0.8, keytrack: 2.5, env: 1500, a: 0.05, d: 0.3, s: 0.7, r: 0.1 }, amp: { a: 0.04, d: 0.2, s: 0.9, r: 0.1 }, vibrato: { rate: 5.3, depth: 15, delay: 0.3 }, scoop: -30, breath: 0.05, formants: [{ freq: 550, q: 3, gain: 0.8 }, { freq: 1400, q: 4, gain: 0.6 }, { freq: 2600, q: 5, gain: 0.4 }], glide: 0.04, level: 0.45 };
const CLARINET: Patch = { osc: { wave: "pulse", pw: 0.5, voices: 1, detune: 0 }, filter: { type: "low", cutoff: 600, q: 0.8, keytrack: 2, env: 900, a: 0.04, d: 0.3, s: 0.7, r: 0.09 }, amp: { a: 0.04, d: 0.2, s: 0.9, r: 0.09 }, vibrato: { rate: 5, depth: 4, delay: 0.4 }, breath: 0.03, glide: 0.035, level: 0.45 };
const OBOE: Patch = { ...CLARINET, osc: { ...CLARINET.osc, pw: 0.3 }, formants: [{ freq: 1100, q: 5, gain: 1.2 }, { freq: 2800, q: 6, gain: 0.6 }] };
const FLUTE: Patch = { osc: { wave: "tri", voices: 1, detune: 0 }, filter: { type: "low", cutoff: 2500, q: 0.7, keytrack: 1, env: 0, a: 0.05, d: 0.1, s: 1, r: 0.12 }, amp: { a: 0.06, d: 0.2, s: 0.9, r: 0.12 }, vibrato: { rate: 5, depth: 10, delay: 0.2 }, breath: 0.12, glide: 0.04, level: 0.5 };
const VIOLIN: Patch = { osc: { wave: "saw", voices: 1, detune: 0 }, filter: { type: "low", cutoff: 2500, q: 0.7, keytrack: 2, env: 0, a: 0.1, d: 0.1, s: 1, r: 0.15 }, amp: { a: 0.08, d: 0.2, s: 0.9, r: 0.15 }, vibrato: { rate: 5.8, depth: 22, delay: 0.15 }, breath: 0.02, formants: [{ freq: 280, q: 2, gain: 0.6 }, { freq: 450, q: 3, gain: 0.5 }, { freq: 2800, q: 2, gain: 0.5 }], glide: 0.05, level: 0.4 };

/** Every family and variant, by name. */
export const GM_PATCHES = {
  strings: STRINGS,
  slow_strings: { ...STRINGS, amp: { ...STRINGS.amp, a: 0.6 } },
  pad: PAD,
  poly: POLY,
  choir: CHOIR,
  square_lead: SQUARE_LEAD,
  saw_lead: SAW_LEAD,
  synth_bass: SYNTH_BASS,
  brass: BRASS,
  synth_brass: { ...BRASS, osc: { ...BRASS.osc, voices: 4, detune: 12 } },
  muted_trumpet: MUTED_TRUMPET,
  sax: SAX,
  clarinet: CLARINET,
  oboe: OBOE,
  flute: FLUTE,
  violin: VIOLIN,
  low_strings: { ...VIOLIN, filter: { ...VIOLIN.filter, cutoff: 1200 }, vibrato: { rate: 5.2, depth: 14, delay: 0.2 } },
} satisfies Record<string, Patch>;
