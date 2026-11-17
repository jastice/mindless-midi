/**
 * The deck lanes on the HUD: for each deck, the next few phrases from now,
 * each one playing, going out, coming in, or idle. Where the two overlap is
 * the transition. Pure: from the heard bar's place, its transition data and
 * the set's plan for how the track hands over, once that is planned.
 */
import type { TransitionInfo, TransitionType } from "../engine/types.js";

/** Phrases a lane shows, the one playing now first. */
export const LANE_PHRASES = 4;

export type SegState = "on" | "out" | "in" | "idle";

export interface Seg {
  state: SegState;
  /** For "in" and "out": how far through the fade the phrase's middle is, 0 to 1. */
  level: number;
}

/** What a deck is doing now. "cued": the next track is planned on it and has not started. */
export type DeckRole = "air" | "out" | "in" | "cued" | "idle";

export interface DeckLane {
  deck: 0 | 1;
  /** The track on it: the one playing, else the next one planned for it (cued), or null. */
  piece: number | null;
  role: DeckRole;
  /** Whether it has the low end now. */
  dominant: boolean;
  segs: Seg[];
}

export interface Lanes {
  decks: [DeckLane, DeckLane];
  /** The transition within the lanes' span: its type and the phrases it covers (a cut: the phrase it lands on). */
  mix: { type: TransitionType; from: number; to: number } | null;
  /** 0-based phrase of the playing track, and bar in it. */
  phrase: number;
  barInPhrase: number;
}

export interface LaneInput {
  /** The heard bar: its track (the dominant deck's) and place in it. */
  piece: number;
  barInPiece: number;
  pieceBars: number;
  /** The heard bar's transition: in an overlap, or the bars before a cut. */
  transition?: TransitionInfo | undefined;
  /** How the playing track hands over to the next, once the set has planned it (null before). Not read in an overlap. */
  out: { type: TransitionType; start: number; bars: number } | null;
  phraseBars: number;
  phrases?: number;
}

/** The deck a track plays on: they alternate (as in the set conductor). */
const deckOf = (track: number): 0 | 1 => (track % 2) as 0 | 1;

/** A track's place on the lanes' axis, in bars from the start of the bar heard now: [from, to), with its fades. */
interface Span {
  piece: number;
  from: number;
  to: number;
  fadeIn?: [number, number];
  fadeOut?: [number, number];
}

const FAR = 1e9;

export function deckLanes(x: LaneInput): Lanes {
  const n = x.phrases ?? LANE_PHRASES;
  const pb = x.phraseBars;
  const b = x.barInPiece;
  const spans: Span[] = [];
  let mix: { type: TransitionType; at: [number, number] } | null = null;
  // A cut's transition is the run-up to it (the tempo moving), the outgoing track alone: the incoming lands after it.
  const t = x.transition?.type === "cut" ? undefined : x.transition;
  const cut = x.transition?.type === "cut" ? x.transition : undefined;
  if (cut) {
    const at = cut.bars - cut.bar;
    spans.push({ piece: cut.from, from: -FAR, to: at });
    spans.push({ piece: cut.to, from: at, to: FAR });
    mix = { type: "cut", at: [at, at] };
  } else if (t) {
    const overlap: [number, number] = [-t.bar, t.bars - t.bar];
    spans.push({ piece: t.from, from: -FAR, to: overlap[1], fadeOut: overlap });
    spans.push({ piece: t.to, from: overlap[0], to: FAR, fadeIn: overlap });
    mix = { type: t.type, at: overlap };
  } else if (x.out) {
    const o = x.out;
    const start = o.start - b;
    if (o.bars > 0) {
      const overlap: [number, number] = [start, start + o.bars];
      spans.push({ piece: x.piece, from: -FAR, to: overlap[1], fadeOut: overlap });
      spans.push({ piece: x.piece + 1, from: start, to: FAR, fadeIn: overlap });
      mix = { type: o.type, at: overlap };
    } else {
      spans.push({ piece: x.piece, from: -FAR, to: start });
      spans.push({ piece: x.piece + 1, from: start, to: FAR });
      mix = { type: o.type, at: [start, start] };
    }
  } else spans.push({ piece: x.piece, from: -FAR, to: x.pieceBars - b });

  const w0 = -(b % pb);
  const windows = Array.from({ length: n }, (_, j): [number, number] => [w0 + j * pb, w0 + (j + 1) * pb]);
  const segOf = (s: Span | undefined, [a, z]: [number, number]): Seg => {
    if (!s) return { state: "idle", level: 0 };
    for (const [state, f] of [["out", s.fadeOut], ["in", s.fadeIn]] as const) {
      if (!f) continue;
      const lo = Math.max(a, f[0]);
      const hi = Math.min(z, f[1]);
      if (hi > lo) return { state, level: Math.min(1, Math.max(0, ((lo + hi) / 2 - f[0]) / (f[1] - f[0]))) };
    }
    const present = Math.max(0, Math.min(z, s.to) - Math.max(a, s.from));
    return present * 2 >= z - a ? { state: "on", level: 0 } : { state: "idle", level: 0 };
  };

  const dominantDeck = deckOf(x.piece);
  const decks = ([0, 1] as const).map((deck): DeckLane => {
    const mine = spans.filter((s) => deckOf(s.piece) === deck);
    // The track on this deck that is sounding now, else the next one to.
    const now = mine.find((s) => s.from <= 0 && s.to > 0);
    const shown = now ?? mine.find((s) => s.from > 0);
    const segs = windows.map((w) => segOf(mine.find((s) => Math.min(w[1], s.to) > Math.max(w[0], s.from)), w));
    let role: DeckRole = "idle";
    if (now) role = t ? (now.piece === t.from ? "out" : "in") : "air";
    else if (shown) role = "cued";
    return { deck, piece: shown?.piece ?? null, role, dominant: deck === dominantDeck, segs };
  }) as [DeckLane, DeckLane];

  let shownMix: Lanes["mix"] = null;
  if (mix) {
    const [a, z] = mix.at;
    const hit = windows.map((w, j) => (z > a ? Math.min(w[1], z) > Math.max(w[0], a) : w[0] <= a && a < w[1]) ? j : -1).filter((j) => j >= 0);
    if (hit.length) shownMix = { type: mix.type, from: hit[0]!, to: hit[hit.length - 1]! };
  }
  return { decks, mix: shownMix, phrase: Math.floor(b / pb), barInPhrase: b % pb };
}
