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
 * Where she should be follows the music: at the decks (Home) through a
 * track's body, with now and then a look at the camera or a flourish; working
 * the record (Vinyl, then Cue) in the blend zones at a track's ends; the
 * build pose in the phrase before a drop and the peak in the phrase after.
 * A drop clip (a transition to Peak) is trimmed so the arms go up on its
 * first bar, which starts on the drop.
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

export type Pose = "home" | "look" | "vinyl" | "cue" | "build" | "peak";
export type ClipKind = "loop" | "transition" | "flourish";
export type Energy = "low" | "mid" | "high";

export interface Clip {
  id: string;
  kind: ClipKind;
  from: Pose;
  to: Pose;
  /** The energy it suits; never played two steps from it. */
  energy?: Energy;
  /** Relative to the clips base URL; named by the SHA-256 of its bytes. */
  file: string;
  /** Frames in the file; frame `frames` would be the `to` pose again. */
  frames: number;
  bars: number;
  /** Tempo at which the clip plays at ×1: bars * 4 * 60 * fps / frames. */
  bpm: number;
  /** Frames from the clip's start to its first nod on the beat, as measured (weak: Grok does not know the tempo); not used for playback. */
  beatPhase: number;
  /** Crossfade when it follows another clip, frames. */
  fadeFrames: number;
  /** Fastest it may play, when not MAX_RATE: a trimmed drop clip may throw its arms up faster. */
  maxRate?: number;
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
/**
 * Grok's 6 s and 10 s takes play as 3 and 5 bars at 120 BPM at ×1, so ×0.98–1.15
 * across Claudia's 118–138 BPM; 1.16 lets Berlin techno's fastest tracks use them.
 */
export const MAX_RATE = 1.16;
/** Bars in a phrase (as `PHRASE_BARS` in the set conductor). Every phrase starts on a clip boundary, on a pose frame. */
export const PHRASE = 8;
/** Without a grid, a section at least this much more intense than the one before is a drop. */
export const DROP_RISE = 0.2;
/** A drop into a section at least this intense gets the arms up (and the build before it); a smaller one passes at the decks. */
export const BIG_DROP = 0.5;
/** Bars before a drop that call for the build pose, and bars after it for the peak. */
export const MOMENT_BARS = 8;
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
  /** The bar starts a big drop (into a section of at least BIG_DROP). */
  drop: boolean;
  /** In the build before a big drop (the grid's, else MOMENT_BARS), or from its first bar to MOMENT_BARS after. */
  moment: "build" | "peak" | null;
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
 * What the director knows of a track ahead of time. From a set's plans
 * (`trackFacts`): its sections, the parts its grid plays in each bar, its
 * turns and builds, and the overlaps with the tracks either side. Without
 * them (`factsOf`), only its sections; blend zones are then guessed.
 */
export interface TrackFacts {
  piece: number;
  bars: number;
  sections: readonly Section[];
  /** Parts playing in each bar. */
  parts?: readonly number[];
  /** "drop" or "break" on the first bar of a section that turns the track. */
  turn?: readonly (string | undefined)[];
  /** True in the build before a drop. */
  build?: readonly boolean[];
  /** From a set's plans: blend zones are exactly the overlaps below (none at all for a cut). */
  planned?: boolean;
  /** Bars of this track overlapping the track before, while this one is the louder: [from, to). */
  blendIn?: readonly [number, number];
  /** The handover: this track's bar where the next becomes the louder, the next's bar there, and this track's overlapped bars before it. */
  out?: { at: number; nextBar: number; blend: readonly [number, number] };
}

/** What a set conductor tells about its tracks ahead (SetConductor has these). */
export interface PlanSource {
  layout(i: number): readonly Section[] | null;
  trackPiece(i: number): { totalBars: number; grid?: { parts: string[][]; turn: (string | undefined)[]; build?: (unknown | undefined)[] } };
  transitionPlan(i: number): { start: number; bars: number; swap: number; enter: number } | null;
}

/** Track `i`'s facts from a set's plans, once it has been chosen. */
export function trackFacts(src: PlanSource, i: number): TrackFacts | null {
  const sections = src.layout(i);
  if (!sections) return null;
  const piece = src.trackPiece(i);
  const g = piece.grid;
  const before = i > 0 ? src.transitionPlan(i - 1) : null;
  const after = src.transitionPlan(i);
  return {
    piece: i,
    bars: piece.totalBars,
    sections,
    planned: true,
    ...(g && { parts: g.parts.map((p) => p.length), turn: g.turn, build: g.build?.map(Boolean) }),
    ...(before && before.bars > 0 && { blendIn: [before.enter + before.swap, before.enter + before.bars] as const }),
    ...(after && { out: { at: after.start + after.swap, nextBar: after.enter + after.swap, blend: [after.start, after.start + after.swap] as const } }),
  };
}

/** A track known only by its bar and sections. */
export function factsOf(bar: BarFacts, sections: readonly Section[] | null): TrackFacts {
  return { piece: bar.pieceIndex, bars: bar.pieceBars, sections: sections?.length ? sections : [{ start: 0, bars: bar.pieceBars, intensity: bar.intensity }] };
}

/**
 * Cues from bar `barInPiece` of `track` to its handover, then of `next` (as far as
 * `nextBars`), or of a next track assumed from bar 0 with a blend zone at its start.
 */
export function cuesFor(barInPiece: number, bpm: number, track: TrackFacts, next: TrackFacts | null, nextBars = 2 * BLEND_BARS): Cue[] {
  const out: Cue[] = [];
  trackCues(out, track, barInPiece, track.out ? track.out.at : track.bars, bpm);
  const from = track.out?.nextBar ?? 0;
  if (next) trackCues(out, next, from, Math.min(next.bars, from + nextBars), bpm);
  else for (let b = 0; b < nextBars; b++) out.push({ bpm, intensity: 0.5, mix: b < BLEND_BARS ? "in" : "body", drop: false, moment: null, piece: track.piece + 1, barInPiece: b });
  return out;
}

function trackCues(out: Cue[], t: TrackFacts, from: number, to: number, bpm: number): void {
  const secs = t.sections;
  const sectionAt = (b: number) => {
    let k = 0;
    while (k + 1 < secs.length && secs[k + 1]!.start <= b) k++;
    return k;
  };
  // Drops: the grid's turns where there is a grid, else a rise in intensity; big ones only for the peak.
  const drops = secs.filter((s, k) => k > 0 && (t.turn ? t.turn[s.start] === "drop" : s.intensity - secs[k - 1]!.intensity >= DROP_RISE)).map((s) => s.start);
  const big = new Set(drops.filter((d) => secs[sectionAt(d)]!.intensity >= BIG_DROP));
  const most = t.parts ? Math.max(1, ...t.parts) : 0;
  const guess = Math.min(BLEND_BARS, Math.floor(t.bars / 3));
  const inside = (r: readonly [number, number] | undefined, b: number) => !!r && b >= r[0] && b < r[1];
  for (let b = from; b < to; b++) {
    const sec = secs[sectionAt(b)]!;
    // Energy is what plays: a section's intensity, but no more than its share of the track's fullest bar.
    const intensity = t.parts ? Math.min(sec.intensity, (t.parts[b] ?? 0) / most) : sec.intensity;
    const mix = t.planned ? (inside(t.blendIn, b) ? "in" : inside(t.out?.blend, b) ? "out" : "body") : b < guess ? "in" : t.bars - b <= guess ? "out" : "body";
    const ahead = drops.find((d) => d > b);
    const building = ahead !== undefined && big.has(ahead) && (t.build ? !!t.build[b] : ahead - b <= MOMENT_BARS);
    const peak = [...big].some((d) => b >= d && b - d < MOMENT_BARS);
    out.push({ bpm, intensity, mix, drop: big.has(b), moment: building ? "build" : peak ? "peak" : null, piece: t.piece, barInPiece: b });
  }
}

export function energyOf(intensity: number): Energy {
  return intensity < 0.45 ? "low" : intensity < 0.7 ? "mid" : "high";
}

export const rateOf = (clip: Clip, bpm: number) => bpm / clip.bpm;
const usable = (clip: Clip, bpm: number) => {
  const r = rateOf(clip, bpm);
  return r >= MIN_RATE && r <= (clip.maxRate ?? MAX_RATE);
};
/** A drop clip: the arms go up. Saved for drops. */
export const isDrop = (clip: Clip) => clip.kind === "transition" && clip.to === "peak";


const ENERGY_STEP: Record<Energy, number> = { low: 0, mid: 1, high: 2 };
/** Clips back within which a flourish is not played again. */
const RECENT = 6;
/** Affinity of a pose a bar does not call for. */
const UNWANTED = 0.003;

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
    const loops = from.filter((c) => c.kind === "loop");
    const pool = loops.length ? loops : from;
    if (!pool.length) return [];
    const off = (c: Clip) => Math.abs(Math.log(rateOf(c, bpm)));
    return [pool.reduce((a, b) => (off(b) < off(a) ? b : a))];
  }

  /** How well each pose suits a bar, 0.003 to 1, with 1 for the best pose the set has; a pose the bar does not call for is rare. */
  affinity(cue: Cue): (pose: Pose) => number {
    const want: Partial<Record<Pose, number>> =
      cue.moment === "peak"
        ? { peak: 1, home: 0.3 }
        : cue.moment === "build"
          ? { build: 1, home: 0.3 }
          : cue.mix !== "body"
            ? { vinyl: 1, cue: 1, home: 0.3 }
            : { home: 1, look: energyOf(cue.intensity) === "low" ? 0.1 : 1 };
    const top = Math.max(...[...this.poses].map((p) => want[p] ?? UNWANTED));
    return (p) => Math.min(1, (want[p] ?? UNWANTED) / top);
  }

  /** How much a clip suits starting on `cue` after the clips in `history` (most recent last; 0: never). */
  weight(clip: Clip, cue: Cue, history: readonly Clip[] = []): number {
    const prev = history[history.length - 1];
    let w = 1;
    if (clip.kind === "flourish") w *= cue.mix === "body" && !cue.moment ? 0.15 : 0.02;
    if (clip.energy) {
      // A loop of the right energy is favoured; a flourish only allowed (it is a one-off either way).
      const d = Math.abs(ENERGY_STEP[clip.energy] - ENERGY_STEP[energyOf(cue.intensity)]);
      w *= (clip.kind === "flourish" ? [1, 0.5, 0] : [3, 1, 0])[d]!;
    }
    const aff = this.affinity(cue);
    const to = aff(clip.to);
    w *= to;
    if (clip.from !== clip.to && to > aff(clip.from)) w *= 4; // arriving where she should be
    if (prev && prev.kind === "transition" && clip.kind === "transition" && prev.from === clip.to && prev.to === clip.from) w *= 0.05; // undoing the last move
    if (clip.kind === "flourish" && history.slice(-RECENT).some((c) => c.id === clip.id)) w *= 0.05; // not the same one again so soon
    if (prev?.kind === "flourish" && clip.kind === "flourish") w = 0;
    return w;
  }

  /**
   * Plan from bar `start` in `pose`; `cues[0]` is bar `start`. Covers at least
   * PLAN_BARS bars (all of `cues` when `whole`); the last clip may run past
   * the cues.
   */
  plan(start: number, pose: Pose, cues: readonly Cue[], history: readonly Clip[] = [], whole = false): Placement[] {
    const out: Placement[] = [];
    const until = whole ? cues.length : Math.min(cues.length, PLAN_BARS);
    let b = 0;
    let at: Pose = pose;
    const last = [...history];
    const place = (clip: Clip) => {
      out.push({ clip, bar: start + b });
      b += clip.bars;
      at = clip.to;
      last.push(clip);
    };
    let skipBefore = 0; // drops before this cue index have been given up on
    while (b < until) {
      const cue = cues[b]!;
      const phrases = this.phraseStarts(cues, b);
      const target = this.nextDrop(cues, b, skipBefore);
      if (target && target.at <= (phrases[0] ?? Infinity)) {
        // The first drop clip in seeded order that a path of clips can reach.
        let landed = false;
        for (const clip of target.clips) {
          const path = this.pathTo(start + b, at, cues.slice(b, target.at), clip.from, last);
          if (!path) continue;
          for (const c of path) place(c);
          place(clip);
          landed = true;
          break;
        }
        // No way to land on it: carry on as if it were not there.
        if (!landed) skipBefore = target.at + 1;
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
      const all = this.candidates(at, cue.bpm);
      if (!all.length) throw new Error(`no clip from ${at}`);
      const options = all.some((c) => !isDrop(c)) ? all.filter((c) => !isDrop(c)) : all;
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

  /**
   * The next drop at or after cue `b` (and at or after `skipBefore`) that a drop clip can play at,
   * with the drop clips in a seeded order that favours the one out of a build.
   */
  private nextDrop(cues: readonly Cue[], b: number, skipBefore: number): { at: number; clips: Clip[] } | null {
    for (let i = Math.max(b, skipBefore); i < cues.length; i++) {
      const cue = cues[i]!;
      if (!cue.drop) continue;
      const left = this.set.clips.filter((c) => isDrop(c) && usable(c, cue.bpm));
      if (!left.length) continue;
      const rng = new Rng(`${this.seed}/booth/drop/${i}`);
      const clips: Clip[] = [];
      // Out of the build pose only where the music builds.
      const built = cues[i - 1]?.moment === "build";
      while (left.length) {
        const c = rng.weighted(left, (c) => (c.from === "build" ? (built ? 3 : 0.05) : 1));
        clips.push(c);
        left.splice(left.indexOf(c), 1);
      }
      return { at: i, clips };
    }
    return null;
  }

  /**
   * A seeded path of clips that fills `cues` exactly and ends in `to` (any pose when null), or null.
   * Counts the paths from each bar and pose backwards, then walks forwards
   * choosing each clip by its weight among those that leave a path open.
   */
  private pathTo(start: number, from: Pose, cues: readonly Cue[], to: Pose | null, history: readonly Clip[] = []): Clip[] | null {
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
          if (k + c.bars > d || isDrop(c)) continue;
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
    const last = [...history];
    while (k < d) {
      const options = this.candidates(at, cues[k]!.bpm).filter((c) => k + c.bars <= d && !isDrop(c) && (ways[k + c.bars]!.get(c.to) ?? 0) > 0);
      const rng = new Rng(`${this.seed}/booth/${start + k}`);
      // The path counts only rule out dead ends: weighting by them would favour the pose with the most ways onward (Home).
      const w = (c: Clip, h?: readonly Clip[]) => this.weight(c, cues[k]!, h) || 0;
      const strict = options.some((c) => w(c, last) > 0);
      const clip = rng.weighted(options, (c) => (strict ? w(c, last) : w(c)) || 1e-9);
      path.push(clip);
      k += clip.bars;
      at = clip.to;
      last.push(clip);
    }
    return path;
  }
}

const sameCue = (a: Cue, b: Cue) => a.piece === b.piece && a.barInPiece === b.barInPiece && a.bpm === b.bpm && a.mix === b.mix && a.drop === b.drop && a.moment === b.moment && energyOf(a.intensity) === energyOf(b.intensity);

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
    if (end() < bar + PLAN_BARS) {
      const recent = this.placements.slice(-RECENT).map((p) => p.clip);
      this.extend(end(), recent[recent.length - 1]!.to, cues, end() - bar, recent);
    }
    for (const k of [...this.assumed.keys()]) if (k < bar - 64) this.assumed.delete(k);
    while (this.placements.length > 2 && this.placements[1]!.bar + this.placements[1]!.clip.bars < bar - 16) this.placements.shift();
  }

  private extend(from: number, pose: Pose, cues: readonly Cue[], offset: number, history: readonly Clip[] = []): void {
    const rest = cues.slice(offset);
    if (!rest.length) return;
    const added = this.director.plan(from, pose, rest, history);
    this.placements.push(...added);
    rest.forEach((c, i) => this.assumed.set(from + i, c));
  }
}
