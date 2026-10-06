/**
 * What a style needs to be played: the instruments that can sound and the
 * pitches each one can reach.
 *
 * The arranger takes its registers from here (so they are defined once), the
 * build derives each style's `sound.json` from it to fetch exactly the sampled
 * notes that can be played, and a test holds the arranger to the declared
 * bounds. Everything is computed from the corpus, so a corpus change moves the
 * declaration with it.
 */
import { type Voicing, parseRoman, voicingCandidates } from "../theory/theory.js";
import { DRUM_LANES, GM_DRUMS, type Role } from "./constants.js";
import type { Instrument, MelodyRules, StyleCorpus } from "./schema.js";

/** Inclusive MIDI key range. */
export type PitchRange = readonly [low: number, high: number];

/** One sounding instrument and the keys its part can play. */
export interface SoundInstrument {
  role: Exclude<Role, "drums">;
  /** General MIDI program. */
  program: number;
  octave: number;
  range: PitchRange;
}

/** Everything a style can ask a sound engine to play. */
export interface SoundDeclaration {
  /** Per (role, program, octave), across the base instruments and every form's overrides. */
  instruments: SoundInstrument[];
  /** General MIDI percussion keys the style's kit can be asked for, ascending. */
  drums: number[];
}

/** Part registers around the instrument's octave; see the part writers in engine/piece.ts. */
export function melodicRange(role: "lead" | "counter" | "bass" | "arp", octave: number, melody: Pick<MelodyRules, "low" | "high">): PitchRange {
  const center = 12 * (octave + 1);
  switch (role) {
    case "lead":
      return [melody.low, melody.high];
    case "counter": {
      const c = center + 5;
      return [Math.max(36, c - 10), Math.min(96, c + 12)];
    }
    case "bass":
      return [Math.max(28, center - 8), center + 16];
    case "arp":
      return [center - 7, center + 19];
  }
}

/** Chord symbols a style can sound: its progressions, and the tonic chord that ends a piece. */
function chordSymbols(corpus: Pick<StyleCorpus, "progressions">): string[] {
  return [...new Set(["I", "i", ...corpus.progressions.flatMap((p) => p.chords.map((c) => c.symbol))])];
}

/**
 * Reach of a chord part: every voicing its patterns use (plus the "spread"
 * that holds the final chord) of every chord, in every key.
 */
export function chordRange(corpus: Pick<StyleCorpus, "progressions" | "comping">, role: "pad" | "comp", octave: number): PitchRange {
  const center = 12 * (octave + 1) + 4;
  const voicings = new Set<Voicing>(["spread"]);
  for (const p of corpus.comping) if (p.role === role) voicings.add(p.voicing);
  let low = Infinity;
  let high = -Infinity;
  for (const symbol of chordSymbols(corpus)) {
    const chord = parseRoman(symbol);
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const v of voicings) {
        for (const notes of voicingCandidates(tonic, chord, v, center)) {
          low = Math.min(low, ...notes);
          high = Math.max(high, ...notes);
        }
      }
    }
  }
  return [low, high];
}

/** The keys an instrument's part can play, by role. */
export function pitchRange(instrument: Pick<Instrument, "role" | "octave">, corpus: Pick<StyleCorpus, "melody" | "progressions" | "comping">): PitchRange {
  const { role, octave } = instrument;
  if (role === "drums") throw new Error("drums are declared by key, not range");
  return role === "pad" || role === "comp" ? chordRange(corpus, role, octave) : melodicRange(role, octave, corpus.melody);
}

/** Percussion keys: the lanes the patterns use, plus what the ending plays (crash and kick, or the low drum). */
function drumKeys(corpus: Pick<StyleCorpus, "drums">): number[] {
  const keys = new Set([GM_DRUMS.crash, GM_DRUMS.kick, GM_DRUMS.tomLow]);
  for (const p of corpus.drums) for (const lane of DRUM_LANES) if (/[Xxo]/.test(p.lanes[lane])) keys.add(GM_DRUMS[lane]);
  return [...keys].sort((a, b) => a - b);
}

export function declareSound(corpus: StyleCorpus): SoundDeclaration {
  const all = [...corpus.instruments, ...corpus.forms.flatMap((f) => f.instruments ?? [])];
  const seen = new Map<string, SoundInstrument>();
  for (const inst of all) {
    if (inst.role === "drums") continue;
    const id = `${inst.role}:${inst.program}:${inst.octave}`;
    if (!seen.has(id)) seen.set(id, { role: inst.role, program: inst.program, octave: inst.octave, range: pitchRange(inst, corpus) });
  }
  return { instruments: [...seen.values()], drums: drumKeys(corpus) };
}
