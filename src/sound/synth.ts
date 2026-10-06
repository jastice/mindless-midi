/**
 * Approach 1: hand-written synthesis, no downloads. Every GM program family
 * maps to a small physical or subtractive model: modal piano, FM electric
 * piano, modal mallets, Karplus-Strong plucks, PolyBLEP subtractive voices
 * (strings, pads, brass, reeds, leads, synth bass) and an analog-style kit.
 *
 * Voices render a whole note at once into a Stereo (offset by its `base`),
 * so the same code fills an offline clip or a streaming StemWindow.
 */
import type { Role } from "../corpus/constants.js";
import type { ScoreNote } from "./types.js";
import { Noise, OnePole, Osc, type Stereo, Svf, adsr, mtof, stereo, yieldToUi } from "./dsp.js";

/** Longest a synth note can ring past its onset, seconds (window sizing). */
export const MAX_VOICE_SECONDS = 9;

type Voice = (out: Stereo, n: ScoreNote, sr: number, prev: ScoreNote | undefined) => void;

/** Render one note (drums included) into `out`. `prev` is the previous note of the same role. */
export function renderSynthNote(out: Stereo, n: ScoreNote, sr: number, styleId: string, prev?: ScoreNote): void {
  if (n.role === "drums") drum(out, n, sr, KITS[styleId] ?? KITS.default!);
  else voiceFor(n.program)(out, n, sr, prev);
}

/** Offline: every note of a clip, one stem per role. */
export async function renderSynthStems(notes: ScoreNote[], frames: number, styleId: string, sr: number, onProgress?: (f: number) => void): Promise<Map<Role, Stereo>> {
  const stems = new Map<Role, Stereo>();
  const prevByRole = new Map<Role, ScoreNote>();
  let done = 0;
  for (const n of notes) {
    let out = stems.get(n.role);
    if (!out) stems.set(n.role, (out = stereo(frames)));
    renderSynthNote(out, n, sr, styleId, prevByRole.get(n.role));
    prevByRole.set(n.role, n);
    if (++done % 64 === 0) {
      onProgress?.(done / notes.length);
      await yieldToUi();
    }
  }
  return stems;
}

function voiceFor(program: number): Voice {
  if (program <= 3) return piano;
  if (program <= 5) return epiano;
  if (program <= 7) return pluck({ bright: 0.92, t60: program === 7 ? 0.7 : 1.8, pick: 0.12 });
  if (program <= 15) return mallet(program);
  if (program <= 23) return organ;
  if (program === 28) return pluck({ bright: 0.6, t60: 0.25, pick: 0.2 });
  if (program <= 31) return pluck(program === 24 ? { bright: 0.45, t60: 3, pick: 0.2 } : { bright: 0.72, t60: 2.4, pick: 0.15 });
  if (program <= 37) return pluck({ bright: program === 34 ? 0.5 : 0.28, t60: 2.6, pick: 0.25, thump: 0.5 });
  if (program <= 39) return sub(SYNTH_BASS);
  if (program <= 41) return sub(VIOLIN);
  if (program === 45) return pluck({ bright: 0.4, t60: 0.5, pick: 0.3 });
  if (program === 46) return pluck({ bright: 0.55, t60: 3.5, pick: 0.1 });
  if (program <= 47) return sub({ ...VIOLIN, cutoff: 1200, vib: [5.2, 14, 0.2] });
  if (program <= 51) return sub(program === 49 ? { ...STRINGS, a: 0.6 } : STRINGS);
  if (program <= 55) return sub(CHOIR);
  if (program === 59) return sub(MUTED_TRUMPET);
  if (program <= 63) return sub(program === 61 || program === 62 ? { ...BRASS, voices: 4, detune: 12 } : BRASS);
  if (program <= 67) return sub(SAX);
  if (program <= 70) return sub(OBOE);
  if (program === 71) return sub(CLARINET);
  if (program <= 79) return sub(FLUTE);
  if (program === 80) return sub(SQUARE_LEAD);
  if (program <= 87) return sub(SAW_LEAD);
  if (program === 90) return sub(POLY);
  if (program === 91) return sub(CHOIR);
  if (program === 98 || program === 112) return mallet(program);
  if (program >= 104 && program <= 107) return pluck({ bright: 0.7, t60: 2, pick: 0.15 });
  if (program >= 113 && program <= 119) return mallet(program);
  if (program === 109) return sub(OBOE);
  return sub(PAD);
}

// --- Modal piano --------------------------------------------------------

