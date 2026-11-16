/**
 * The set conductor plays an endless DJ set: one track after another, each a
 * piece framed for a set (no ending, no gap). Each track's tempo is within 3%
 * of the one before and its key compatible with it. The first and last 16
 * bars of a track bring its parts in and take them out (drums first in and
 * last out): by role, or for a style with parts one part every 4 bars, in its
 * arrangement grid.
 *
 * Tracks with a grid mix into each other on two decks. The set's unit is a
 * slice: one bar of time holding one track's bar, or two in a transition, at
 * one tempo. A transition is one of four, drawn from the step in energy:
 *
 *   blend      16 bars. The incoming track's mix-in plays over the outgoing
 *              track's mix-out, its lows cut; half way, on the phrase, the low
 *              end and the pitched parts change hands (the bass swap).
 *   breakdown  A blend whose second phrase has no kick and no bass on either
 *              deck; the incoming low end lands after it, on an impact.
 *   filter     8 bars. The outgoing track is high-passed away while the
 *              incoming enters under a riser, and lands on an impact.
 *   cut        No overlap. The outgoing plays to the phrase before its
 *              mix-out, with an echo throw on its last beat; the incoming
 *              starts past its mix-in, on an impact.
 *
 * In an overlap the two grids are interleaved: the dominant deck plays what
 * its grid says, the other its drums only, under the styles' limits counted
 * across both (see `interleave`). The tempo moves to the incoming track's in
 * equal steps a bar across the overlap (the 8 bars before a cut), and both
 * decks play at it. Styles without parts cut at the track's end, as before.
 *
 * A position is (track, bar), the dominant deck's. A bar of a track that
 * overlaps the one before is the same slice as that track's bar: a seek to
 * either gives both.
 *
 * The set travels. It is laid out in legs of 30 to 45 minutes, each with a
 * tempo to head for: every next track takes the style and tempo that move
 * toward it within the 3% step. Its energy rises and falls in a slow wave,
 * offset per leg and cooler in the first minutes, carried by `lift`. Set time
 * is nominal (the sum of the tracks' lengths as written), so it does not
 * depend on skips, and a link lands on the same track.
 *
 * Like the conductor it is a pure, deterministic bar generator.
 */
import type { Role, StyleBundle } from "../corpus/schema.js";
import { Rng } from "../theory/rng.js";
import { type Key, type ModeName, keysCompatible, pitchClass } from "../theory/theory.js";
import { type BarSource, type Landing, MAX_SEEK_PIECE } from "./conductor.js";
import { MIX_BARS, PHRASE_BARS, mixBars } from "./grid.js";
import { Piece, type PieceOptions, type Segment } from "./piece.js";
import { type Bar, CHANNELS, type ControlEvent, type Move, OPEN_LOW, type TransitionInfo, type TransitionType } from "./types.js";

export { MIX_BARS, PHRASE_BARS, mixBars };
/** Most a track's tempo may differ from the one before, as a share of it. */
export const MAX_TEMPO_STEP = 0.03;

/** A leg's length, in seconds. */
export const LEG_SECONDS = { min: 30 * 60, max: 45 * 60 } as const;
/** Most a leg's energy offset moves `lift`, either way. */
export const LEG_ENERGY = 0.15;
/** Depth of the energy wave, and its period range in seconds. */
export const WAVE_DEPTH = 0.12;
export const WAVE_SECONDS = { min: 10 * 60, max: 20 * 60 } as const;
/** The set starts this much cooler, easing to nothing over `WARMUP_SECONDS`. */
export const WARMUP = 0.15;
export const WARMUP_SECONDS = 15 * 60;
/** `lift` stays within this, either way. */
export const MAX_LIFT = 0.3;

export const DEFAULT_SET_OPTIONS: PieceOptions = { minSeconds: 180, maxSeconds: 360 };

/** What plays in each stretch of a mix-in, in order (and of a mix-out, in reverse). Then everything. */
const MIX_TIERS: readonly (readonly Role[])[] = [["drums"], ["drums", "bass"]];
const ROLES = Object.keys(CHANNELS) as Role[];

