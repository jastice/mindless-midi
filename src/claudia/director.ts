/**
 * The booth cam's director: which clip plays in which bars. Pure, no DOM.
 *
 * Clips start on a pose and end on one; any clip may follow one that ends on
 * its start pose, and every clip fills a whole number of bars. The director
 * reads what is coming (energy, the blend zones at either end of a track,
 * section changes) as a list of `Cue`s, one per bar, and plans a path of
 * clips through them. A drop is a target: the clips before it are chosen so
 * that the drop clip starts exactly on its section's first bar, and if no
 * combination of clips gets there, the drop is skipped and she stays put.
 *
 * Phrases are filled exactly: with 3- and 5-bar clips (Grok's 6 s and 10 s
 * takes) an 8-bar phrase is 3 + 5 or 5 + 3, so every phrase starts on a pose
 * frame. A plan that starts mid-phrase (after a seek) runs to the end of the
 * next phrase instead when the gap cannot be filled.
 *
 * Seeded by the set seed and the bar the plan starts on, so the same set from
 * the same bar gives the same booth cam. See docs/visualizer-plan.md.
 */
import { Rng } from "../theory/rng.js";

export type Pose = "home" | "cue" | "build" | "peak";
export type ClipKind = "loop" | "transition" | "flourish";
export type Energy = "low" | "mid" | "high";
/**
 * What a clip acts out between two frames of the same pose. These stand in
 * for real transitions until the full shot list exists: the cue gesture for
 * a blend, the hands-up for a drop, both starting and ending at Home.
 */
export type Scene = "blend" | "drop";

export interface Clip {
  id: string;
  kind: ClipKind;
  from: Pose;
  to: Pose;
  /** For loops: the energy they suit. */
  energy?: Energy;
  scene?: Scene;
  /** Relative to the clips base URL; named by the SHA-256 of its bytes. */
  file: string;
  /** Frames in the file; frame `frames` would be the `to` pose again. */
  frames: number;
  bars: number;
  /** Tempo at which the clip plays at ×1: bars * 4 * 60 * fps / frames. */
  bpm: number;
  /** Frames from the clip's start to its first nod on the beat; the clip starts this much before its first bar. */
  beatPhase: number;
  /** Crossfade when it follows another clip, frames. */
  fadeFrames: number;
  /** What the prep tool measured, for the record. */
  source?: Record<string, unknown>;
}

export interface ClipSet {
  fps: number;
  width: number;
  height: number;
  /** Pose stills, by file name, for before play and reduced motion. */
  stills: Partial<Record<Pose, string>>;
  clips: Clip[];
}

/** Rates a clip may play at; outside them it is not used. */
export const MIN_RATE = 0.9;
/** 1.11, not 1.10: Grok's 6 s and 10 s takes as 3 and 5 bars play at about ×1.06–1.11 across 126–132 BPM. */
export const MAX_RATE = 1.11;
/** Bars in a phrase (as `PHRASE_BARS` in the set conductor). Every phrase starts on a clip boundary, on a pose frame. */
export const PHRASE = 8;
/** A section at least this much more intense than the one before is a drop. */
export const DROP_RISE = 0.2;
/** Bars of a track's start and end the director treats as a blend zone. */
export const BLEND_BARS = 16;
/** Plan at least this many bars ahead. */
export const PLAN_BARS = 8;

/** What the director knows about one bar. */
export interface Cue {
  bpm: number;
  intensity: number;
  /** Where the bar sits in its track's mix. */
  mix: "in" | "body" | "out";
  /** The bar starts a section that rises at least DROP_RISE. */
  drop: boolean;
  /** Which track and bar this is, to tell when the music turned out other than planned. */
  piece: number;
  barInPiece: number;
}

/** A clip placed on the bars: it starts on bar `bar` (the caller's count) and fills `clip.bars` bars. */
export interface Placement {
  clip: Clip;
  bar: number;
}

export interface Section {
  start: number;
  bars: number;
  intensity: number;
}

/** What the current bar says about itself (a subset of BarInfo). */
export interface BarFacts {
  pieceIndex: number;
  barInPiece: number;
  pieceBars: number;
  intensity: number;
}