const piano: Voice = (out, n, sr) => {
  const f = mtof(n.key);
  const v = n.vel / 127;
  const B = Math.min(0.004, Math.max(0.00005, 0.0001 * Math.pow(2, (n.key - 48) / 18)));
  const t60 = Math.min(14, Math.max(0.6, 12 * Math.pow(2, -(n.key - 21) / 16)));
  const K = Math.max(1, Math.min(12, Math.floor(9000 / f)));
  const damped = n.key < 89;
  const len = Math.ceil(Math.min(n.dur + (damped ? 0.35 : 1.5), t60, MAX_VOICE_SECONDS) * sr);
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const offFrame = Math.round(n.dur * sr);
  const damp = Math.exp(-6.9 / (0.16 * sr));
  // Per partial: two rotating phasors (detuned strings), two-stage decay.
  type P = { c1: number; s1: number; cw1: number; sw1: number; c2: number; s2: number; cw2: number; sw2: number; amp: number; e1: number; e2: number; d1: number; d2: number };
  const parts: P[] = [];
  for (let k = 1; k <= K; k++) {
    const fk = k * f * Math.sqrt(1 + B * k * k);
    if (fk > sr * 0.45) break;
    const amp = Math.abs(Math.sin(Math.PI * k * 0.13)) / Math.pow(k, 1.7 - 0.9 * v);
    const tk = t60 / (1 + 0.45 * (k - 1));
    const beat = k <= 6 ? 0.35 * Math.sqrt(k) : 0;
    const w1 = (2 * Math.PI * fk * Math.pow(2, beat / 1200)) / sr;
    const w2 = (2 * Math.PI * fk * Math.pow(2, -beat / 1200)) / sr;
    parts.push({
      c1: 1, s1: 0, cw1: Math.cos(w1), sw1: Math.sin(w1),
      c2: 1, s2: 0, cw2: Math.cos(w2), sw2: Math.sin(w2),
      amp, e1: 0.7, e2: 0.3,
      d1: Math.exp(-6.9 / (tk * 0.22 * sr)), d2: Math.exp(-6.9 / (tk * sr)),
    });
  }
  const noise = new Noise(n.key * 7919 + Math.round(n.t * 1000));
  const thump = new OnePole(sr, 400 + 1200 * v);
  const gain = 0.22 * Math.pow(v, 1.3);
  const pan = ((n.key - 64) / 40) * 0.6;
  const gl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const gr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const attack = Math.round(0.002 * sr);
  let rel = 1;
  for (let i = 0; i < len && start + i < out.l.length; i++) {
    let y = 0;
    for (const p of parts) {
      const c1 = p.c1 * p.cw1 - p.s1 * p.sw1;
      p.s1 = p.c1 * p.sw1 + p.s1 * p.cw1;
      p.c1 = c1;
      const c2 = p.c2 * p.cw2 - p.s2 * p.sw2;
      p.s2 = p.c2 * p.sw2 + p.s2 * p.cw2;
      p.c2 = c2;
      y += p.amp * (p.e1 + p.e2) * (p.s1 + p.s2);
      p.e1 *= p.d1;
      p.e2 *= p.d2;
    }
    if ((i & 1023) === 1023) for (const p of parts) renorm(p);
    if (i < 0.02 * sr) y += thump.tick(noise.next()) * 0.6 * v * (1 - i / (0.02 * sr));
    if (i < attack) y *= i / attack;
    if (damped && i > offFrame) rel *= damp;
    const s = y * gain * rel;
    out.l[start + i]! += s * gl;
    out.r[start + i]! += s * gr;
    if (rel < 1e-4) break;
  }
};

function renorm(p: { c1: number; s1: number; c2: number; s2: number }): void {
  const m1 = 1 / Math.hypot(p.c1, p.s1);
  p.c1 *= m1;
  p.s1 *= m1;
  const m2 = 1 / Math.hypot(p.c2, p.s2);
  p.c2 *= m2;
  p.s2 *= m2;
}

// --- FM electric piano --------------------------------------------------