/** What it took to start a track, so it can be started again exactly. */
interface Track {
  style: StyleBundle;
  bpm: number;
  key: Key;
  previousForm: string | undefined;
  formId: string;
  /** Added to every section's intensity. */
  lift: number;
  /** The tempo the set was heading for when the track was chosen. */
  target: number;
  /** Nominal seconds into the set the track starts, and how long it runs (0 until built). */
  start: number;
  seconds: number;
  /** How it hands over to the next track, once that is chosen. */
  out?: Transition;
}

/** A stretch of the set with a tempo and an energy to head for. */
interface Leg {
  start: number;
  end: number;
  /** Where the target tempo lies in the pool's tempo span, 0 to 1. */
  tempo: number;
  energy: number;
}

/** What the set planned for a track, for tests and the page. */
export interface TrackPlan {
  styleId: string;
  bpm: number;
  lift: number;
  target: number;
  start: number;
  seconds: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.floor(n), lo), hi);

/**
 * The roles left out of a bar of a track: in its first and last `mixBars`,
 * all but the tier that has come in so far (or not yet gone out). A tier the
 * bar's section does not play is passed over, so a mix-in is never silent
 * just because the track opens without drums.
 *
 * A style with parts leaves nothing out here: its arrangement grid brings the
 * parts in and out one at a time over the same bars (see grid.ts).
 */
export function mixLeaveOut(piece: Piece, barInPiece: number): ReadonlySet<Role> | undefined {
  if (piece.grid) return undefined;
  const mix = mixBars(piece.totalBars);
  if (!mix) return undefined;
  const stageBars = mix / MIX_TIERS.length;
  let stage = Math.floor(Math.min(barInPiece, piece.totalBars - 1 - barInPiece) / stageBars);
  const roles = piece.sectionAt(barInPiece)?.roles ?? [];
  while (stage < MIX_TIERS.length && !MIX_TIERS[stage]!.some((r) => roles.includes(r))) stage++;
  if (stage >= MIX_TIERS.length) return undefined;
  const tier = MIX_TIERS[stage]!;
  return new Set(ROLES.filter((r) => !tier.includes(r)));
}

/** One bar of set time: one track's bar, or two in a transition, at one tempo. */
export interface Slice {
  /** Bars since the session started. */
  index: number;
  /** The tempo of everything in the slice. */
  bpm: number;
  /** The bars sounding, the outgoing track's first. Each carries its own moves and the transition's for its deck. */
  decks: { deck: 0 | 1; bar: Bar }[];
  /** The transition's moves alone, each naming its deck. */
  moves: Move[];
  /** The deck that owns the low end and the pitched parts; the set's position is its track's. */
  dominant: 0 | 1;
  transition?: TransitionInfo;
}

/** How one track hands over to the next. */
export interface Transition {
  type: TransitionType;
  /** The bar of the outgoing track at which the incoming starts. */
  start: number;
  /** Bars both tracks play. None in a cut. */
  bars: number;
  /** The bar of the overlap from which the incoming is dominant: the bass swap. */
  swap: number;
  /** The incoming track's first bar: 0, or past its mix-in for a cut. */
  enter: number;
  /** Bars over which the tempo moves to the incoming track's: the overlap, or the outgoing's last bars before a cut. */
  ramp: number;
}

/** The deck a track plays on: they alternate. */
export const deckOf = (track: number): 0 | 1 => (track % 2) as 0 | 1;

/** A transition's bars before a cut over which the tempo moves. */
const CUT_RAMP = PHRASE_BARS;
/** Bars before a track's end from which its transition is looked up: the longest reach of one (a cut's ramp). */
const REACH = MIX_BARS + CUT_RAMP;
/**
 * A step in `lift` at least this big is going up or down; one this big is a big step. Successive tracks' lifts
 * differ by 0.12 at the median (the wave moves a lot over a track), so these sit near the 30th and 93rd percentiles.
 */
const STEP = 0.08;
const BIG_STEP = 0.22;
/** The deck without the low end is cut below this, Hz; and where the cut ends up in a blend's and a filter's last bar. */
const LOW_CUT = 180;
const BLEND_CUT = 450;
const FILTER_CUT = 4000;
/** Beats over which the low end changes hands, before the swap's barline. */
const SWAP_BEATS = 0.5;
/** A deck fades in from and out to this over a phrase half. */
const FADE = { from: 0.4, to: 0.3, bars: 4 };
const RISER = { from: 200, to: 6000 };
const IMPACT = { from: 90, to: 38 };

