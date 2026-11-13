import type { Gesture, Role } from "../corpus/constants.js";

/** A note in absolute time, as every non-OPL engine consumes it. */
export interface ScoreNote {
  /** Onset and duration, seconds (from the start of the clip or stream). */
  t: number;
  dur: number;
  key: number;
  vel: number;
  ch: number;
  role: Role;
  /** GM program sounding on this channel at the onset. */
  program: number;
  /** The next note of a monophonic line starts right where this one ends. */
  legato?: boolean;
  /** How the note is played (see engine/gestures.ts). A choked note stops at the end of `dur`. */
  gesture?: Gesture;
  /** The gesture's curves: [seconds after the onset, value] points, straight lines between. */
  curves?: {
    /** Pitch offset, semitones. */
    bend?: (readonly [number, number])[];
    /** Expression, 0..1. */
    level?: (readonly [number, number])[];
  };
}
