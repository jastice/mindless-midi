/**
 * Weight: the part of the mix that makes a bar hit, done on the stems before
 * they reach the bus (so it is plain arithmetic that runs in the render worker
 * and in a test alike).
 *
 *   kick      its own stem until here: driven, lifted at the bottom, scooped in the box
 *   ducking   from the kick's actual envelope, so a ghost kick barely moves the pad
 *   bass      driven, with its own shelf, kept out of the kick's octave
 *   drums     a hard-compressed copy blended under the dry kit
 *   low end   mono below about 100 Hz on every stem
 *
 * A style sets how much of each (`weightFor`), and a section's intensity moves
 * the ducking, the drive and the compressed copy around that: a chorus hits
 * harder than a verse without a note being different.
 */
import type { Role } from "../corpus/constants.js";
import { presetFor } from "./bus.js";
import type { Stereo } from "./dsp.js";

/** A stem as the weighted mix sees it: the kick is split from the rest of the kit. */
export type StemId = Role | "kick";

export interface Weight {
  /** Saturation, 0 = clean, 3 = thick. */
  kickDrive: number;
  bassDrive: number;
  /** Level of the compressed copy under the drums, relative to the dry kit. */
  crush: number;
  /** How far a full kick pushes each role down, 0..1. */
  duck: Partial<Record<Role, number>>;
  /** Seconds for a ducked role to come back. */
  release: number;
  /** Low shelf on the kick, dB. */
  thump: number;
}

const HARD: Weight = { kickDrive: 1.8, bassDrive: 1.5, crush: 0.3, duck: { bass: 0.3, pad: 0.45, comp: 0.3, arp: 0.2 }, release: 0.2, thump: 2 };
const MID: Weight = { kickDrive: 1.3, bassDrive: 1.1, crush: 0.22, duck: { bass: 0.15, pad: 0.2 }, release: 0.22, thump: 1.5 };
const SOFT: Weight = { kickDrive: 0.6, bassDrive: 0.5, crush: 0.12, duck: {}, release: 0.25, thump: 1 };

const TIERS: Record<string, Weight> = {
  synthwave: HARD, liquid_dnb: HARD, disco: HARD, electro_swing: HARD, funk: HARD, castlevania: HARD, retro: HARD, metroid: HARD,
  // A dusty kit: thump and pump, little grit.
  lofi: { ...HARD, kickDrive: 1.2, bassDrive: 0.9 },
  minimal_techno: HARD,
  jazz_trio: SOFT, minimalist: SOFT, baroque: SOFT, celtic: SOFT, musette: SOFT, midnight_platform: SOFT, bossa_nova: SOFT,
};

/** A style's weight. Where its mix preset already says which roles duck, that stands (a style can keep its bass unducked). */
export function weightFor(styleId: string): Weight {
  const tier = TIERS[styleId] ?? MID;
  const duck = presetFor(styleId).duck;
  return duck ? { ...tier, duck: duck.depth, release: duck.release } : tier;
}

/** Low shelf and one mid band per stem, [shelf Hz, shelf dB, mid Hz, mid dB, mid Q]: kick and bass get separate space. */
const EQ: Partial<Record<StemId, [number, number, number, number, number]>> = {
  kick: [70, 0, 280, -3, 1],
  bass: [110, 2, 60, -2.5, 1.4],
  pad: [200, -1.5, 300, -1.5, 0.8],
  comp: [200, -1, 350, -1.5, 0.8],
  lead: [200, 0, 2600, 1.5, 0.8],
};

const MONO_BELOW = 105;
/** Samples over which a section's new intensity is reached. */
const RAMP = 2048;