/** One deck's place in its track. */
interface Cursor {
  index: number;
  piece: Piece;
  bar: number;
  /** Setup of the bars a seek (or a cut past the mix-in) skipped, to ride along with the first bar returned. */
  carry: ControlEvent[];
}

export class SetConductor implements BarSource {
  readonly seed: string;
  private styles: StyleBundle[];
  private readonly opts: PieceOptions;
  /** The track playing, and in a transition the one coming in over it. */
  private a: Cursor | null = null;
  private inc: Cursor | null = null;
  /** The piece of the bar `nextBar` returned last. */
  private piece: Piece | null = null;
  private barIndex = 0;
  /** The next track to start. */
  private trackIndex = 0;
  /** Every track chosen so far, in order. Seeking back plays them as they were, whatever the pool is now. */
  private readonly chosen: Track[] = [];
  /** The pieces of the latest tracks. */
  private readonly pieces = new Map<number, Piece>();
  /** The latest seek, redone if the pool changes before any bar has been played. */
  private start: (() => Landing) | null = null;
  /** The set's legs so far, drawn as far as needed. */
  private readonly legs: Leg[] = [];
  private readonly wave: { period: number; phase: number };

  /** Only styles in 4/4 are played; a set is 4/4. `opts` sets track lengths and expression; the frame, tempo and key are the set's. */
  constructor(styles: StyleBundle[], seed: string, opts: PieceOptions = DEFAULT_SET_OPTIONS) {
    this.styles = playable(styles);
    this.seed = seed;
    this.opts = opts;
    const w = new Rng(`${seed}/wave`);
    this.wave = { period: w.float(WAVE_SECONDS.min, WAVE_SECONDS.max), phase: w.float(0, 2 * Math.PI) };
  }

  /** What was planned for track `i`, once it has been chosen (null before). */
  trackPlan(i: number): TrackPlan | null {
    const t = this.chosen[i];
    if (!t) return null;
    return { styleId: t.style.id, bpm: t.bpm, lift: t.lift, target: t.target, start: t.start, seconds: t.seconds };
  }

  /** Track `i`'s piece, as the set plays it before the decks are interleaved (choosing it first if need be). */
  trackPiece(i: number): Piece {
    return this.pieceOf(i);
  }

  /** How track `i` hands over to the next, once both have been chosen (null before). */
  transitionPlan(i: number): Transition | null {
    return this.chosen[i]?.out ?? null;
  }

  /** The `lift` the set's energy gives a track starting `seconds` in. */
  liftAt(seconds: number): number {
    const leg = this.legAt(seconds);
    const wave = WAVE_DEPTH * Math.sin((2 * Math.PI * seconds) / this.wave.period + this.wave.phase);
    const warmup = WARMUP * Math.max(0, 1 - seconds / WARMUP_SECONDS);
    return Math.min(Math.max(leg.energy + wave - warmup, -MAX_LIFT), MAX_LIFT);
  }

  private legAt(seconds: number): Leg {
    while (!this.legs.length || this.legs[this.legs.length - 1]!.end <= seconds) {
      const k = this.legs.length;
      const rng = new Rng(`${this.seed}/leg/${k}`);
      const start = this.legs[k - 1]?.end ?? 0;
      this.legs.push({
        start,
        end: start + rng.fork("length").float(LEG_SECONDS.min, LEG_SECONDS.max),
        tempo: rng.fork("tempo").float(0, 1),
        energy: rng.fork("energy").float(-LEG_ENERGY, LEG_ENERGY),
      });
    }
    return this.legs.find((l) => l.end > seconds)!;
  }

  /** Change the style pool, as `Conductor.setStyles` does. Tracks not yet playing are chosen again. */
  setStyles(styles: StyleBundle[]): Landing | null {
    this.styles = playable(styles);
    if (this.start && !this.barIndex) {
      this.forget(0);
      this.trackIndex = 0;
      this.a = this.inc = this.piece = null;
      return this.start();
    }
    this.forget(this.trackIndex);
    return null;
  }

  /** Forget every track from `from` on, and how the one before hands over to it. */
  private forget(from: number): void {
    if (this.chosen.length <= from) return;
    this.chosen.length = from;
    const last = this.chosen[from - 1];
    if (last) delete last.out;
    for (const i of [...this.pieces.keys()]) if (i >= from) this.pieces.delete(i);
  }

