/**
 * Causal per-role level matching for streamed stems: the live counterpart of
 * the bench's whole-clip normalization. Tracks each stem's loudness while it
 * sounds (biased toward its louder passages) and steers a smooth gain toward
 * the role's target, so instruments sit where the corpus mix asks no matter
 * how loud the voice or sample is.
 */
import type { Stereo } from "./dsp.js";

const BLOCK = 256;

export class RoleLeveler {
  private env = 0;
  private active = 0;
  private gain = 1;
  private heard = 0;
  private readonly envCoef: number;
  private readonly upFast: number;
  private readonly up: number;
  private readonly down: number;
  private readonly glide: number;

  constructor(
    private readonly sampleRate: number,
    public target: number,
  ) {
    const k = (s: number) => 1 - Math.exp(-BLOCK / (sampleRate * s));
    this.envCoef = k(0.05);
    this.upFast = k(0.15);
    this.up = k(1.5);
    this.down = k(10);
    this.glide = k(0.25);
  }

  /** New piece: forget the previous instrument's loudness. */
  reset(): void {
    this.active = 0;
    this.heard = 0;
  }

  process(s: Stereo): void {
    const n = s.l.length;
    for (let b = 0; b < n; b += BLOCK) {
      const end = Math.min(n, b + BLOCK);
      let e = 0;
      for (let i = b; i < end; i++) e += (s.l[i]! ** 2 + s.r[i]! ** 2) / 2;
      this.env += this.envCoef * (e / (end - b) - this.env);
      if (this.env > 1e-9 && this.env > this.active * 0.02) {
        if (this.active === 0) this.active = this.env;
        const rising = this.env > this.active;
        const c = rising ? (this.heard < 1 ? this.upFast : this.up) : this.down;
        this.active += c * (this.env - this.active);
        this.heard += (end - b) / this.sampleRate;
      }
      const want = this.active > 0 ? Math.min(30, Math.max(1 / 30, this.target / Math.sqrt(this.active))) : 1;
      const from = this.gain;
      this.gain += (this.heard < 1 ? 0.5 : this.glide) * (want - this.gain);
      for (let i = b; i < end; i++) {
        const g = from + ((this.gain - from) * (i - b)) / (end - b);
        s.l[i]! *= g;
        s.r[i]! *= g;
      }
    }
  }
}
