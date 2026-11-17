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
  /** The part that plays it, in a style with parts: its own line, window and level. */
  part?: string;
  /** GM program sounding on this channel at the onset. */
  program: number;
  /** Name of the style's patch this note plays instead of `program` (see corpus/patch.ts), where the engine has it. */
  patch?: string;
  /** For a patch's tempo-synced movement: seconds per beat at the note, and the onset in beats from the start of its track. */
  beat?: number;
  pos?: number;
  /** The track's tonic pitch class at the note, for a kit's tuned percussion. Drum notes of a style with parts carry it. */
  tonic?: number;
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
