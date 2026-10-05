/**
 * Messages between the main thread, the render worker and the stem worklet
 * for the non-default sound engines.
 */
import type { Role } from "../corpus/constants.js";
import type { Bar } from "../engine/types.js";
import type { PlannedNote, SampleData } from "./sampler.js";
import type { ScoreNote } from "./types.js";

/** "fm" is the default OPL3 worklet path; the others render stems in the worker. */
export type Engine = "fm" | "fm_bus" | "synth" | "samples";
export type StemEngine = Exclude<Engine, "fm">;

export const STEM_PROCESSOR = "mindless-stems";

export type ToWorker =
  | { type: "init"; sampleRate: number; port: MessagePort }
  | { type: "wasm"; wasm: ArrayBuffer }
  | { type: "samples"; items: [string, SampleData][] }
  | {
      type: "bar";
      engine: StemEngine;
      /** Absolute frame where the bar starts, and its length. */
      start: number;
      frames: number;
      styleId: string;
      newPiece: boolean;
      /** Mix intent per role (corpus volume). */
      levels: Partial<Record<Role, number>>;
      /** Notes in absolute seconds (frame / sampleRate). */
      notes: ScoreNote[];
      /** samples: one plan per note. */
      plans?: PlannedNote[];
      /** fm_bus: the bar itself, for libADLMIDI. */
      bar?: Bar;
    }
  | { type: "clear"; from: number };

/** Worker -> stem worklet. `data` holds l, r per entry of `roles` (role indices). */
export type ToStems =
  | { type: "pcm"; start: number; frames: number; roles: number[]; data: Float32Array[] }
  | { type: "clear"; from: number };

/** Stem worklet -> main thread. */
export type FromStems = { type: "tick"; frame: number; buffered: number };
