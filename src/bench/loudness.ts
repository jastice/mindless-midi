/**
 * Fair listening: every variant is brought to the same integrated loudness
 * (ITU-R BS.1770, gated) and peak-limited, so "louder" never wins an A/B.
 */
import type { Stereo } from "../sound/dsp.js";

export const TARGET_LUFS = -18;
const CEILING = Math.pow(10, -1 / 20);

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private readonly c: [number, number, number, number, number]) {}
  tick(x: number): number {
    const [b0, b1, b2, a1, a2] = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function kWeighting(sr: number): [Biquad, Biquad] {
  // Stage 1: high shelf (+4 dB around 1.5 kHz). Stage 2: high-pass at 38 Hz.
  const A = Math.pow(10, 4 / 40);
  let w = (2 * Math.PI * 1681.97) / sr;
  let alpha = Math.sin(w) / (2 * 0.7072);
  const cs = Math.cos(w);
  const sa = 2 * Math.sqrt(A) * alpha;
  let a0 = A + 1 - (A - 1) * cs + sa;
  const shelf = new Biquad([
    (A * (A + 1 + (A - 1) * cs + sa)) / a0,
    (-2 * A * (A - 1 + (A + 1) * cs)) / a0,
    (A * (A + 1 + (A - 1) * cs - sa)) / a0,
    (2 * (A - 1 - (A + 1) * cs)) / a0,
    (A + 1 - (A - 1) * cs - sa) / a0,
  ]);
  w = (2 * Math.PI * 38.13) / sr;
  alpha = Math.sin(w) / (2 * 0.5003);
  a0 = 1 + alpha;
  const c = Math.cos(w);
  const hp = new Biquad([(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - alpha) / a0]);
  return [shelf, hp];
}

/** Integrated loudness in LUFS. */
export function lufs(s: Stereo, sr: number): number {
  const block = Math.round(0.4 * sr);
  const step = Math.round(0.1 * sr);
  const sq = new Float64Array(s.l.length);
  for (const ch of [s.l, s.r]) {
    const [a, b] = kWeighting(sr);
    for (let i = 0; i < ch.length; i++) {
      const y = b.tick(a.tick(ch[i]!));
      sq[i]! += y * y;
    }
  }
  const prefix = new Float64Array(sq.length + 1);
  for (let i = 0; i < sq.length; i++) prefix[i + 1] = prefix[i]! + sq[i]!;
  const blocks: number[] = [];
  for (let i = 0; i + block <= sq.length; i += step) blocks.push((prefix[i + block]! - prefix[i]!) / block);
  const loud = (z: number) => -0.691 + 10 * Math.log10(z);
  const abs = blocks.filter((z) => loud(z) > -70);
  if (!abs.length) return -Infinity;
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = abs.filter((z) => loud(z) > loud(mean) - 10);
  return loud(rel.reduce((a, b) => a + b, 0) / rel.length);
}

export function peak(s: Stereo): number {
  let p = 0;
  for (let i = 0; i < s.l.length; i++) p = Math.max(p, Math.abs(s.l[i]!), Math.abs(s.r[i]!));
  return p;
}

/** Normalize to TARGET_LUFS, then a 5 ms look-ahead limiter at -1 dBFS. Returns the input loudness. */
export function matchLoudness(s: Stereo, sr: number): { lufs: number; peakDb: number } {
  const before = lufs(s, sr);
  const peakDb = 20 * Math.log10(peak(s) || 1e-9);
  if (!Number.isFinite(before)) return { lufs: before, peakDb };
  const g = Math.pow(10, (TARGET_LUFS - before) / 20);
  const n = s.l.length;
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s.l[i]! *= g;
    s.r[i]! *= g;
    const a = Math.max(Math.abs(s.l[i]!), Math.abs(s.r[i]!));
    req[i] = a > CEILING ? CEILING / a : 1;
  }
  // Sliding minimum over the look-ahead window (monotonic deque), then smooth.
  const la = Math.round(0.005 * sr);
  const minAhead = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && req[dq[tail - 1]!]! >= req[i]!) tail--;
    dq[tail++] = i;
    while (dq[head]! > i + la) head++;
    minAhead[i] = req[dq[head]!]!;
  }
  const atk = 1 - Math.exp(-1 / (0.001 * sr));
  const rel = 1 - Math.exp(-1 / (0.08 * sr));
  let gain = 1;
  for (let i = 0; i < n; i++) {
    const t = minAhead[i]!;
    gain += (t < gain ? atk : rel) * (t - gain);
    const gi = Math.min(gain, req[i]!);
    s.l[i]! *= gi;
    s.r[i]! *= gi;
  }
  return { lufs: before, peakDb };
}

export function wav(s: Stereo, sr: number): Blob {
  const n = s.l.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 4, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, s.l[i]!)) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, s.r[i]!)) * 32767, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
