import type { Gesture } from "../corpus/constants.js";
import type { Role } from "../corpus/schema.js";
import type { ModeName } from "../theory/theory.js";

/** MIDI channel per role. Channel 9 (0-based) is GM percussion. */
export const CHANNELS: Record<Role, number> = {
  lead: 0,
  counter: 1,
  arp: 2,
  pad: 3,
  comp: 4,
  bass: 5,
  drums: 9,
};

/** A note, timed in beats relative to the start of its bar. */
export interface NoteEvent {
  beat: number;
  dur: number;
  ch: number;
  key: number;
  /** 1..127 */
  vel: number;
  role: Role;
  /** The part that plays it, in a style with parts (see corpus `parts`). */
  part?: string;
  /** Exempt from swing (e.g. drums on a triplet grid). Consumed by the piece. */
  straight?: boolean;
  /** How the note is played, when the piece is arranged with gestures (see gestures.ts). */
  gesture?: Gesture;
  /** The gesture as curves on this note. The same curves become the channel's bend and CC11 events. */
  curve?: NoteCurve;
}

/** A point of a curve: beats after the note's onset, and the value there. */
export type Breakpoint = readonly [at: number, value: number];

/**
 * Straight lines between breakpoints; the first value holds before the first
 * point and the last after the last. Every curve ends at rest (no bend, full level).
 */
export interface NoteCurve {
  /** Pitch offset, semitones. */
  bend?: Breakpoint[];
  /** Expression, 0..1 (CC11 / 127). */
  level?: Breakpoint[];
}

export type ControlEvent =
  /**
   * `patch` names the style's patch the channel's instrument plays, for engines that have patches (see corpus/patch.ts).
   * With `part`, the event sets up that part alone: its notes carry its id, and play this patch (or none).
   */
  | { beat: number; kind: "program"; ch: number; value: number; patch?: string; part?: string }
  | { beat: number; kind: "cc"; ch: number; cc: number; value: number }
  /** Pitch bend, 14 bits: 8192 is no bend, 0 and 16383 the full range down and up. */
  | { beat: number; kind: "bend"; ch: number; value: number }
  | { beat: number; kind: "bank"; value: number }
  | { beat: number; kind: "reset" }
  /** Output gain for the piece (calibrated loudness); not sent as MIDI. */
  | { beat: number; kind: "gain"; value: number };

export interface BarInfo {
  pieceIndex: number;
  pieceSeed: string;
  styleId: string;
  styleTitle: string;
  /** Area of the current form (its palette), if it has one. */
  area: string | undefined;
  /** Display name of the current key, e.g. "C harmonic minor". */
  keyName: string;
  /** Current tonic pitch class (including any modulation) and mode. */
  tonic: number;
  mode: ModeName;
  section: string;
  sectionIndex: number;
  sectionCount: number;
  barInSection: number;
  sectionBars: number;
  barInPiece: number;
  pieceBars: number;
  intensity: number;
  chords: string[];
  /** True for the trailing silence between pieces. */
  gap: boolean;
  /** The arrangement grid, in a style with parts: ids of the parts that are in for this bar. */
  parts?: string[];
  /** Of those, the ones resting for this bar only (a one-bar gap at the end of a phrase). */
  thin?: string[];
  /** On the first bar of a section that turns the track: everything in ("drop") or the low end and more out ("break"). */
  turn?: "drop" | "break";
  /** In the build before a drop (a style with `moves`): this bar of how many. */
  build?: { bar: number; bars: number };
}

export type MoveTarget = "gain" | "lowCut" | "highCut" | "lows" | "reverbSend" | "delaySend" | "patch" | "stutter" | "riser" | "impact";

/**
 * A change to the sound over time that is not a note. Units, by target:
 *
 *   gain                 a factor (1 is as it is)
 *   lowCut, highCut      Hz; at or past OPEN_LOW / OPEN_HIGH the filter is open (the sound as it is)
 *   lows                 dB below about 150 Hz (0 is as it is)
 *   reverbSend, delaySend  the role's send level, 0..1; the style's own comes back after
 *   patch                `param` of the part's patch in its own unit ("cutoff" Hz, "q", "env", "drive")
 *   stutter              `from`: the slice repeated, beats; `to`: semitones the last repeat is pitched by; `param` "gate" halves each repeat
 *   riser                Hz of its band, from and to; its level follows
 *   impact               Hz of the thump, from and to; it rings on past the bar
 *
 * A move over several bars is written as one per bar, each with its own
 * start and end values (`span` says which bar it is), so any bar can be
 * rendered alone. Nothing carries over: a bar without a move on a target is
 * the sound as it is.
 */
export interface Move {
  /**
   * A part, a role, or everything. In a set, `deck` says which deck's track it is on; with neither a part nor a
   * role it is everything on that deck. (A track's own moves name no deck: they ride on its bar.)
   */
  scope: { part?: string; role?: Role; deck?: 0 | 1 } | "master";
  target: MoveTarget;
  param?: string;
  from: number;
  to: number;
  /** Where it starts, beats from the start of the bar (default 0). Before it the target is at `from`, after it at `to`. */
  at?: number;
  /** Length in beats. */
  beats: number;
  /** "linear" (default) is straight in the target's unit, and in octaves for one in Hz. */
  curve?: "linear" | "ease";
  /** For a move over several bars: which bar of it this is (0-based), of how many. */
  span?: { bar: number; of: number };
}

/** Filter values at which a cut is open: the sound as it is. */
export const OPEN_LOW = 20;
export const OPEN_HIGH = 20000;

/** How a set gets from one track to the next (see set.ts). */
export type TransitionType = "blend" | "filter" | "cut" | "breakdown";

/** Where a bar of a set is in a transition: this bar of how many, between which tracks. */
export interface TransitionInfo {
  type: TransitionType;
  from: number;
  to: number;
  bar: number;
  bars: number;
  /** The bar of it from which the incoming track has the low end (a cut: `bars`, where it takes over). */
  swap: number;
}

export interface Bar {
  /** Global bar counter since the session started. */
  index: number;
  beats: number;
  bpm: number;
  notes: NoteEvent[];
  controls: ControlEvent[];
  info: BarInfo;
  /** What changes in the sound over the bar, in a style with `moves`. Absent otherwise. */
  moves?: Move[];
  /** In a set: the deck this bar's track plays on. Absent everywhere else. */
  deck?: 0 | 1;
  /** In a set's transition: the other deck's bar, sounding at the same time and tempo. */
  with?: Bar;
  transition?: TransitionInfo;
}

export function barSeconds(bar: Pick<Bar, "beats" | "bpm">): number {
  return (bar.beats * 60) / bar.bpm;
}