  /** Abandon the current track; the next bar starts a new one from its first bar (or goes on with the one already coming in). */
  skip(): void {
    if (this.inc) this.a = this.inc;
    else {
      if (this.a) this.trackIndex = this.a.index + 1;
      this.a = null;
    }
    this.inc = null;
  }

  get currentPiece(): Piece | null {
    return this.piece;
  }

  /**
   * Make the next bar be `barInPiece` of track `pieceIndex`, as `Conductor.seek` does. A bar in the track's
   * overlap with the one before lands in that transition, with both playing.
   */
  seek(pieceIndex: number, barInPiece: number): Landing {
    this.start = () => this.land(pieceIndex, () => barInPiece);
    return this.start();
  }

  /** Like `seek`, to the first bar of a section of the track; a negative `segment` counts from the end. */
  seekSegment(pieceIndex: number, segment: number): Landing {
    this.start = () =>
      this.land(pieceIndex, (piece) => {
        const segments = piece.segments;
        return segments[clamp(segment < 0 ? segments.length + segment : segment, 0, segments.length - 1)]!.start;
      });
    return this.start();
  }

  layout(pieceIndex: number): Segment[] | null {
    if (!this.chosen[pieceIndex]) return null;
    return this.pieceOf(pieceIndex).segments;
  }

  /** The next bar: the dominant deck's, with the other deck's on `with` in a transition. */
  nextBar(): Bar {
    const slice = this.nextSlice();
    const own = slice.decks.find((d) => d.deck === slice.dominant)!.bar;
    const other = slice.decks.find((d) => d.deck !== slice.dominant)?.bar;
    if (!other && !slice.transition) return own;
    return { ...own, ...(other && { with: other }), ...(slice.transition && { transition: slice.transition }) };
  }

  /** The next bar of set time: one track's bar, or both tracks' in a transition. */
  nextSlice(): Slice {
    let a = (this.a ??= this.open(this.trackIndex, 0));
    let t = this.outOf(a);
    // A cut: the next track takes over here, past its mix-in.
    if (t && !t.bars && a.bar === t.start) {
      a = this.a = this.open(a.index + 1, t.enter);
      t = this.outOf(a);
    }
    // Played out past a cut (only a seek lands there): the next track from its top.
    if (a.bar >= a.piece.totalBars) {
      a = this.a = this.open(a.index + 1, 0);
      t = this.outOf(a);
    }
    if (!this.inc && t && t.bars && a.bar >= t.start) this.inc = this.open(a.index + 1, a.bar - t.start);
    const inc = this.inc;
    const index = this.barIndex++;
    const bpm = this.bpmAt(a, t);
    const out = deckOf(a.index);
    let bar = this.render(a, index, bpm);
    let slice: Slice;
    if (inc && t) {
      const s = a.bar - t.start;
      const dominant = s >= t.swap ? deckOf(inc.index) : out;
      const breakdown = t.type === "breakdown" && s >= t.swap;
      let other = this.render(inc, index, bpm, breakdown ? breakdownParts(inc.piece) : undefined);
      if (dominant === out) [bar, other] = interleave(bar, other, a.piece.style, inc.piece.style, breakdown);
      else [other, bar] = interleave(other, bar, inc.piece.style, a.piece.style, breakdown);
      const moves = overlapMoves(t, s, out, deckOf(inc.index), bar.beats);
      bar = withMoves(bar, moves);
      other = withMoves(other, moves);
      slice = { index, bpm, decks: [{ deck: out, bar }, { deck: deckOf(inc.index), bar: other }], moves, dominant, transition: { type: t.type, from: a.index, to: inc.index, bar: s, bars: t.bars } };
      this.piece = dominant === out ? a.piece : inc.piece;
    } else {
      const moves = this.soloMoves(a, t, bar.beats);
      bar = withMoves(bar, moves);
      slice = { index, bpm, decks: [{ deck: out, bar }], moves, dominant: out };
      // A cut announces itself while the tempo moves toward it.
      if (t && !t.bars && t.ramp && a.bar >= t.start - t.ramp && a.bar < t.start) slice.transition = { type: t.type, from: a.index, to: a.index + 1, bar: a.bar - (t.start - t.ramp), bars: t.ramp };
      this.piece = a.piece;
    }
    a.bar++;
    if (inc) {
      inc.bar++;
      if (a.bar >= a.piece.totalBars) {
        this.a = inc;
        this.inc = null;
      }
    }
    return slice;
  }

