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
  /**
   * The patch per channel so far, kept by the caller like `programs`. When given, a note on a
   * channel whose instrument names a patch carries that name and its place on the track's beat clock.
   * In a style with parts the patch is per part (keyed by its id): a part's notes play its own, whatever the channel's.
   */
  patches?: Map<number | string, string>;
}

/** `programs` is the program per channel so far; the bar's own program changes are applied to it. */
export function barScore(bar: Bar, programs: Map<number, number>, opts: ScoreOptions = {}): ScoreNote[] {
  for (const c of bar.controls) {
    if (c.kind === "reset") {
      programs.clear();
      opts.patches?.clear();
    } else if (c.kind === "program" && c.part !== undefined) {
      // A part's own setup: the channel's program stands.
      if (c.patch !== undefined) opts.patches?.set(c.part, c.patch);
      else opts.patches?.delete(c.part);
    } else if (c.kind === "program") {
      programs.set(c.ch, c.value);
      if (c.patch !== undefined) opts.patches?.set(c.ch, c.patch);
      else opts.patches?.delete(c.ch);
    }
  }
  // Beats from the start of the track to this bar: a patch's modulators count from there.
  const barPos = bar.info.barInPiece * bar.beats;
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
    if (n.part !== undefined) note.part = n.part;
    if (n.part !== undefined && n.role === "drums") note.tonic = bar.info.tonic;
    const patch = opts.patches?.get(n.part ?? n.ch);
    if (patch !== undefined) {
      note.patch = patch;
      note.beat = spb;
      note.pos = barPos + n.beat;
    }
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