/** One RBJ biquad, two channels of state. */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private readonly z = new Float64Array(8);
  private key = "";

  constructor(private readonly sr: number) {}

  set(kind: "lowshelf" | "peak" | "highpass", hz: number, db: number, q: number): this {
    const key = `${kind}/${hz}/${db}/${q}`;
    if (key === this.key) return this;
    this.key = key;
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * hz) / this.sr;
    const cos = Math.cos(w);
    const sin = Math.sin(w);
    const alpha = sin / (2 * q);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (kind === "peak") {
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
    } else if (kind === "lowshelf") {
      const k = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + k);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - k);
      a0 = A + 1 + (A - 1) * cos + k;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - k;
    } else {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  /** One sample of channel `c` (0 or 1). */
  tick(x: number, c: number): number {
    const z = this.z;
    const o = c * 4;
    const y = this.b0 * x + this.b1 * z[o]! + this.b2 * z[o + 1]! - this.a1 * z[o + 2]! - this.a2 * z[o + 3]!;
    z[o + 1] = z[o]!;
    z[o] = x;
    z[o + 3] = z[o + 2]!;
    z[o + 2] = y;
    return y;
  }

  run(s: Stereo): void {
    for (let i = 0; i < s.l.length; i++) {
      s.l[i] = this.tick(s.l[i]!, 0);
      s.r[i] = this.tick(s.r[i]!, 1);
    }
  }
}

/** The loudest a signal has been lately: what "a full hit" means for drive and thresholds, whatever the stem's level. */
class Reference {
  value = 1e-4;
  private readonly decay: number;
  constructor(sr: number, seconds = 8) {
    this.decay = Math.exp(-1 / (sr * seconds));
  }
  tick(abs: number): number {
    this.value = Math.max(abs, this.value * this.decay, 1e-4);
    return this.value;
  }
}

/** Per-stem state that lasts across chunks. */
interface Chain {
  shelf: Biquad;
  mid: Biquad;
  /** Two high-pass sections on the side signal: what is left of it below the crossover is 24 dB an octave down. */
  side: [Biquad, Biquad];
  peak: Reference;
}

export class WeightedMix {
  private readonly chains = new Map<StemId, Chain>();
  private readonly kickPeak: Reference;
  private readonly drumPeak: Reference;
  private kickEnv = 0;
  private drumEnv = 0;
  /** Intensity scale the last chunk ended on. */
  private scale = 1;
  private readonly attack: number;
  private readonly crushRelease: number;

  constructor(private readonly sr: number) {
    this.kickPeak = new Reference(sr);
    this.drumPeak = new Reference(sr);
    this.attack = Math.exp(-1 / (sr * 0.002));
    this.crushRelease = Math.exp(-1 / (sr * 0.09));
  }

  private chain(id: StemId): Chain {
    let c = this.chains.get(id);
    if (!c) this.chains.set(id, (c = { shelf: new Biquad(this.sr), mid: new Biquad(this.sr), side: [new Biquad(this.sr), new Biquad(this.sr)], peak: new Reference(this.sr) }));
    return c;
  }

