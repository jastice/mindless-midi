/**
 * The manual arranger's rules, apart from the page: where the arrow keys and
 * the transition button take her, which slots the running order shows, and how
 * the hand-picked styles travel in a link. Pure, no DOM.
 */
import { PHRASE_BARS } from "../engine/set.js";

/** A place to jump to. `solo`: a track plays alone from there, rather than inside its overlap with the one before. */
export interface Spot {
  piece: number;
  bar: number;
  solo: boolean;
}

/** Going back restarts the phrase if this many bars or more of it have played. */
export const RESTART_BARS = 2;

/** Tracks in the running order: two already played, the one playing, and the next five. */
export const PAST = 2;
export const AHEAD = 5;

/** What the rules need to know of a track. */
export interface TrackShape {
  bars: number;
  /** How it hands over to the next track. */
  out: { start: number; bars: number; ramp: number };
}

/** The tracks the running order shows around the playing one, as indices; those before the set's first are negative. */
export function slotIndices(current: number, past = PAST, ahead = AHEAD): number[] {
  return Array.from({ length: past + 1 + ahead }, (_, k) => current - past + k);
}

/**
 * One phrase (8 bars) forward or back from `at`. Forward from a track's last phrase is the next track's start; back
 * restarts the phrase you are in if it has played a couple of bars, else goes to the one before, and past a track's
 * start to the last phrase of the track before.
 */
export function stepPhrase(at: { piece: number; bar: number }, direction: -1 | 1, bars: (piece: number) => number): Spot {
  const start = Math.floor(at.bar / PHRASE_BARS) * PHRASE_BARS;
  if (direction > 0) {
    const next = start + PHRASE_BARS;
    return next < bars(at.piece) ? { piece: at.piece, bar: next, solo: false } : { piece: at.piece + 1, bar: 0, solo: true };
  }
  if (at.bar - start >= RESTART_BARS) return { piece: at.piece, bar: start, solo: false };
  if (start >= PHRASE_BARS) return { piece: at.piece, bar: start - PHRASE_BARS, solo: false };
  if (at.piece === 0) return { piece: 0, bar: 0, solo: false };
  const before = bars(at.piece - 1);
  return { piece: at.piece - 1, bar: Math.floor((before - 1) / PHRASE_BARS) * PHRASE_BARS, solo: true };
}

/** The bar of a track where its hand-over begins to be heard: where the incoming track starts, or for a cut where the tempo starts to move. */
export const transitionBar = (track: TrackShape): number => Math.max(0, Math.min(track.bars - 1, track.out.bars ? track.out.start : track.out.start - track.out.ramp));

/**
 * The start of the next transition from `at`: the playing track's own, or once that has begun the next track's.
 * `shape` gives a track's length and hand-over.
 */
export function nextTransition(at: { piece: number; bar: number }, shape: (piece: number) => TrackShape): Spot {
  const here = transitionBar(shape(at.piece));
  if (at.bar < here) return { piece: at.piece, bar: here, solo: false };
  return { piece: at.piece + 1, bar: transitionBar(shape(at.piece + 1)), solo: false };
}

/** Hand-picked styles as they travel in a link: `3:berlin_techno,5:minimal_techno`, tracks counted from 1. */
export function formatPins(pins: ReadonlyMap<number, string>): string {
  return [...pins]
    .sort(([a], [b]) => a - b)
    .map(([i, id]) => `${i + 1}:${id}`)
    .join(",");
}

/** The inverse of `formatPins`; whatever does not parse is left out. */
export function parsePins(text: string | null | undefined): Map<number, string> {
  const pins = new Map<number, string>();
  for (const part of (text ?? "").split(",")) {
    const m = /^(\d{1,6}):([a-z0-9_]+)$/.exec(part.trim());
    if (m && Number(m[1]) >= 1) pins.set(Number(m[1]) - 1, m[2]!);
  }
  return pins;
}
