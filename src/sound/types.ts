import type { Role } from "../corpus/constants.js";

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
}