const epiano: Voice = (out, n, sr) => {
  const f = mtof(n.key);
  const v = n.vel / 127;
  const t60 = Math.min(6, Math.max(0.8, 4 * Math.pow(2, -(n.key - 60) / 24)));
  const len = Math.ceil(Math.min(n.dur + 0.2, t60) * sr);
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const off = n.dur;
  const dt = 1 / sr;
  const gain = 0.2 * Math.pow(v, 1.1);
  for (let i = 0; i < len && start + i < out.l.length; i++) {
    const t = i * dt;
    const index = 0.4 + 2.2 * v * Math.exp(-t / 0.5);
    const mod = Math.sin(2 * Math.PI * f * t) * index;
    const bell = Math.sin(2 * Math.PI * f * 14 * t) * 0.25 * v * Math.exp(-t / 0.03);
    let env = Math.exp((-6.9 * t) / t60);
    if (t > off) env *= Math.exp((-6.9 * (t - off)) / 0.12);
    const y = (Math.sin(2 * Math.PI * f * t + mod) + bell) * env * gain * Math.min(1, t / 0.001);
    // Suitcase-style tremolo/autopan.
    const trem = Math.sin(2 * Math.PI * 4.6 * (n.t + t));
    out.l[start + i]! += y * (1 + 0.35 * trem);
    out.r[start + i]! += y * (1 - 0.35 * trem);
  }
};

// --- Modal mallets ------------------------------------------------------

function mallet(program: number): Voice {
  const spec =
    program === 12
      ? { ratios: [1, 3.93, 9.2], t60: [1.0, 0.22, 0.06], amps: [1, 0.35, 0.12], trem: 0, damp: false }
      : program === 11
        ? { ratios: [1, 3.99, 9.4], t60: [3.2, 0.9, 0.25], amps: [1, 0.22, 0.08], trem: 5.6, damp: true }
        : program === 13
          ? { ratios: [1, 3.0, 6.3], t60: [0.5, 0.18, 0.08], amps: [1, 0.4, 0.2], trem: 0, damp: false }
          : program === 114
            ? { ratios: [1, 2, 3.01, 4.02], t60: [1.1, 0.6, 0.3, 0.15], amps: [1, 0.55, 0.3, 0.12], trem: 0, damp: false }
            : program >= 115
              ? { ratios: [1, 1.6, 2.3], t60: [0.25, 0.1, 0.05], amps: [1, 0.5, 0.3], trem: 0, damp: false }
          : { ratios: [1, 2.76, 5.4, 8.93], t60: [2.0, 0.8, 0.4, 0.2], amps: [1, 0.4, 0.2, 0.1], trem: 0, damp: false };
  return (out, n, sr) => {
    const f = mtof(n.key);
    const v = n.vel / 127;
    const reg = Math.pow(2, -(n.key - 60) / 24);
    const maxT = spec.t60[0]! * reg;
    const len = Math.ceil((spec.damp ? Math.min(n.dur + 0.3, maxT) : maxT) * sr);
    const start = Math.round(n.t * sr) - (out.base ?? 0);
    const noise = new Noise(n.key * 31 + 7);
    const click = new Svf(sr);
    click.set(Math.min(8000, f * 6), 1.2);
    const gain = 0.25 * Math.pow(v, 1.2);
    for (let i = 0; i < len && start + i < out.l.length; i++) {
      const t = i / sr;
      let y = 0;
      for (let m = 0; m < spec.ratios.length; m++) {
        const fm = f * spec.ratios[m]!;
        if (fm > sr * 0.45) break;
        y += spec.amps[m]! * (0.6 + 0.6 * v * (m > 0 ? 1 : 0)) * Math.sin(2 * Math.PI * fm * t) * Math.exp((-6.9 * t) / (spec.t60[m]! * reg));
      }
      if (i < 0.006 * sr) y += click.tick(noise.next()) * 0.5 * v;
      if (spec.trem) y *= 1 - 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * spec.trem * (n.t + t)));
      if (spec.damp && t > n.dur) y *= Math.exp((-6.9 * (t - n.dur)) / 0.3);
      out.l[start + i]! += y * gain;
      out.r[start + i]! += y * gain;
    }
  };
}

// --- Drawbar organ ------------------------------------------------------

const organ: Voice = (out, n, sr) => {
  const f = mtof(n.key);
  const draw = [1, 0.8, 0.5, 0.35, 0, 0.2, 0, 0.15];
  const len = Math.ceil((n.dur + 0.06) * sr);
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const gain = 0.12 * (n.vel / 127);
  for (let i = 0; i < len && start + i < out.l.length; i++) {
    const t = i / sr;
    let y = 0;
    for (let h = 0; h < draw.length; h++) if (draw[h] && f * (h + 1) < sr * 0.45) y += draw[h]! * Math.sin(2 * Math.PI * f * (h + 1) * t);
    const env = adsr(t, n.dur, 0.008, 0.01, 1, 0.05);
    const leslie = Math.sin(2 * Math.PI * 6.2 * (n.t + t));
    out.l[start + i]! += y * env * gain * (1 + 0.2 * leslie);
    out.r[start + i]! += y * env * gain * (1 - 0.2 * leslie);
  }
};

