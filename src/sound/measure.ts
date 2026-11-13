/**
 * Numbers for how heavy a mix is, so "more weight" can be asserted in a test
 * and read beside a reference in the bench instead of argued by ear:
 *
 *   crest          peak over RMS, dB. Levelling and limiting that follow the hits flatten it.
 *   range          spread of the short-term level, dB (95th minus 10th percentile of 3 s windows).
 *   sub, lowMid    share of the energy below 100 Hz, and from 100 to 300 Hz.
 *   lowCorrelation how alike the two channels are below 120 Hz: 1 is a mono low end.
 */
import type { Stereo } from "./dsp.js";

export interface MixNumbers {
  crest: number;
  range: number;
  sub: number;
  lowMid: number;
  lowCorrelation: number;
  /** RMS of the whole clip, linear. */
  rms: number;
}

/** A Butterworth low-pass or high-pass section (RBJ), run over a copy. */
function filter(x: Float32Array, sr: number, kind: "low" | "high", hz: number, sections = 2): Float32Array {
  let y = x;
  const w = (2 * Math.PI * Math.min(hz, sr * 0.45)) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b1 = (kind === "low" ? 1 - cos : -(1 + cos)) / a0;
  const b0 = (kind === "low" ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  for (let s = 0; s < sections; s++) {
    const out = new Float32Array(y.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i]!;
      const o = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = o;
      out[i] = o;
    }
    y = out;
  }
  return y;
}

const energy = (a: Float32Array, b: Float32Array) => {
  let e = 0;
  for (let i = 0; i < a.length; i++) e += a[i]! * a[i]! + b[i]! * b[i]!;
  return e;
};

/** Share of the clip's energy between `lo` and `hi` Hz (either may be 0 / Infinity for an open side). */
export function bandShare(s: Stereo, sr: number, lo: number, hi: number): number {
  const total = energy(s.l, s.r);
  if (total <= 0) return 0;
  let l: Float32Array = s.l;
  let r: Float32Array = s.r;
  if (lo > 0) {
    l = filter(l, sr, "high", lo);
    r = filter(r, sr, "high", lo);
  }
  if (Number.isFinite(hi)) {
    l = filter(l, sr, "low", hi);
    r = filter(r, sr, "low", hi);
  }
  return energy(l, r) / total;
}

/** Peak over RMS, dB. */
export function crestFactor(s: Stereo): number {
  let peak = 0;
  for (let i = 0; i < s.l.length; i++) peak = Math.max(peak, Math.abs(s.l[i]!), Math.abs(s.r[i]!));
  const rms = Math.sqrt(energy(s.l, s.r) / (2 * Math.max(1, s.l.length)));
  return rms > 0 ? 20 * Math.log10(peak / rms) : 0;
}

/** Spread of the short-term level, dB: 3 s windows a second apart, ignoring ones 20 dB under the loudest. */
export function levelRange(s: Stereo, sr: number): number {
  const win = Math.round(3 * sr);
  const hop = Math.round(sr);
  const levels: number[] = [];
  for (let at = 0; at + win <= s.l.length; at += hop) {
    let e = 0;
    for (let i = at; i < at + win; i++) e += s.l[i]! * s.l[i]! + s.r[i]! * s.r[i]!;
    if (e > 0) levels.push(10 * Math.log10(e / (2 * win)));
  }
  if (levels.length < 2) return 0;
  const top = Math.max(...levels);
  const kept = levels.filter((x) => x > top - 20).sort((a, b) => a - b);
  const at = (q: number) => kept[Math.min(kept.length - 1, Math.floor(q * kept.length))]!;
  return at(0.95) - at(0.1);
}

/** Correlation of left and right below `hz`: 1 mono, 0 unrelated, -1 out of phase. */
export function lowCorrelation(s: Stereo, sr: number, hz = 120): number {
  const l = filter(s.l, sr, "low", hz);
  const r = filter(s.r, sr, "low", hz);
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < l.length; i++) {
    lr += l[i]! * r[i]!;
    ll += l[i]! * l[i]!;
    rr += r[i]! * r[i]!;
  }
  return ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
}

export function measureWeight(s: Stereo, sr: number): MixNumbers {
  return {
    crest: crestFactor(s),
    range: levelRange(s, sr),
    sub: bandShare(s, sr, 0, 100),
    lowMid: bandShare(s, sr, 100, 300),
    lowCorrelation: lowCorrelation(s, sr),
    rms: Math.sqrt(energy(s.l, s.r) / (2 * Math.max(1, s.l.length))),
  };
}