  /** How `a`'s track hands over, once `a` is near enough its end for that to matter. */
  private outOf(a: Cursor): Transition | undefined {
    return a.bar >= a.piece.totalBars - REACH ? this.out(a.index) : undefined;
  }

  /** The tempo of the bar at `a`: its track's, moving to the next track's across the transition. */
  private bpmAt(a: Cursor, t: Transition | undefined): number {
    const own = this.chosen[a.index]!.bpm;
    if (!t?.ramp) return own;
    const from = t.bars ? t.start : t.start - t.ramp;
    if (a.bar < from || a.bar >= from + t.ramp) return own;
    const next = this.chosen[a.index + 1]!.bpm;
    return Math.round((own + ((next - own) * (a.bar - from + 1)) / (t.ramp + 1)) * 100) / 100;
  }

  /** A bar at a cursor, at the slice's tempo, on its track's deck. */
  private render(c: Cursor, index: number, bpm: number, extra?: readonly string[]): Bar {
    let bar = c.piece.renderBar(c.bar, index, mixLeaveOut(c.piece, c.bar), extra);
    if (c.carry.length) {
      bar = { ...bar, controls: [...c.carry, ...bar.controls] };
      c.carry = [];
    }
    if (bar.bpm !== bpm) bar = { ...bar, bpm };
    // Decks are for tracks that can overlap; a style without parts plays as it always did.
    if (c.piece.grid) bar.deck = deckOf(c.index);
    return bar;
  }

  /** The transition's moves on a bar that plays alone: the throw before a cut, the impact where the incoming track lands. */
  private soloMoves(a: Cursor, t: Transition | undefined, beats: number): Move[] {
    const deck = deckOf(a.index);
    const moves: Move[] = [];
    if (t?.type === "cut" && t.enter && a.bar === t.start - 1) {
      for (const role of ["comp", "arp"] as const) moves.push({ scope: { role, deck }, target: "delaySend", from: 0.7, to: 0.7, at: beats - 1, beats: 1 });
    }
    if (a.index > 0 && a.bar <= MIX_BARS && a.piece.grid) {
      const into = this.out(a.index - 1);
      const lands = into.type === "filter" ? into.bars : into.type === "breakdown" ? into.bars : into.type === "cut" && into.enter ? into.enter : -1;
      if (a.bar === lands) moves.push({ scope: { role: "drums", deck }, target: "impact", from: IMPACT.from, to: IMPACT.to, beats: 0.5 });
    }
    return moves;
  }

  /** How track `i` hands over to track `i + 1`: chosen once, seeded, from the step in energy between them. */
  private out(i: number): Transition {
    const track = this.track(i);
    if (track.out) return track.out;
    const piece = this.pieceOf(i);
    const next = this.pieceOf(i + 1);
    const total = piece.totalBars;
    // Tracks without a grid, or too short to mix over two phrases, cut where the track ends, as a set always did.
    if (!piece.grid || !next.grid || mixBars(total) < MIX_BARS || mixBars(next.totalBars) < MIX_BARS) return (track.out = { type: "cut", start: total, bars: 0, swap: 0, enter: 0, ramp: 0 });
    const step = this.chosen[i + 1]!.lift - track.lift;
    const weights: Record<TransitionType, number> =
      Math.abs(step) >= BIG_STEP
        ? { cut: 5, blend: 1, filter: step > 0 ? 3 : 0, breakdown: step < 0 ? 3 : 0 }
        : step >= STEP
          ? { filter: 5, blend: 3, cut: 1, breakdown: 0 }
          : step <= -STEP
            ? { breakdown: 5, blend: 3, cut: 1, filter: 0 }
            : { blend: 7, filter: 1, breakdown: 1, cut: 1 };
    const type = new Rng(`${this.seed}/mix/${i}`).weighted(["blend", "filter", "cut", "breakdown"] as const, (x) => weights[x]);
    const out: Transition =
      type === "cut"
        ? { type, start: total - MIX_BARS, bars: 0, swap: 0, enter: MIX_BARS, ramp: CUT_RAMP }
        : type === "filter"
          ? { type, start: total - PHRASE_BARS, bars: PHRASE_BARS, swap: 0, enter: 0, ramp: PHRASE_BARS }
          : { type, start: total - MIX_BARS, bars: MIX_BARS, swap: MIX_BARS / 2, enter: 0, ramp: MIX_BARS };
    return (track.out = out);
  }