// --- Karplus-Strong pluck ----------------------------------------------

interface PluckSpec {
  /** 0 = dark, 1 = bright. */
  bright: number;
  t60: number;
  pick: number;
  thump?: number;
}

function pluck(spec: PluckSpec): Voice {
  return (out, n, sr) => {
    const f = mtof(n.key);
    const v = n.vel / 127;
    const L = sr / f;
    const S = 0.5 - 0.45 * spec.bright * (0.7 + 0.3 * v);
    const N = Math.floor(L - S);
    const frac = L - S - N;
    const ap = (1 - frac) / (1 + frac);
    const loss = Math.pow(10, -3 / (f * spec.t60 * Math.pow(2, -(n.key - 50) / 36)));
    const releaseLoss = Math.pow(10, -3 / (f * 0.08));
    const buf = new Float32Array(N + 2);
    const noise = new Noise(n.key * 104729 + Math.round(n.t * 977));
    const exc = new OnePole(sr, 800 + 7000 * spec.bright * v);
    // Excite: filtered noise with a pick-position comb.
    const pickAt = Math.max(1, Math.round(N * spec.pick));
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) raw[i] = exc.tick(noise.next());
    for (let i = 0; i < N; i++) buf[i] = raw[i]! - 0.9 * (raw[i - pickAt] ?? 0);
    const len = Math.ceil(Math.min(n.dur + 0.15, spec.t60 * 1.2) * sr);
    const start = Math.round(n.t * sr) - (out.base ?? 0);
    const offFrame = Math.round(n.dur * sr);
    const gain = 0.5 * Math.pow(v, 1.1);
    let idx = 0;
    let last = 0;
    let apState = 0;
    let apIn = 0;
    for (let i = 0; i < len && start + i < out.l.length; i++) {
      const a = buf[idx]!;
      const b = buf[(idx + 1) % N]!;
      const lp = (1 - S) * a + S * b;
      // First-order allpass for the fractional part of the loop delay.
      const y = ap * lp + apIn - ap * apState;
      apIn = lp;
      apState = y;
      const g = i > offFrame ? releaseLoss : loss;
      buf[idx] = y * g;
      idx = (idx + 1) % N;
      let s = a;
      if (spec.thump && i < 0.04 * sr) s += spec.thump * v * Math.sin(2 * Math.PI * f * (i / sr)) * (1 - i / (0.04 * sr));
      last = s * gain;
      out.l[start + i]! += last;
      out.r[start + i]! += last;
    }
  };
}

// --- Subtractive voices -------------------------------------------------

interface SubSpec {
  wave: "saw" | "pulse" | "tri";
  pw?: number;
  voices: number;
  detune: number;
  /** Square one octave down, level. */
  sub?: number;
  cutoff: number;
  keytrack: number;
  envAmt: number;
  fA: number;
  fD: number;
  fS: number;
  q: number;
  a: number;
  d: number;
  s: number;
  r: number;
  /** [rate Hz, depth cents, delay s] */
  vib?: [number, number, number];
  /** Onset pitch scoop, cents. */
  scoop?: number;
  breath?: number;
  /** [freq, q, gain] band-pass boosts on top of the low-pass. */
  formants?: [number, number, number][];
  hp?: number;
  glide?: number;
  level?: number;
}