  /**
   * Mix one chunk of levelled stems, in place; the kick ends up inside the
   * drum stem. `intensity` is the section's (0..1).
   */
  process(stems: Map<StemId, Stereo>, weight: Weight, intensity: number): Map<Role, Stereo> {
    const n = [...stems.values()][0]?.l.length ?? 0;
    const to = 0.6 + 0.8 * Math.max(0, Math.min(1, intensity));
    const from = this.scale;
    this.scale = to;
    const scaleAt = (i: number) => (i >= RAMP ? to : from + ((to - from) * i) / RAMP);
    const kick = stems.get("kick");

    // The kick's envelope, 0..1 of a full kick, for the ducked roles.
    let env: Float32Array | null = null;
    if (kick) {
      env = new Float32Array(n);
      const release = Math.exp(-1 / (this.sr * weight.release));
      for (let i = 0; i < n; i++) {
        const a = Math.max(Math.abs(kick.l[i]!), Math.abs(kick.r[i]!));
        this.kickEnv = a > this.kickEnv ? a + (this.kickEnv - a) * this.attack : a + (this.kickEnv - a) * release;
        env[i] = Math.min(1, this.kickEnv / this.kickPeak.tick(a));
      }
    } else {
      // No kick this chunk: let a ducked role finish coming back.
      this.kickEnv = 0;
    }

    for (const [id, s] of stems) {
      const c = this.chain(id);
      const depth = id === "kick" || id === "drums" ? 0 : (weight.duck[id] ?? 0);
      if (env && depth > 0) {
        for (let i = 0; i < n; i++) {
          const g = 1 - Math.min(0.9, depth * scaleAt(i)) * env[i]!;
          s.l[i]! *= g;
          s.r[i]! *= g;
        }
      }
      const drive = id === "kick" ? weight.kickDrive : id === "bass" ? weight.bassDrive : 0;
      if (drive > 0) {
        for (let i = 0; i < n; i++) {
          const ref = c.peak.tick(Math.max(Math.abs(s.l[i]!), Math.abs(s.r[i]!)));
          const d = Math.max(0.05, drive * scaleAt(i));
          // Peaks are rounded off and the body under them comes up a little: denser, at about the same loudness.
          const k = (ref * Math.pow(d / Math.tanh(d), 0.3)) / d;
          s.l[i] = k * Math.tanh((d * s.l[i]!) / ref);
          s.r[i] = k * Math.tanh((d * s.r[i]!) / ref);
        }
      }
      const eq = EQ[id];
      const shelfDb = (eq?.[1] ?? 0) + (id === "kick" ? weight.thump : 0);
      if (eq && shelfDb !== 0) c.shelf.set("lowshelf", eq[0], shelfDb, Math.SQRT1_2).run(s);
      if (eq && eq[3] !== 0) c.mid.set("peak", eq[2], eq[3], eq[4]).run(s);
      // Mono below the crossover: the difference between the channels is high-passed, their sum is left alone.
      for (const f of c.side) f.set("highpass", MONO_BELOW, 0, Math.SQRT1_2);
      for (let i = 0; i < n; i++) {
        const mid = (s.l[i]! + s.r[i]!) / 2;
        const side = c.side[1].tick(c.side[0].tick((s.l[i]! - s.r[i]!) / 2, 0), 0);
        s.l[i] = mid + side;
        s.r[i] = mid - side;
      }
    }

    const out = new Map<Role, Stereo>();
    for (const [id, s] of stems) if (id !== "kick") out.set(id, s);
    if (kick) {
      const drums = out.get("drums");
      if (drums) {
        for (let i = 0; i < n; i++) {
          drums.l[i]! += kick.l[i]!;
          drums.r[i]! += kick.r[i]!;
        }
      } else out.set("drums", kick);
    }
    const drums = out.get("drums");
    if (drums && weight.crush > 0) this.crush(drums, weight.crush, scaleAt);
    return out;
  }

  /** Parallel compression: a copy squeezed 6:1 from 15 dB under a full hit, made up, added under the dry kit. */
  private crush(s: Stereo, amount: number, scaleAt: (i: number) => number): void {
    const THRESHOLD = 0.18;
    const SLOPE = 1 / 6 - 1;
    // A full hit comes out of the copy at half its dry peak.
    const MAKEUP = 0.5 / Math.pow(THRESHOLD, -SLOPE);
    for (let i = 0; i < s.l.length; i++) {
      const a = Math.max(Math.abs(s.l[i]!), Math.abs(s.r[i]!));
      this.drumEnv = a > this.drumEnv ? a + (this.drumEnv - a) * this.attack : a + (this.drumEnv - a) * this.crushRelease;
      const over = this.drumEnv / (this.drumPeak.tick(a) * THRESHOLD);
      const g = 1 + amount * scaleAt(i) * MAKEUP * (over > 1 ? Math.pow(over, SLOPE) : 1);
      s.l[i]! *= g;
      s.r[i]! *= g;
    }
  }
}