  private build(track: Track, i: number): Piece {
    const opts: PieceOptions = { ...this.opts, frame: "set", fixed: { bpm: track.bpm, tonic: track.key.tonic, mode: track.key.mode }, lift: track.lift };
    return new Piece(track.style, `${this.seed}/track/${i}/${track.style.id}`, i, opts, track.previousForm);
  }

  /** Track `i`, choosing it and any before it not yet chosen. */
  private track(i: number): Track {
    for (let k = this.chosen.length; k <= i; k++) {
      // A track is chosen from the one before, whose length says where in the set it starts.
      if (k > 0 && !this.chosen[k - 1]!.seconds) this.pieceOf(k - 1);
      this.chosen[k] = this.choose(k);
    }
    return this.chosen[i]!;
  }

  private pieceOf(i: number): Piece {
    let piece = this.pieces.get(i);
    if (piece) return piece;
    const track = this.track(i);
    piece = this.build(track, i);
    track.formId = piece.formId;
    track.seconds = piece.seconds;
    this.pieces.set(i, piece);
    // The playing track, the next, and one either side for a seek's look back.
    if (this.pieces.size > 4) this.pieces.delete(this.pieces.keys().next().value!);
    return piece;
  }

  /** A cursor at `bar` of track `i`, carrying the setup of the bars before it. */
  private open(i: number, bar: number): Cursor {
    const piece = this.pieceOf(i);
    const carry: ControlEvent[] = [];
    for (let b = 0; b < bar; b++) {
      for (const c of piece.renderBar(b, 0, mixLeaveOut(piece, b)).controls) carry.push({ ...c, beat: 0 });
    }
    this.trackIndex = i + 1;
    return { index: i, piece, bar, carry };
  }

  private land(pieceIndex: number, pick: (piece: Piece) => number): Landing {
    const target = clamp(pieceIndex, 0, MAX_SEEK_PIECE);
    const piece = this.pieceOf(target);
    const bar = clamp(pick(piece), 0, piece.totalBars - 1);
    this.inc = null;
    // In the overlap with the track before, both play: the next slice brings this one in over it.
    const before = target > 0 ? this.out(target - 1) : undefined;
    if (before && bar < before.bars) this.a = this.open(target - 1, before.start + bar);
    else this.a = this.open(target, bar);
    this.trackIndex = target + 1;
    const segments = piece.segments;
    let segment = segments.length - 1;
    while (segment > 0 && segments[segment]!.start > bar) segment--;
    return { piece: piece.index, bar, segment, segments: segments.length, label: segments[segment]!.label };
  }

  /** Style, tempo and key for track `i`, following track `i - 1`. */
  private choose(i: number): Track {
    const rng = new Rng(`${this.seed}/set/${i}`);
    const before = this.chosen[i - 1];
    const pool = this.styles.length > 1 ? this.styles.filter((s) => s.id !== before?.style.id) : this.styles;
    const start = before ? before.start + before.seconds : 0;
    const leg = this.legAt(start);
    const lo = Math.min(...this.styles.map((s) => s.corpus.tempo.min));
    const hi = Math.max(...this.styles.map((s) => s.corpus.tempo.max));
    const target = lo + leg.tempo * (hi - lo);
    const step = (bpm: number) =>
      before ? Math.min(Math.max(bpm, Math.ceil(before.bpm * (1 - MAX_TEMPO_STEP))), Math.floor(before.bpm * (1 + MAX_TEMPO_STEP))) : bpm;
    const within = (s: StyleBundle, bpm: number) => Math.min(Math.max(bpm, s.corpus.tempo.min), s.corpus.tempo.max);
    let style: StyleBundle;
    let bpm: number;
    if (!before) {
      // The first track is anywhere in its style; the set heads for the target from there.
      style = rng.fork("style").pick(pool);
      bpm = Math.round(rng.fork("tempo").float(style.corpus.tempo.min, style.corpus.tempo.max));
    } else {
      // The style that gets nearest the target in one step is the likeliest.
      style = rng.fork("style").weighted(pool, (s) => 1 / (1 + Math.abs(step(within(s, target)) - target)));
      bpm = step(Math.round(within(style, target + rng.fork("tempo").float(-1.5, 1.5))));
    }
    const key = chooseKey(style, before?.key, rng.fork("key"));
    let previousForm: string | undefined;
    for (let k = i - 1; k >= 0 && previousForm === undefined; k--) {
      if (this.chosen[k]!.style.id === style.id) previousForm = this.chosen[k]!.formId;
    }
    const lift = Math.round(this.liftAt(start) * 1000) / 1000;
    return { style, bpm, key, previousForm, formId: "", lift, target, start, seconds: 0 };
  }
}