const STRINGS: SubSpec = { wave: "saw", voices: 3, detune: 10, cutoff: 1500, keytrack: 1.2, envAmt: 900, fA: 0.4, fD: 0.6, fS: 0.8, q: 0.7, a: 0.35, d: 0.5, s: 0.9, r: 0.8, vib: [5.2, 8, 0.3], level: 0.5 };
const PAD: SubSpec = { wave: "saw", voices: 4, detune: 14, cutoff: 700, keytrack: 1, envAmt: 900, fA: 1.2, fD: 1.5, fS: 0.6, q: 1, a: 0.8, d: 1, s: 1, r: 1.4, level: 0.45 };
const POLY: SubSpec = { wave: "saw", voices: 2, detune: 8, sub: 0.3, cutoff: 500, keytrack: 2, envAmt: 3500, fA: 0.003, fD: 0.35, fS: 0.15, q: 2, a: 0.004, d: 0.3, s: 0.6, r: 0.25, level: 0.5 };
const CHOIR: SubSpec = { wave: "saw", voices: 3, detune: 9, cutoff: 1100, keytrack: 0.5, envAmt: 0, fA: 0.1, fD: 0.1, fS: 1, q: 0.7, a: 0.45, d: 0.3, s: 1, r: 0.9, vib: [5, 10, 0.3], formants: [[700, 6, 1.4], [1200, 6, 0.9], [2600, 8, 0.5]], level: 0.45 };
const SQUARE_LEAD: SubSpec = { wave: "pulse", pw: 0.5, voices: 2, detune: 6, cutoff: 1200, keytrack: 3, envAmt: 2500, fA: 0.004, fD: 0.4, fS: 0.4, q: 1.5, a: 0.005, d: 0.2, s: 0.8, r: 0.15, vib: [5.5, 12, 0.25], glide: 0.05, level: 0.4 };
const SAW_LEAD: SubSpec = { wave: "saw", voices: 2, detune: 9, cutoff: 1500, keytrack: 2, envAmt: 3000, fA: 0.004, fD: 0.35, fS: 0.45, q: 1.2, a: 0.005, d: 0.2, s: 0.85, r: 0.15, vib: [5.5, 12, 0.25], glide: 0.06, level: 0.4 };
const SYNTH_BASS: SubSpec = { wave: "saw", voices: 1, detune: 0, sub: 0.6, cutoff: 200, keytrack: 1, envAmt: 2500, fA: 0.002, fD: 0.18, fS: 0.1, q: 2.5, a: 0.002, d: 0.2, s: 0.7, r: 0.08, level: 0.6 };
const BRASS: SubSpec = { wave: "saw", voices: 2, detune: 7, cutoff: 500, keytrack: 1.2, envAmt: 3000, fA: 0.06, fD: 0.3, fS: 0.4, q: 0.9, a: 0.03, d: 0.2, s: 0.85, r: 0.12, vib: [5.5, 8, 0.35], scoop: -40, level: 0.45 };
const MUTED_TRUMPET: SubSpec = { ...BRASS, voices: 1, cutoff: 900, envAmt: 1800, hp: 600, formants: [[1500, 4, 1.5], [3000, 5, 0.6]] };
const SAX: SubSpec = { wave: "saw", voices: 1, detune: 0, cutoff: 900, keytrack: 2.5, envAmt: 1500, fA: 0.05, fD: 0.3, fS: 0.7, q: 0.8, a: 0.04, d: 0.2, s: 0.9, r: 0.1, vib: [5.3, 15, 0.3], scoop: -30, breath: 0.05, formants: [[550, 3, 0.8], [1400, 4, 0.6], [2600, 5, 0.4]], glide: 0.04, level: 0.45 };
const CLARINET: SubSpec = { wave: "pulse", pw: 0.5, voices: 1, detune: 0, cutoff: 600, keytrack: 2, envAmt: 900, fA: 0.04, fD: 0.3, fS: 0.7, q: 0.8, a: 0.04, d: 0.2, s: 0.9, r: 0.09, vib: [5, 4, 0.4], breath: 0.03, glide: 0.035, level: 0.45 };
const OBOE: SubSpec = { ...CLARINET, pw: 0.3, formants: [[1100, 5, 1.2], [2800, 6, 0.6]] };
const FLUTE: SubSpec = { wave: "tri", voices: 1, detune: 0, cutoff: 2500, keytrack: 1, envAmt: 0, fA: 0.05, fD: 0.1, fS: 1, q: 0.7, a: 0.06, d: 0.2, s: 0.9, r: 0.12, vib: [5, 10, 0.2], breath: 0.12, glide: 0.04, level: 0.5 };
const VIOLIN: SubSpec = { wave: "saw", voices: 1, detune: 0, cutoff: 2500, keytrack: 2, envAmt: 0, fA: 0.1, fD: 0.1, fS: 1, q: 0.7, a: 0.08, d: 0.2, s: 0.9, r: 0.15, vib: [5.8, 22, 0.15], breath: 0.02, formants: [[280, 2, 0.6], [450, 3, 0.5], [2800, 2, 0.5]], glide: 0.05, level: 0.4 };


