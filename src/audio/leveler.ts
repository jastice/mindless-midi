/**
 * Output stage shared by the worklet and the offline renderer: the style's
 * calibrated gain, a slow automatic gain control (within ±6 dB) so quiet
 * intros and busy climaxes sit at a similar background level, and a soft
 * limiter.
 */
export const TARGET_RMS = 0.1;

export class Leveler {
  private styleGain = 1;
  private agc = 1;
  private env: number;
  private readonly envCoef: number;
  private readonly attackCoef: number;
  private readonly releaseCoef: number;
  private sinceUpdate = 0;

  constructor(
    sampleRate: number,
    private readonly target = TARGET_RMS,
    private readonly range = 2,
  ) {
    this.env = target * target;
    this.envCoef = 1 - Math.exp(-1 / (sampleRate * 0.4));
    // Updated every 128 frames: turn down within ~0.5 s when something loud
    // enters, come back up slowly (~4 s) so quiet passages stay quiet-ish.
    this.attackCoef = 1 - Math.exp(-128 / (sampleRate * 0.5));
    this.releaseCoef = 1 - Math.exp(-128 / (sampleRate * 4));
  }

  /** New piece: set its style gain and start the AGC from neutral. */
  setGain(gain: number): void {
    this.styleGain = gain;
    this.agc = 1;
    this.env = this.target * this.target;
  }

  process(left: Float32Array, right: Float32Array, offset: number, count: number): void {
    const silence = (this.target / 8) ** 2;
    for (let i = offset; i < offset + count; i++) {
      const l = left[i]! * this.styleGain;
      const r = right[i]! * this.styleGain;
      this.env += this.envCoef * ((l * l + r * r) / 2 - this.env);
      if (++this.sinceUpdate >= 128) {
        this.sinceUpdate = 0;
        // Don't adapt during silence (gaps between pieces, sparse intros).
        if (this.env > silence) {
          const want = Math.max(1 / this.range, Math.min(this.range, this.target / Math.sqrt(this.env)));
          this.agc += (want < this.agc ? this.attackCoef : this.releaseCoef) * (want - this.agc);
        }
      }
      left[i] = softClip(l * this.agc);
      right[i] = softClip(r * this.agc);
    }
  }
}

const KNEE = 0.8;

export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  const y = KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE));
  return x < 0 ? -y : y;
}
