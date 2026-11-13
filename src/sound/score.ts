/**
 * A bar as the stem engines play it: notes in seconds from the bar's start,
 * each with the program sounding on its channel.
 */
import type { Bar } from "../engine/types.js";
import type { ScoreNote } from "./types.js";

export interface ScoreOptions {
  /** Mark line parts (lead, counter, bass) as legato, so a voice that can glide does when notes touch. */
  legato?: boolean;
  /** Carry each note's gesture and its curves (see engine/gestures.ts), in seconds. */
  gestures?: boolean;
}

/** `programs` is the program per channel so far; the bar's own program changes are applied to it. */
export function barScore(bar: Bar, programs: Map<number, number>, opts: ScoreOptions = {}): ScoreNote[] {
  for (const c of bar.controls) {
    if (c.kind === "reset") programs.clear();
    else if (c.kind === "program") programs.set(c.ch, c.value);
  }
  const spb = 60 / bar.bpm;
  return bar.notes.map((n) => {
    const note: ScoreNote = {
      t: n.beat * spb,
      dur: Math.max(0.01, n.dur * spb),
      key: n.key,
      vel: n.vel,
      ch: n.ch,
      role: n.role,
      program: programs.get(n.ch) ?? 0,
    };
    if (opts.legato && (n.role === "lead" || n.role === "counter" || n.role === "bass")) note.legato = true;
    if (opts.gestures && n.gesture) {
      note.gesture = n.gesture;
      if (n.curve) {
        note.curves = {
          ...(n.curve.bend && { bend: n.curve.bend.map(([at, v]) => [at * spb, v] as const) }),
          ...(n.curve.level && { level: n.curve.level.map(([at, v]) => [at * spb, v] as const) }),
        };
      }
    }
    return note;
  });
}