function sub(spec: SubSpec): Voice {
  return (out, n, sr, prev) => {
    const v = n.vel / 127;
    const f = mtof(n.key);
    const fromKey = spec.glide && prev?.legato && Math.abs(prev.t + prev.dur - n.t) < 0.03 ? prev.key : n.key;
    const len = Math.ceil((n.dur + spec.r) * sr);
    const start = Math.round(n.t * sr) - (out.base ?? 0);
    const oscs = Array.from({ length: spec.voices }, (_, i) => new Osc((i * 0.37 + n.key * 0.01) % 1));
    const subOsc = new Osc();
    const filt = new Svf(sr);
    const forms = (spec.formants ?? []).map(([fr, q]) => {
      const s = new Svf(sr);
      s.set(fr, q);
      return s;
    });
    const hp = spec.hp ? new Svf(sr) : null;
    hp?.set(spec.hp!, 0.7);
    const breathFilt = new Svf(sr);
    breathFilt.set(Math.min(9000, f * 2.5), 1.5);
    const noise = new Noise(n.key * 15485863 + Math.round(n.t * 1000));
    const gain = (spec.level ?? 0.45) * Math.pow(v, 1.2);
    const vibPhase = (n.t * 1.7) % 1;
    for (let i = 0; i < len && start + i < out.l.length; i++) {
      const t = i / sr;
      // Pitch: glide from the previous note, onset scoop, delayed vibrato.
      let key = n.key;
      if (fromKey !== n.key) key = n.key + (fromKey - n.key) * Math.exp(-t / spec.glide!);
      let cents = 0;
      if (spec.scoop && fromKey === n.key) cents += spec.scoop * Math.exp(-t / 0.03);
      if (spec.vib && t > spec.vib[2]) {
        const depth = spec.vib[1] * Math.min(1, (t - spec.vib[2]) / 0.3);
        cents += depth * Math.sin(2 * Math.PI * (spec.vib[0] * t + vibPhase));
      }
      const hz = mtof(key + cents / 100);
      let y = 0;
      for (let o = 0; o < oscs.length; o++) {
        const det = oscs.length > 1 ? ((o / (oscs.length - 1)) * 2 - 1) * spec.detune : 0;
        const dt = (hz * Math.pow(2, det / 1200)) / sr;
        const osc = oscs[o]!;
        y += spec.wave === "saw" ? osc.saw(dt) : spec.wave === "pulse" ? osc.pulse(dt, spec.pw ?? 0.5) : tri(osc, dt);
      }
      y /= Math.sqrt(oscs.length);
      if (spec.sub) y += spec.sub * subOsc.pulse(hz / 2 / sr);
      if (spec.breath) y += spec.breath * breathFilt.tick(noise.next()) * 4;
      const fenv = adsr(t, n.dur, spec.fA, spec.fD, spec.fS, spec.r);
      filt.set(spec.cutoff + spec.keytrack * hz + spec.envAmt * fenv * (0.4 + 0.6 * v), spec.q);
      let s = filt.tick(y);
      for (let k = 0; k < forms.length; k++) s += forms[k]!.tick(y) * spec.formants![k]![2];
      if (hp) {
        hp.tick(s);
        s = hp.hp;
      }
      s *= adsr(t, n.dur, spec.a, spec.d, spec.s, spec.r) * gain;
      out.l[start + i]! += s;
      out.r[start + i]! += s;
    }
  };
}

function tri(osc: Osc, dt: number): number {
  const t = osc.phase;
  osc.phase += dt;
  if (osc.phase >= 1) osc.phase -= 1;
  return 4 * Math.abs(t - 0.5) - 1;
}

// --- Drum kit -----------------------------------------------------------

interface Kit {
  kick: { f0: number; f1: number; sweep: number; decay: number; drive: number; click: number };
  snare: { tone: number; toneDecay: number; noiseDecay: number; noiseHp: number; mix: number };
  hatScale: number;
  hatDecay: number;
  /** Low / high tom pitch (congas for hand percussion). */
  toms?: [number, number];
}