/**
 * Cues from this bar to the end of its track, from its sections, then
 * `nextBars` of the next track as far as it can be known: a blend zone at its
 * start and a middling energy, no drops.
 */
export function cuesFor(bar: BarFacts, bpm: number, sections: readonly Section[] | null, nextBars = 2 * BLEND_BARS): Cue[] {
  const out: Cue[] = [];
  const secs = sections?.length ? sections : [{ start: 0, bars: bar.pieceBars, intensity: bar.intensity }];
  const blend = Math.min(BLEND_BARS, Math.floor(bar.pieceBars / 3));
  for (let b = bar.barInPiece; b < bar.pieceBars; b++) {
    let k = 0;
    while (k + 1 < secs.length && secs[k + 1]!.start <= b) k++;
    const sec = secs[Math.max(0, k)]!;
    const before = k > 0 ? secs[k - 1] : undefined;
    out.push({
      bpm,
      intensity: sec.intensity,
      mix: b < blend ? "in" : bar.pieceBars - b <= blend ? "out" : "body",
      drop: !!before && sec.start === b && sec.intensity - before.intensity >= DROP_RISE,
      piece: bar.pieceIndex,
      barInPiece: b,
    });
  }
  for (let b = 0; b < nextBars; b++) out.push({ bpm, intensity: 0.5, mix: b < BLEND_BARS ? "in" : "body", drop: false, piece: bar.pieceIndex + 1, barInPiece: b });
  return out;
}

export function energyOf(intensity: number): Energy {
  return intensity < 0.45 ? "low" : intensity < 0.7 ? "mid" : "high";
}

export const rateOf = (clip: Clip, bpm: number) => bpm / clip.bpm;
const usable = (clip: Clip, bpm: number) => {
  const r = rateOf(clip, bpm);
  return r >= MIN_RATE && r <= MAX_RATE;
};

const ENERGY_STEP: Record<Energy, number> = { low: 0, mid: 1, high: 2 };

export class Director {
  readonly set: ClipSet;
  readonly seed: string;
  private readonly poses: Set<Pose>;

  constructor(set: ClipSet, seed: string) {
    if (!set.clips.length) throw new Error("no clips");
    this.set = set;
    this.seed = seed;
    this.poses = new Set(set.clips.flatMap((c) => [c.from, c.to]));
  }

  /** The clips that may play from `pose` at `bpm`; if none suits the tempo, the Home-ward loop that comes closest. */
  candidates(pose: Pose, bpm: number): Clip[] {
    const from = this.set.clips.filter((c) => c.from === pose);
    const ok = from.filter((c) => usable(c, bpm));
    if (ok.length) return ok;
    const loops = from.filter((c) => c.from === c.to && !c.scene);
    const pool = loops.length ? loops : from;
    if (!pool.length) return [];
    const off = (c: Clip) => Math.abs(Math.log(rateOf(c, bpm)));
    return [pool.reduce((a, b) => (off(b) < off(a) ? b : a))];
  }

  /** Where she should be during a bar. */
  private wantedPose(cue: Cue): Pose {
    if (cue.mix !== "body" && this.poses.has("cue")) return "cue";
    return "home";
  }

  /** How much a clip suits starting on `cue` after `prev` (0: never). */
  weight(clip: Clip, cue: Cue, prev?: Clip): number {
    let w = 1;
    const blendZone = cue.mix !== "body";
    if (clip.scene === "drop") w *= 0.06; // a drop scene away from a drop: a rare flourish
    if (clip.scene === "blend") w *= blendZone ? 8 : 0.08;
    if (clip.kind === "flourish") w *= 0.25;
    if (clip.energy && !clip.scene) {
      const d = Math.abs(ENERGY_STEP[clip.energy] - ENERGY_STEP[energyOf(cue.intensity)]);
      w *= [3, 1, 0.3][d]!;
    }
    const want = this.wantedPose(cue);
    if (clip.to === want) w *= clip.from === want ? 1 : 4;
    else w *= clip.from === want ? 0.1 : 0.15; // leaving the pose wanted, or staying away from it
    if (prev?.id === clip.id && (clip.scene || clip.kind === "flourish")) w *= blendZone && clip.scene === "blend" ? 0.4 : 0;
    if (prev?.kind === "flourish" && clip.kind === "flourish") w = 0;
    return w;
  }

