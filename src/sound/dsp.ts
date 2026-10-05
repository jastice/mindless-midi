/** Small, allocation-free DSP building blocks shared by the sound engines. */

export type Samples = Float32Array<ArrayBuffer>;

export interface Stereo {
  l: Samples;
  r: Samples;
  /**
   * Absolute frame of index 0. Voices write at `round(t * sr) - base`, so the
   * same code renders a whole clip (base 0) or into a sliding window.
   */
  base?: number;
}

export function stereo(frames: number): Stereo {
  return { l: new Float32Array(frames), r: new Float32Array(frames) };
}

export const mtof = (key: number) => 440 * Math.pow(2, (key - 69) / 12);

/** Deterministic noise (xorshift32), uniform in [-1, 1). */
export class Noise {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s >>> 0;
    return this.s / 2147483648 - 1;
  }
}

/** Topology-preserving state variable filter (Cytomic/Simper). Stable under fast modulation. */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private g = 0;
  private k = 1;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  constructor(private readonly sr: number) {}
  set(cutoff: number, q: number): void {
    const fc = Math.min(cutoff, this.sr * 0.45);
    this.g = Math.tan((Math.PI * fc) / this.sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  tick(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

export class OnePole {
  private y = 0;
  private a = 0;
  constructor(private readonly sr: number, cutoff = 1000) {
    this.set(cutoff);
  }
  set(cutoff: number): void {
    this.a = 1 - Math.exp((-2 * Math.PI * cutoff) / this.sr);
  }
  tick(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

/** Band-limited saw / pulse via PolyBLEP. */
export class Osc {
  phase: number;
  constructor(phase = 0) {
    this.phase = phase;
  }
  saw(dt: number): number {
    const t = this.phase;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    return 2 * t - 1 - polyBlep(t, dt);
  }
  pulse(dt: number, width = 0.5): number {
    const t = this.phase;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    let y = t < width ? 1 : -1;
    y += polyBlep(t, dt);
    let t2 = t - width;
    if (t2 < 0) t2 += 1;
    y -= polyBlep(t2, dt);
    return y;
  }
  sine(dt: number): number {
    const t = this.phase;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    return Math.sin(2 * Math.PI * t);
  }
}

/** Linear-segment ADSR evaluated by time; release starts at `off`. */
export function adsr(t: number, off: number, a: number, d: number, s: number, r: number): number {
  const held = (x: number) => (x < a ? x / a : x < a + d ? 1 - ((1 - s) * (x - a)) / d : s);
  if (t < off) return held(t);
  const from = held(off);
  const x = (t - off) / r;
  return x >= 1 ? 0 : from * (1 - x);
}

/** Add a mono buffer into a stereo one at `start` with constant-power pan (-1..1). */
export function addPanned(out: Stereo, mono: Float32Array, start: number, pan: number, gain = 1): void {
  const a = ((pan + 1) * Math.PI) / 4;
  const gl = Math.cos(a) * gain * Math.SQRT2;
  const gr = Math.sin(a) * gain * Math.SQRT2;
  const n = Math.min(mono.length, out.l.length - start);
  for (let i = 0; i < n; i++) {
    out.l[start + i]! += mono[i]! * gl;
    out.r[start + i]! += mono[i]! * gr;
  }
}

/**
 * Loudness while the part is sounding: RMS over the loudest quarter of 50 ms
 * windows (the same measure the OPL calibration uses).
 */
export function activeRms(s: Stereo, sampleRate: number, top = 0.25): number {
  const win = Math.round(sampleRate * 0.05);
  const energies: number[] = [];
  for (let start = 0; start + win <= s.l.length; start += win) {
    let e = 0;
    for (let i = start; i < start + win; i++) e += (s.l[i]! ** 2 + s.r[i]! ** 2) / 2;
    energies.push(e / win);
  }
  energies.sort((a, b) => b - a);
  const n = Math.max(1, Math.floor(energies.length * top));
  return Math.sqrt(energies.slice(0, n).reduce((a, b) => a + b, 0) / n);
}

/** Let the UI breathe during long synchronous renders. */
export const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A per-role sliding window of future audio. Voices add whole notes into it
 * (they may ring for seconds past the current bar); `take` hands out the
 * finished frames and slides the window forward.
 */
export class StemWindow implements Stereo {
  l: Samples;
  r: Samples;
  base: number;
  constructor(base: number, private readonly capacity: number) {
    this.base = base;
    this.l = new Float32Array(capacity);
    this.r = new Float32Array(capacity);
  }
  /** Copy out [base, base + frames) and advance. */
  take(frames: number): Stereo {
    const n = Math.min(frames, this.capacity);
    const out = { l: this.l.slice(0, n), r: this.r.slice(0, n) };
    this.l.copyWithin(0, n);
    this.r.copyWithin(0, n);
    this.l.fill(0, this.capacity - n);
    this.r.fill(0, this.capacity - n);
    this.base += n;
    return out;
  }
  /** Drop everything from `frame` on (a skip or an engine switch). */
  clearFrom(frame: number): void {
    const i = Math.max(0, frame - this.base);
    this.l.fill(0, i);
    this.r.fill(0, i);
  }
}