const KITS: Record<string, Kit> = {
  default: { kick: { f0: 160, f1: 50, sweep: 0.04, decay: 0.35, drive: 1.5, click: 0.3 }, snare: { tone: 190, toneDecay: 0.08, noiseDecay: 0.17, noiseHp: 1200, mix: 0.6 }, hatScale: 1, hatDecay: 0.045 },
  lofi: { kick: { f0: 120, f1: 48, sweep: 0.05, decay: 0.3, drive: 1.2, click: 0.15 }, snare: { tone: 180, toneDecay: 0.06, noiseDecay: 0.14, noiseHp: 900, mix: 0.55 }, hatScale: 0.8, hatDecay: 0.035 },
  synthwave: { kick: { f0: 180, f1: 46, sweep: 0.03, decay: 0.45, drive: 2, click: 0.4 }, snare: { tone: 200, toneDecay: 0.1, noiseDecay: 0.28, noiseHp: 1500, mix: 0.7 }, hatScale: 1.1, hatDecay: 0.05 },
  electro_swing: { kick: { f0: 200, f1: 52, sweep: 0.025, decay: 0.32, drive: 2.5, click: 0.5 }, snare: { tone: 210, toneDecay: 0.06, noiseDecay: 0.16, noiseHp: 1800, mix: 0.65 }, hatScale: 1.2, hatDecay: 0.04 },
  // Brushes: little tone, a long soft swish.
  jazz_trio: { kick: { f0: 95, f1: 52, sweep: 0.04, decay: 0.25, drive: 1, click: 0.05 }, snare: { tone: 190, toneDecay: 0.04, noiseDecay: 0.3, noiseHp: 2500, mix: 0.85 }, hatScale: 0.9, hatDecay: 0.06 },
  retro: { kick: { f0: 300, f1: 50, sweep: 0.02, decay: 0.15, drive: 3, click: 0.6 }, snare: { tone: 240, toneDecay: 0.04, noiseDecay: 0.1, noiseHp: 800, mix: 0.9 }, hatScale: 1.4, hatDecay: 0.03 },
  metroid: { kick: { f0: 150, f1: 42, sweep: 0.05, decay: 0.5, drive: 1.8, click: 0.2 }, snare: { tone: 170, toneDecay: 0.1, noiseDecay: 0.25, noiseHp: 1000, mix: 0.7 }, hatScale: 0.9, hatDecay: 0.05 },
  monkey_island: { kick: { f0: 110, f1: 60, sweep: 0.03, decay: 0.2, drive: 1, click: 0.1 }, snare: { tone: 330, toneDecay: 0.05, noiseDecay: 0.06, noiseHp: 2000, mix: 0.35 }, hatScale: 1, hatDecay: 0.03, toms: [210, 320] },
  bossa_nova: { kick: { f0: 90, f1: 50, sweep: 0.04, decay: 0.22, drive: 1, click: 0.05 }, snare: { tone: 190, toneDecay: 0.04, noiseDecay: 0.28, noiseHp: 2500, mix: 0.85 }, hatScale: 0.9, hatDecay: 0.05 },
  funk: { kick: { f0: 170, f1: 50, sweep: 0.03, decay: 0.3, drive: 1.8, click: 0.35 }, snare: { tone: 220, toneDecay: 0.07, noiseDecay: 0.14, noiseHp: 1600, mix: 0.6 }, hatScale: 1.1, hatDecay: 0.035 },
  // Gallop on deep floor toms.
  western: { kick: { f0: 100, f1: 50, sweep: 0.04, decay: 0.25, drive: 1, click: 0.1 }, snare: { tone: 210, toneDecay: 0.05, noiseDecay: 0.12, noiseHp: 1500, mix: 0.6 }, hatScale: 1, hatDecay: 0.04, toms: [95, 150] },
  // Bodhrán on the toms; a tight pipe-band snare.
  celtic: { kick: { f0: 100, f1: 55, sweep: 0.03, decay: 0.2, drive: 1, click: 0.05 }, snare: { tone: 280, toneDecay: 0.03, noiseDecay: 0.09, noiseHp: 2500, mix: 0.75 }, hatScale: 1, hatDecay: 0.03, toms: [110, 180] },
  musette: { kick: { f0: 95, f1: 52, sweep: 0.04, decay: 0.22, drive: 1, click: 0.05 }, snare: { tone: 190, toneDecay: 0.04, noiseDecay: 0.3, noiseHp: 2500, mix: 0.85 }, hatScale: 0.9, hatDecay: 0.06 },
  liquid_dnb: { kick: { f0: 160, f1: 48, sweep: 0.04, decay: 0.32, drive: 1.6, click: 0.3 }, snare: { tone: 230, toneDecay: 0.08, noiseDecay: 0.18, noiseHp: 1800, mix: 0.65 }, hatScale: 1.2, hatDecay: 0.03 },
  castlevania: { kick: { f0: 190, f1: 48, sweep: 0.03, decay: 0.35, drive: 2.2, click: 0.45 }, snare: { tone: 200, toneDecay: 0.09, noiseDecay: 0.22, noiseHp: 1300, mix: 0.7 }, hatScale: 1.1, hatDecay: 0.04 },
  // Timpani on the toms.
  jrpg: { kick: { f0: 120, f1: 48, sweep: 0.04, decay: 0.35, drive: 1.3, click: 0.15 }, snare: { tone: 190, toneDecay: 0.05, noiseDecay: 0.2, noiseHp: 1800, mix: 0.8 }, hatScale: 1, hatDecay: 0.045, toms: [70, 105] },
};

