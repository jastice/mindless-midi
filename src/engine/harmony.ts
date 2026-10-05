import type { Progression } from "../corpus/schema.js";
import { type Chord, parseRoman } from "../theory/theory.js";

export interface ChordSpan {
  chord: Chord;
  /** Section-relative beats. */
  start: number;
  end: number;
}

/** A progression looped over the length of a section. */
export class Harmony {
  readonly spans: ChordSpan[] = [];

  constructor(progression: Progression, sectionBeats: number) {
    let t = 0;
    let i = 0;
    const chords = progression.chords;
    while (t < sectionBeats - 1e-9) {
      const slot = chords[i % chords.length]!;
      const end = Math.min(t + slot.beats, sectionBeats);
      this.spans.push({ chord: parseRoman(slot.symbol), start: t, end });
      t = end;
      i++;
    }
  }

  at(beat: number): ChordSpan {
    for (const s of this.spans) if (beat < s.end - 1e-9) return s;
    return this.spans[this.spans.length - 1]!;
  }

  /** Spans overlapping [from, to). */
  between(from: number, to: number): ChordSpan[] {
    return this.spans.filter((s) => s.end > from + 1e-9 && s.start < to - 1e-9);
  }
}
