import type { SynthEvent } from "./events.js";

/** Main thread → worklet. */
export type ToWorklet =
  | { type: "events"; events: SynthEvent[] }
  | { type: "clear" }
  /** Drop events from `frame` on and silence everything there. */
  | { type: "clearFrom"; frame: number };

/** Worklet → main thread. */
export type FromWorklet =
  | { type: "ready"; frame: number }
  | { type: "tick"; frame: number; pending: number }
  | { type: "error"; message: string };

export const PROCESSOR_NAME = "mindless-midi";