const HAT_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800];

function drum(out: Stereo, n: ScoreNote, sr: number, kit: Kit): void {
  const v = Math.pow(n.vel / 127, 1.4);
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const noise = new Noise(n.key * 2654435761 + Math.round(n.t * 1000));
  const write = (len: number, pan: number, fn: (t: number, i: number) => number) => {
    const gl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const gr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const frames = Math.ceil(len * sr);
    for (let i = 0; i < frames && start + i < out.l.length; i++) {
      const s = fn(i / sr, i) * v;
      out.l[start + i]! += s * gl;
      out.r[start + i]! += s * gr;
    }
  };
  const metal = (decay: number, hpHz: number, pan: number, level: number) => {
    const oscs = HAT_FREQS.map((_, i) => new Osc(i * 0.13));
    const bp = new Svf(sr);
    bp.set(10000, 1);
    const hp = new Svf(sr);
    hp.set(hpHz, 0.7);
    write(decay * 5, pan, (t) => {
      let y = 0;
      for (let k = 0; k < oscs.length; k++) y += oscs[k]!.pulse((HAT_FREQS[k]! * kit.hatScale * 1.7) / sr);
      y = y * 0.5 + noise.next() * 0.4;
      bp.tick(y);
      hp.tick(bp.bp);
      return hp.hp * Math.exp(-t / decay) * level;
    });
  };
  switch (n.key) {
    case 35:
    case 36: {
      const k = kit.kick;
      let ph = 0;
      write(k.decay * 3, 0, (t) => {
        const f = k.f1 + (k.f0 - k.f1) * Math.exp(-t / k.sweep);
        ph += f / sr;
        const body = Math.sin(2 * Math.PI * ph) * Math.exp(-t / k.decay);
        const click = t < 0.004 ? noise.next() * k.click * (1 - t / 0.004) : 0;
        return Math.tanh((body + click) * k.drive) * 0.8;
      });
      break;
    }
    case 38:
    case 40: {
      const s = kit.snare;
      const hp = new Svf(sr);
      hp.set(s.noiseHp, 0.8);
      write(0.6, 0.05, (t) => {
        const tone = (Math.sin(2 * Math.PI * s.tone * t) + 0.5 * Math.sin(2 * Math.PI * s.tone * 1.73 * t)) * Math.exp(-t / s.toneDecay);
        hp.tick(noise.next());
        const nz = hp.hp * Math.exp(-t / s.noiseDecay);
        return (tone * (1 - s.mix) + nz * s.mix) * 0.7;
      });
      break;
    }
    case 37: {
      const bp = new Svf(sr);
      bp.set(1700, 3);
      write(0.08, 0.1, (t) => {
        bp.tick(noise.next());
        return (bp.bp * 2 + Math.sin(2 * Math.PI * 820 * t)) * Math.exp(-t / 0.012) * 0.5;
      });
      break;
    }
    case 39: {
      const bp = new Svf(sr);
      bp.set(1200, 1.5);
      write(0.4, -0.1, (t) => {
        bp.tick(noise.next());
        const bursts = t < 0.03 ? Math.exp(-(t % 0.01) / 0.003) : Math.exp(-(t - 0.03) / 0.12);
        return bp.bp * bursts * 1.6;
      });
      break;
    }
    case 42:
    case 44:
      metal(kit.hatDecay, 7000, 0.3, 0.55);
      break;
    case 46:
      metal(0.28, 7000, 0.3, 0.45);
      break;
    case 51:
    case 59:
      metal(0.9, 4500, -0.35, 0.3);
      break;
    case 49:
    case 57:
      metal(1.4, 3500, -0.4, 0.45);
      break;
    case 45:
    case 47:
    case 48:
    case 50: {
      const f0 = n.key >= 48 ? (kit.toms?.[1] ?? 190) : (kit.toms?.[0] ?? 120);
      let ph = 0;
      write(0.8, n.key >= 48 ? 0.25 : -0.25, (t) => {
        ph += (f0 * (1 + 0.5 * Math.exp(-t / 0.03))) / sr;
        return Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.22) * 0.7;
      });
      break;
    }
    default: {
      // Shaker and anything else: a short swell of high noise.
      const hp = new Svf(sr);
      hp.set(6000, 0.7);
      write(0.12, 0.4, (t) => {
        hp.tick(noise.next());
        return hp.hp * Math.min(1, t / 0.015) * Math.exp(-t / 0.04) * 0.4;
      });
    }
  }
}