const withMoves = (bar: Bar, moves: readonly Move[]): Bar => {
  const own = moves.filter((m) => m.scope !== "master" && m.scope.deck === bar.deck);
  return own.length ? { ...bar, moves: [...(bar.moves ?? []), ...own] } : bar;
};

/** A bar with only the parts in `keep`. */
function only(bar: Bar, keep: string[]): Bar {
  if (keep.length === (bar.info.parts?.length ?? 0)) return bar;
  return { ...bar, notes: bar.notes.filter((n) => n.part === undefined || keep.includes(n.part)), info: { ...bar.info, parts: keep } };
}

/**
 * Two tracks' bars in one slice, thinned so they sound as one mix. The
 * dominant track plays what its grid says. The other plays drums only (no
 * second bass, pad or line), and of those only what fits beside the dominant
 * track under the styles' limits counted across both: `most` in all and each
 * group's own (the lower of the two styles' where both name one). Its kick
 * always plays; the transition's moves take its lows. `breakdown` leaves the
 * low end out of both, kicks and bass (a breakdown's second phrase).
 */
export function interleave(dominant: Bar, other: Bar, dominantStyle: StyleBundle, otherStyle: StyleBundle, breakdown = false): [Bar, Bar] {
  const parts = (s: StyleBundle) => new Map((s.corpus.parts ?? []).map((p) => [p.id, p]));
  const isKick = (p: { lanes?: string[] | undefined } | undefined) => p?.lanes?.includes("kick") === true;
  const low = (p: { lanes?: string[] | undefined; role: string } | undefined) => isKick(p) || p?.role === "bass";
  const dp = parts(dominantStyle);
  const op = parts(otherStyle);
  const da = dominantStyle.corpus.arrangement;
  const oa = otherStyle.corpus.arrangement;
  const most = Math.min(da?.most ?? Infinity, oa?.most ?? Infinity);
  const limit = (g: string) => Math.min(da?.groups?.[g] ?? Infinity, oa?.groups?.[g] ?? Infinity);
  const keepD = (dominant.info.parts ?? []).filter((id) => !(breakdown && low(dp.get(id))));
  const count = new Map<string, number>();
  for (const id of keepD) {
    const g = dp.get(id)?.group;
    if (g !== undefined) count.set(g, (count.get(g) ?? 0) + 1);
  }
  let total = keepD.length;
  const keepO: string[] = [];
  for (const id of other.info.parts ?? []) {
    const p = op.get(id);
    if (!p || p.role !== "drums") continue;
    if (isKick(p)) {
      if (breakdown) continue;
    } else if (total >= most || (p.group !== undefined && (count.get(p.group) ?? 0) >= limit(p.group))) continue;
    keepO.push(id);
    total++;
    if (p.group !== undefined) count.set(p.group, (count.get(p.group) ?? 0) + 1);
  }
  return [only(dominant, keepD), only(other, keepO)];
}

/**
 * What the incoming track plays over a breakdown's second phrase, where
 * neither deck has a kick or a bass: up to two of its pitched parts (a pad
 * first) from a phrase into its body, else its coolest pad. Without them its
 * mix-in has little but the low end there, and the phrase would be near silent.
 */
