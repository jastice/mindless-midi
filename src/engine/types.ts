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
  /** Exempt from swing (e.g. drums on a triplet grid). Consumed by the piece. */
  straight?: boolean;
}

export type ControlEvent =
  | { beat: number; kind: "program"; ch: number; value: number }
  | { beat: number; kind: "cc"; ch: number; cc: number; value: number }
  | { beat: number; kind: "bank"; value: number }
  | { beat: number; kind: "reset" }
  /** Output gain for the piece (calibrated loudness); not sent as MIDI. */
  | { beat: number; kind: "gain"; value: number };

export interface BarInfo {
  pieceIndex: number;
  pieceSeed: string;
  styleId: string;
  styleTitle: string;
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
}

export interface Bar {
  /** Global bar counter since the session started. */
  index: number;
  beats: number;
  bpm: number;
  notes: NoteEvent[];
  controls: ControlEvent[];
  info: BarInfo;
}

export function barSeconds(bar: Pick<Bar, "beats" | "bpm">): number {
  return (bar.beats * 60) / bar.bpm;
}
