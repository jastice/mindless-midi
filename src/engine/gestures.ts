/**
 * Gestures: how a note is played beyond pitch, length and velocity, kept
 * inside what one MIDI channel can say.
 *
 *   slide   pitch bend into the note from the one before
 *   swell   expression (CC11) rising across a long note
 *   accent  velocity
 *   choke   the note stops where another cuts it (an open hi-hat closing)
 *
 * A gesture is written once, as a curve on its note. The channel's bend and
 * CC11 events are sampled from that same curve, so the FM chip, the MIDI file
 * and the engines that render a whole note at once (which read the curve
 * itself) all play the same shape.
 */
import type { Gesture } from "../corpus/constants.js";
import type { Breakpoint, ControlEvent, NoteCurve, NoteEvent } from "./types.js";

/** Pitch bend range each way, semitones. Set on every melodic channel by RPN 0 when a piece starts. */
export const BEND_RANGE = 2;
export const BEND_CENTER = 8192;
/** Beats between the bend or CC11 events of a curve. */
export const CURVE_STEP = 1 / 24;

const SWELL_FROM = 0.5;

/** Value of a curve at `at` beats after the note's onset. */
export function curveAt(points: readonly Breakpoint[], at: number): number {
  const first = points[0];
  if (!first) return 0;
  if (at <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]!;
    if (at <= t1) {
      const [t0, v0] = points[i - 1]!;
      return t1 > t0 ? v0 + ((v1 - v0) * (at - t0)) / (t1 - t0) : v1;
    }
  }
  return points[points.length - 1]![1];
}

/**
 * The curve of a gesture on a note of `dur` beats. `from` is where a slide
 * starts, in semitones from the note (the previous note's distance; anything
 * past the bend range starts at the range's edge, on the same side).
 */
export function gestureCurve(gesture: Gesture, dur: number, from = -1): NoteCurve | undefined {
  switch (gesture) {
    case "slide": {
      const start = Math.max(-BEND_RANGE, Math.min(BEND_RANGE, from)) || -1;
      const len = Math.max(CURVE_STEP * 2, Math.min(0.25, dur * 0.5));
      return { bend: [[0, start], [len, 0]] };
    }
    case "swell": {
      const len = Math.max(CURVE_STEP * 2, Math.min(dur * 0.65, 3));
      return { level: [[0, SWELL_FROM], [len, 1]] };
    }
    default:
      return undefined;
  }
}

export const bendValue = (semitones: number) => BEND_CENTER + Math.round(Math.max(-1, Math.min(1, semitones / BEND_RANGE)) * (BEND_CENTER - 1));
export const levelValue = (level: number) => Math.round(Math.max(0, Math.min(1, level)) * 127);

/**
 * Bend and CC11 events for the curves on `notes` (one bar, onsets in beats).
 * A channel has one bend and one expression lane: a curve stops where the
 * next curve on its channel starts, and every curve ends at rest, so a later
 * plain note is never left bent or quiet.
 */
export function gestureControls(notes: readonly NoteEvent[]): ControlEvent[] {
  const out: ControlEvent[] = [];
  const lanes: { pick: (c: NoteCurve) => Breakpoint[] | undefined; event: (beat: number, ch: number, v: number) => ControlEvent; quantize: (v: number) => number }[] = [
    { pick: (c) => c.bend, quantize: bendValue, event: (beat, ch, value) => ({ beat, kind: "bend", ch, value }) },
    { pick: (c) => c.level, quantize: levelValue, event: (beat, ch, value) => ({ beat, kind: "cc", ch, cc: 11, value }) },
  ];
  for (const lane of lanes) {
    const byChannel = new Map<number, NoteEvent[]>();
    for (const n of notes) {
      if (!n.curve || !lane.pick(n.curve)) continue;
      const list = byChannel.get(n.ch) ?? [];
      // Notes of one chord share a curve: the channel says it once.
      if (!list.some((m) => Math.abs(m.beat - n.beat) < CURVE_STEP)) list.push(n);
      byChannel.set(n.ch, list);
    }
    for (const [ch, list] of byChannel) {
      list.sort((a, b) => a.beat - b.beat);
      list.forEach((n, i) => {
        const points = lane.pick(n.curve!)!;
        const length = points[points.length - 1]![0];
        const next = list[i + 1];
        const cut = next !== undefined && next.beat < n.beat + length;
        const end = cut ? next.beat - n.beat : length;
        let last = NaN;
        for (let t = 0; t < end - 1e-9; t += CURVE_STEP) {
          const v = lane.quantize(curveAt(points, t));
          if (v === last) continue;
          last = v;
          out.push(lane.event(n.beat + t, ch, v));
        }
        // Where the next curve takes over it sets its own first value.
        if (!cut) {
          const rest = lane.quantize(points[points.length - 1]![1]);
          if (rest !== last) out.push(lane.event(n.beat + length, ch, rest));
        }
      });
    }
  }
  return out.sort((a, b) => a.beat - b.beat);
}

/** Registered parameter 0 (pitch bend sensitivity) for a channel, then the null parameter so later data entry is ignored. */
export function bendRangeControls(ch: number, beat = 0): ControlEvent[] {
  const cc = (n: number, value: number): ControlEvent => ({ beat, kind: "cc", ch, cc: n, value });
  return [cc(101, 0), cc(100, 0), cc(6, BEND_RANGE), cc(38, 0), cc(101, 127), cc(100, 127)];
}
