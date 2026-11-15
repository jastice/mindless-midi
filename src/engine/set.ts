/**
 * The set conductor plays an endless DJ set: one track after another, each a
 * piece framed for a set (no ending, no gap), so the next track starts on the
 * bar after the last, on a phrase boundary. Each track's tempo is within 3% of
 * the one before and its key compatible with it. The first and last 16 bars of
 * a track bring its parts in and take them out (drums first in and last out),
 * so even a cut sounds like one track handing over to the next.
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
import { Piece, type PieceOptions, type Segment } from "./piece.js";
import { type Bar, CHANNELS, type ControlEvent } from "./types.js";

/** Bars in a phrase; tracks are whole phrases. */
export const PHRASE_BARS = 8;
/** Bars at each end of a track that mix it in and out. */
export const MIX_BARS = 16;
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
 * Bars at each end of a track of `totalBars` that mix it in and out:
 * `MIX_BARS`, or a phrase less at a time for a track too short to play at
 * least one phrase whole between them; none for a track of under three phrases.
 */
export function mixBars(totalBars: number): number {
  for (let m = MIX_BARS; m > 0; m -= PHRASE_BARS) if (2 * m + PHRASE_BARS <= totalBars) return m;
  return 0;
}

/**
 * The roles left out of a bar of a track: in its first and last `mixBars`,
 * all but the tier that has come in so far (or not yet gone out). A tier the
 * bar's section does not play is passed over, so a mix-in is never silent
 * just because the track opens without drums.
 */
export function mixLeaveOut(piece: Piece, barInPiece: number): ReadonlySet<Role> | undefined {
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

export class SetConductor implements BarSource {
  readonly seed: string;
  private styles: StyleBundle[];
  private readonly opts: PieceOptions;
  private piece: Piece | null = null;
  private barInPiece = 0;
  private barIndex = 0;
  /** The next track to start. */
  private trackIndex = 0;
  /** Every track started so far, in order. Seeking back plays them as they were, whatever the pool is now. */
  private readonly chosen: Track[] = [];
  /** Setup of the bars `seek` skipped, to ride along with the first bar returned. */
  private carry: ControlEvent[] = [];
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

  /** What was planned for track `i`, once it has been started (null before). */
  trackPlan(i: number): TrackPlan | null {
    const t = this.chosen[i];
    if (!t) return null;
    return { styleId: t.style.id, bpm: t.bpm, lift: t.lift, target: t.target, start: t.start, seconds: t.seconds };
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

  /** Change the style pool, as `Conductor.setStyles` does. */
  setStyles(styles: StyleBundle[]): Landing | null {
    this.styles = playable(styles);
    if (this.start && !this.barIndex) {
      this.chosen.length = 0;
      this.trackIndex = 0;
      this.piece = null;
      return this.start();
    }
    this.chosen.length = Math.min(this.chosen.length, this.trackIndex);
    return null;
  }

  /** Abandon the current track; the next bar starts a new one. */
  skip(): void {
    this.piece = null;
    this.carry = [];
  }

  get currentPiece(): Piece | null {
    return this.piece;
  }

  /** Make the next bar be `barInPiece` of track `pieceIndex`, as `Conductor.seek` does. */
  seek(pieceIndex: number, barInPiece: number): Landing {
    this.start = () => this.land(this.enter(pieceIndex), barInPiece);
    return this.start();
  }

  /** Like `seek`, to the first bar of a section of the track; a negative `segment` counts from the end. */
  seekSegment(pieceIndex: number, segment: number): Landing {
    this.start = () => {
      const piece = this.enter(pieceIndex);
      const segments = piece.segments;
      return this.land(piece, segments[clamp(segment < 0 ? segments.length + segment : segment, 0, segments.length - 1)]!.start);
    };
    return this.start();
  }

  layout(pieceIndex: number): Segment[] | null {
    const track = this.chosen[pieceIndex];
    if (!track) return null;
    if (this.piece?.index === pieceIndex) return this.piece.segments;
    return this.build(track, pieceIndex).segments;
  }

  nextBar(): Bar {
    if (!this.piece || this.barInPiece >= this.piece.totalBars) this.startTrack();
    const piece = this.piece!;
    let bar = piece.renderBar(this.barInPiece, this.barIndex, mixLeaveOut(piece, this.barInPiece));
    if (this.carry.length) {
      bar = { ...bar, controls: [...this.carry, ...bar.controls] };
      this.carry = [];
    }
    this.barInPiece++;
    this.barIndex++;
    return bar;
  }

  private build(track: Track, i: number): Piece {
    const opts: PieceOptions = { ...this.opts, frame: "set", fixed: { bpm: track.bpm, tonic: track.key.tonic, mode: track.key.mode }, lift: track.lift };
    return new Piece(track.style, `${this.seed}/track/${i}/${track.style.id}`, i, opts, track.previousForm);
  }

  private enter(pieceIndex: number): Piece {
    const target = clamp(pieceIndex, 0, MAX_SEEK_PIECE);
    while (this.chosen.length < target) {
      this.trackIndex = this.chosen.length;
      this.startTrack();
    }
    this.trackIndex = target;
    this.startTrack();
    return this.piece!;
  }

  private land(piece: Piece, barInPiece: number): Landing {
    const bar = clamp(barInPiece, 0, piece.totalBars - 1);
    this.carry = [];
    for (let b = 0; b < bar; b++) {
      for (const c of piece.renderBar(b, 0, mixLeaveOut(piece, b)).controls) this.carry.push({ ...c, beat: 0 });
    }
    this.barInPiece = bar;
    const segments = piece.segments;
    let segment = segments.length - 1;
    while (segment > 0 && segments[segment]!.start > bar) segment--;
    return { piece: piece.index, bar, segment, segments: segments.length, label: segments[segment]!.label };
  }

  private startTrack(): void {
    const i = this.trackIndex;
    const track = this.chosen[i] ?? this.choose(i);
    this.piece = this.build(track, i);
    track.formId = this.piece.formId;
    track.seconds = this.piece.seconds;
    this.chosen[i] = track;
    this.trackIndex = i + 1;
    this.barInPiece = 0;
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