export function breakdownParts(piece: Piece): string[] {
  const parts = piece.style.corpus.parts ?? [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const pitched = (id: string) => {
    const role = byId.get(id)?.role;
    return role !== undefined && role !== "drums" && role !== "bass";
  };
  const body = piece.grid?.parts[Math.min(MIX_BARS + PHRASE_BARS, piece.totalBars - 1)] ?? [];
  const pick = body.filter(pitched).sort((a, b) => Number(byId.get(b)!.role === "pad") - Number(byId.get(a)!.role === "pad"));
  if (!pick.length) {
    const pad = parts.filter((p) => p.role === "pad" && !p.roll).sort((a, b) => (a.enters ?? 0) - (b.enters ?? 0))[0];
    if (pad) pick.push(pad.id);
  }
  return pick.slice(0, 2);
}

/** Between two values in Hz, in octaves; `x` 0..1. */
const octaves = (a: number, b: number, x: number) => a * Math.pow(b / a, x);

/**
 * The moves of bar `s` of a transition's overlap, between the outgoing deck
 * `o` and the incoming deck `n`. Each is one bar's slice of a longer move,
 * computed from `s` alone, so a seek into the overlap gets what playing to it gives.
 *
 *   - One low end. Until the swap the incoming deck is cut below `LOW_CUT`;
 *     over the last half beat before the swap that cut opens and the outgoing
 *     deck's closes, and from there the outgoing's rises as it leaves.
 *   - A blend and a breakdown fade the incoming deck in over its first bars
 *     and the outgoing out over its last.
 *   - A filter sweeps the outgoing deck's cut up across the whole overlap,
 *     under a riser on the incoming.
 */
export function overlapMoves(t: Transition, s: number, o: 0 | 1, n: 0 | 1, beats: number): Move[] {
  const moves: Move[] = [];
  const rest = t.bars - t.swap;
  const top = t.type === "filter" ? FILTER_CUT : BLEND_CUT;
  if (s < t.swap) {
    const cut: Move = { scope: { deck: n }, target: "lowCut", from: LOW_CUT, to: LOW_CUT, beats, span: { bar: s, of: t.swap } };
    if (s === t.swap - 1) {
      // The swap: the low end changes hands just before the barline.
      Object.assign(cut, { to: OPEN_LOW, at: beats - SWAP_BEATS, beats: SWAP_BEATS });
      moves.push({ scope: { deck: o }, target: "lowCut", from: OPEN_LOW, to: LOW_CUT, at: beats - SWAP_BEATS, beats: SWAP_BEATS, span: { bar: 0, of: rest + 1 } });
    }
    moves.push(cut);
    if (s < FADE.bars) moves.push({ scope: { deck: n }, target: "gain", from: FADE.from + ((1 - FADE.from) * s) / FADE.bars, to: FADE.from + ((1 - FADE.from) * (s + 1)) / FADE.bars, beats });
  } else {
    const k = s - t.swap;
    // With no bars before the swap (a filter) the cut starts here; else it carries on from the swap's.
    moves.push({ scope: { deck: o }, target: "lowCut", from: octaves(LOW_CUT, top, k / rest), to: octaves(LOW_CUT, top, (k + 1) / rest), beats, span: { bar: t.swap ? k + 1 : k, of: t.swap ? rest + 1 : rest } });
    const left = t.bars - s;
    const fade = t.type === "filter" ? 2 : FADE.bars;
    if (left <= fade) moves.push({ scope: { deck: o }, target: "gain", from: FADE.to + ((1 - FADE.to) * left) / fade, to: FADE.to + ((1 - FADE.to) * (left - 1)) / fade, beats });
    if (t.type === "filter") moves.push({ scope: { role: "pad", deck: n }, target: "riser", from: octaves(RISER.from, RISER.to, k / rest), to: octaves(RISER.from, RISER.to, (k + 1) / rest), beats, span: { bar: k, of: rest } });
  }
  return moves;
}

function playable(styles: StyleBundle[]): StyleBundle[] {
  const out = styles.filter((s) => s.corpus.beatsPerBar === 4);
  if (!out.length) throw new Error("SetConductor needs at least one style in 4/4");
  return out;
}

/**
 * One of the style's keys compatible with `before`; failing that, a tonic for
 * one of the style's modes that is; failing that (no mode of the style comes
 * within one degree), `before` itself.
 */
function chooseKey(style: StyleBundle, before: Key | undefined, rng: Rng): Key {
  const keys = style.corpus.keys.map((k) => ({ tonic: pitchClass(k.tonic), mode: k.mode as ModeName }));
  if (!before) return rng.pick(keys);
  const near = keys.filter((k) => keysCompatible(k, before));
  if (near.length) return rng.pick(near);
  const modes = [...new Set(keys.map((k) => k.mode))];
  const moved = modes.flatMap((mode) => Array.from({ length: 12 }, (_, tonic) => ({ tonic, mode })).filter((k) => keysCompatible(k, before)));
  return moved.length ? rng.pick(moved) : before;
}