  private drops(clipsFrom: (pose: Pose) => Clip[]): Clip[] {
    return [...this.poses].flatMap(clipsFrom).filter((c) => c.scene === "drop" || (c.kind === "transition" && c.to === "peak"));
  }

  /**
   * Plan from bar `start` in `pose`; `cues[0]` is bar `start`. Covers at least
   * PLAN_BARS bars (all of `cues` when `whole`); the last clip may run past
   * the cues.
   */
  plan(start: number, pose: Pose, cues: readonly Cue[], prev?: Clip, whole = false): Placement[] {
    const out: Placement[] = [];
    const until = whole ? cues.length : Math.min(cues.length, PLAN_BARS);
    let b = 0;
    let at: Pose = pose;
    let last = prev;
    const place = (clip: Clip) => {
      out.push({ clip, bar: start + b });
      b += clip.bars;
      at = clip.to;
      last = clip;
    };
    let skipBefore = 0; // drops before this cue index have been given up on
    while (b < until) {
      const cue = cues[b]!;
      const phrases = this.phraseStarts(cues, b);
      const target = this.nextDrop(cues, b, skipBefore);
      if (target && target.at <= (phrases[0] ?? Infinity)) {
        const path = this.pathTo(start + b, at, cues.slice(b, target.at), target.clip.from, last);
        if (path) {
          for (const c of path) place(c);
          place(target.clip);
          continue;
        }
        // No way to land on it: carry on as if it were not there.
        skipBefore = target.at + 1;
        continue;
      }
      // Fill to the next phrase start, or the one after if the gap cannot be filled.
      let filled = false;
      for (const t of phrases) {
        if (target && target.at <= t) break; // reach the drop instead
        const path = this.pathTo(start + b, at, cues.slice(b, t), null, last);
        if (path) {
          for (const c of path) place(c);
          filled = true;
          break;
        }
      }
      if (filled) continue;
      const rng = new Rng(`${this.seed}/booth/${start + b}`);
      const options = this.candidates(at, cue.bpm);
      if (!options.length) throw new Error(`no clip from ${at}`);
      place(rng.weighted(options, (c) => this.weight(c, cue, last) || 1e-6));
    }
    return out;
  }

  /** The next few phrase starts after cue `b`. */
  private phraseStarts(cues: readonly Cue[], b: number): number[] {
    const out: number[] = [];
    for (let i = b + 1; i < cues.length && out.length < 3; i++) if (cues[i]!.barInPiece % PHRASE === 0) out.push(i);
    return out;
  }

  /** The next drop at or after cue `b` (and at or after `skipBefore`) that a drop clip can play at. */
  private nextDrop(cues: readonly Cue[], b: number, skipBefore: number): { at: number; clip: Clip } | null {
    for (let i = Math.max(b, skipBefore); i < cues.length; i++) {
      const cue = cues[i]!;
      if (!cue.drop) continue;
      const options = this.drops((p) => this.candidates(p, cue.bpm)).filter((c) => usable(c, cue.bpm));
      if (!options.length) continue;
      const rng = new Rng(`${this.seed}/booth/drop/${i}`);
      return { at: i, clip: rng.weighted(options, () => 1) };
    }
    return null;
  }

