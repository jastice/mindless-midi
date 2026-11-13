/**
 * Level matching that corrects how loud an instrument is without following the
 * performance: the counterpart of `RoleLeveler` for a mix that keeps its hits
 * and its dynamics.
 *
 * `RoleLeveler` steers each stem toward a fixed loudness with a gain that
 * reacts within a second, so one loud hit pulls a stem down and a quiet
 * section is turned back up. This one:
 *
 *  - measures the body of the sound: mean energy over everything the stem has
 *    played in the piece, forgetting slowly and capping what one block can
 *    add, so a hit or a burst barely moves it;
 *  - is told how far the section leans in (the arranger scales every velocity
 *    by the section's intensity) and divides that out, so what it estimates is
 *    the instrument at full strength. A quiet section stays quiet, and each
 *    instrument still sits where the corpus mix asks when the piece is in full swing;
 *  - looks at a whole chunk before applying gain to it, so an instrument is at
 *    its level from its first note, with no settling.
 *
 * Several stems can share one leveller (a kit's kick and the rest of the kit):
 * they are measured together and get the same gain, so their balance holds.
 */
import type { Stereo } from "./dsp.js";

/**
 * Seconds per measured block: long enough to hold a hit together with its
 * ring, so a peaky stem (a sampled kit) reads as loud as it is. Short blocks
 * would see mostly ring, and the cap below would discount the hits.
 */
const BLOCK_SECONDS = 0.2;
/** Seconds of memory: the estimate is a mean over about this much sounding audio. */
const MEMORY = 20;
/** Below this many seconds heard, a chunk gets one gain from its start, not a glide. */
const SETTLED = 0.5;
/** Blocks this far under the mean (in energy) are tails and gaps, not the instrument playing. */
const GATE = 0.03;
/** Once settled, a block counts for at most this many times the mean: a hit is heard, a burst can't drag the estimate. */
const CEILING = 4;
export class BodyLeveler {
  private energy = 0;
  private weight = 0;
  private heard = 0;
  private current = 1;
  private readonly forget: number;
  private readonly block: number;

  constructor(
    private readonly sampleRate: number,
    public target: number,
  ) {
    this.block = Math.max(64, Math.round(sampleRate * BLOCK_SECONDS));
    this.forget = Math.exp(-BLOCK_SECONDS / MEMORY);
  }

  /** New piece: forget the previous instrument's loudness. */
  reset(): void {
    this.energy = 0;
    this.weight = 0;
    this.heard = 0;
  }

  /** The gain the last chunk ended on. */
  get gain(): number {
    return this.current;
  }

  /**
   * Level one chunk of one instrument, in place. `stems` are measured as their sum.
   *
   * `lean` is the share of full strength (in amplitude, 0..1] the chunk's notes
   * are played at; undefined when the chunk has no notes of its own (tails say
   * nothing about the instrument), which only applies the gain.
   */
  process(stems: readonly Stereo[], lean: number | undefined): void {
    const n = stems[0]?.l.length ?? 0;
    if (!n) return;
    const settled = this.heard >= SETTLED;
    if (lean !== undefined && lean > 0) {
      const scale = 1 / (lean * lean);
      for (let b = 0; b < n; b += this.block) {
        const end = Math.min(n, b + this.block);
        let e = 0;
        for (let i = b; i < end; i++) {
          let l = 0;
          let r = 0;
          for (const s of stems) {
            l += s.l[i]!;
            r += s.r[i]!;
          }
          e += (l * l + r * r) / 2;
        }
        e = (e / (end - b)) * scale;
        const mean = this.weight > 0 ? this.energy / this.weight : 0;
        if (e < 1e-10 || e < mean * GATE) continue;
        if (this.heard >= SETTLED) e = Math.min(e, mean * CEILING);
        this.energy = this.energy * this.forget + e;
        this.weight = this.weight * this.forget + 1;
        this.heard += (end - b) / this.sampleRate;
      }
    }
    const from = this.current;
    const want = this.weight > 0 ? Math.min(30, Math.max(1 / 30, this.target / Math.sqrt(this.energy / this.weight))) : from;
    this.current = want;
    for (const s of stems) {
      for (let i = 0; i < n; i++) {
        const g = settled ? from + ((want - from) * i) / n : want;
        s.l[i]! *= g;
        s.r[i]! *= g;
      }
    }
  }
}