  /**
   * A seeded path of clips that fills `cues` exactly and ends in `to` (any pose when null), or null.
   * Counts the weighted paths from each bar and pose backwards, then walks
   * forwards choosing each clip in proportion to the paths it leaves open.
   */
  private pathTo(start: number, from: Pose, cues: readonly Cue[], to: Pose | null, prev?: Clip): Clip[] | null {
    const d = cues.length;
    if (d === 0) return to === null || from === to ? [] : null;
    const poses = [...this.poses];
    // ways[k][pose]: weighted number of ways to get from bar k in `pose` to bar d in `to`
    const ways: Map<Pose, number>[] = Array.from({ length: d + 1 }, () => new Map());
    for (const p of to === null ? poses : [to]) ways[d]!.set(p, 1);
    for (let k = d - 1; k >= 0; k--) {
      for (const p of poses) {
        let sum = 0;
        for (const c of this.candidates(p, cues[k]!.bpm)) {
          // Save the drop gesture for the drop.
          if (k + c.bars > d || c.scene === "drop") continue;
          const rest = ways[k + c.bars]!.get(c.to) ?? 0;
          if (rest) sum += (this.weight(c, cues[k]!) || 1e-6) * rest;
        }
        if (sum) ways[k]!.set(p, sum);
      }
    }
    if (!ways[0]!.get(from)) return null;
    const path: Clip[] = [];
    let k = 0;
    let at = from;
    let last = prev;
    while (k < d) {
      const options = this.candidates(at, cues[k]!.bpm).filter((c) => k + c.bars <= d && c.scene !== "drop" && (ways[k + c.bars]!.get(c.to) ?? 0) > 0);
      const rng = new Rng(`${this.seed}/booth/${start + k}`);
      const w = (c: Clip, l?: Clip) => (this.weight(c, cues[k]!, l) || 0) * ways[k + c.bars]!.get(c.to)!;
      const strict = options.some((c) => w(c, last) > 0);
      const clip = rng.weighted(options, (c) => (strict ? w(c, last) : w(c)) || 1e-9);
      path.push(clip);
      k += clip.bars;
      at = clip.to;
      last = clip;
    }
    return path;
  }
}

const sameCue = (a: Cue, b: Cue) => a.piece === b.piece && a.barInPiece === b.barInPiece && a.bpm === b.bpm && a.mix === b.mix && a.drop === b.drop && energyOf(a.intensity) === energyOf(b.intensity);

/**
 * The plan as the booth keeps it, bar by bar: told each bar what is coming,
 * it keeps the clips already planned while the music is as assumed, and
 * replans from the end of the clip playing when it is not (a skip, the next
 * track's sections becoming known). Bars are the caller's own count.
 */
export class RollingPlan {
  readonly director: Director;
  placements: Placement[] = [];
  /** The cues each planned bar was planned for. */
  private assumed = new Map<number, Cue>();

  constructor(director: Director) {
    this.director = director;
  }

  /** Forget everything: the next `advance` starts at Home on its bar. */
  reset(): void {
    this.placements = [];
    this.assumed.clear();
  }

  /** The clip that covers `bar`. */
  at(bar: number): Placement | undefined {
    for (let i = this.placements.length - 1; i >= 0; i--) {
      const p = this.placements[i]!;
      if (p.bar <= bar) return bar < p.bar + p.clip.bars ? p : undefined;
    }
    return undefined;
  }

  /** The clip after the one covering `bar`. */
  after(p: Placement): Placement | undefined {
    return this.placements[this.placements.indexOf(p) + 1];
  }

  /** Bar `bar` has begun; `cues[0]` is that bar. */
  advance(bar: number, cues: readonly Cue[]): void {
    const here = this.at(bar);
    if (!here) {
      this.reset();
      this.extend(bar, "home", cues, 0);
      return;
    }
    const end = () => {
      const last = this.placements[this.placements.length - 1]!;
      return last.bar + last.clip.bars;
    };
    // Is the music still what the plan beyond the current clip assumed?
    const keepUntil = here.bar + here.clip.bars;
    for (let b = keepUntil; b < end(); b++) {
      const cue = cues[b - bar];
      const was = this.assumed.get(b);
      if (cue && was && !sameCue(cue, was)) {
        this.placements = this.placements.slice(0, this.placements.indexOf(here) + 1);
        for (const k of [...this.assumed.keys()]) if (k >= keepUntil) this.assumed.delete(k);
        break;
      }
    }
    if (end() < bar + PLAN_BARS) this.extend(end(), this.placements[this.placements.length - 1]!.clip.to, cues, end() - bar, this.placements[this.placements.length - 1]!.clip);
    for (const k of [...this.assumed.keys()]) if (k < bar - 64) this.assumed.delete(k);
    while (this.placements.length > 2 && this.placements[1]!.bar + this.placements[1]!.clip.bars < bar - 16) this.placements.shift();
  }

  private extend(from: number, pose: Pose, cues: readonly Cue[], offset: number, prev?: Clip): void {
    const rest = cues.slice(offset);
    if (!rest.length) return;
    const added = this.director.plan(from, pose, rest, prev);
    this.placements.push(...added);
    rest.forEach((c, i) => this.assumed.set(from + i, c));
  }
}
