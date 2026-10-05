/**
 * The style corpus: musical raw material written by an LLM at build time and
 * recombined endlessly by the in-browser arranger.
 *
 * Field descriptions are sent to Claude as part of the JSON schema, so they
 * double as the authoring guide. Keep them precise.
 */
import { z } from "zod";
import { CHORD_SUFFIXES, MODE_NAMES, TONIC_NAMES, VOICINGS } from "../theory/theory.js";

import { DRUM_LANES, type DrumLane, ROLES, type Role } from "./constants.js";

export { DRUM_LANES, ROLES, type DrumLane, type Role };

const unit = z.number().min(0).max(1);

export const Instrument = z
  .object({
    role: z.enum(ROLES),
    name: z.string().describe("Human-readable label, e.g. 'Square lead' or 'Brushed kit'."),
    program: z
      .number().int().min(0).max(127)
      .describe("General MIDI program number, 0-based (0 = Acoustic Grand Piano, 80 = Square Lead). Ignored for drums. Playback is OPL3 FM synthesis with a GM patch bank."),
    octave: z
      .number().int().min(1).max(7)
      .describe("Register the part sits in; middle C (MIDI 60) is octave 4. Bass is typically 2, pads 3-4, leads 4-5."),
    volume: unit.describe("Mix level 0..1."),
    pan: z.number().min(-1).max(1).describe("Stereo position, -1 left .. 1 right."),
  })
  .describe("One instrument per role.");
export type Instrument = z.infer<typeof Instrument>;

export const ChordSlot = z.object({
  symbol: z
    .string()
    .describe(
      `Roman numeral relative to the MAJOR scale of the key: I=tonic, bIII=+3 semitones, bVI=+8, bVII=+10, #iv=+6. ` +
        `Upper case = major triad, lower case = minor triad. Optional quality suffix, exactly one of: ${CHORD_SUFFIXES.filter(Boolean).join(" ")}. ` +
        `Upper-case + '7' is dominant; lower-case + '7' is minor seventh. Examples: i, bVI, bVIImaj7, ii7, V7b9, iiø7, IVadd9, i5, Isus2.`,
    ),
  beats: z.number().positive().describe("Duration in beats (quarter notes). Usually a whole bar or half a bar."),
});

export const Progression = z.object({
  id: z.string(),
  mood: z.string().describe("A few words, e.g. 'brooding loop' or 'turnaround'."),
  chords: z.array(ChordSlot).min(1).describe("Loops for as long as the section lasts. Total length should be a whole number of bars."),
});
export type Progression = z.infer<typeof Progression>;

export const PatternNote = z.object({
  t: z.number().min(0).describe("Onset in beats from the start of the pattern."),
  d: z.number().positive().describe("Duration in beats."),
  deg: z
    .number().int().min(-14).max(21)
    .describe(
      "Scale step. For anchor='chord' it counts from the current chord's root through the chord-scale, so 0=root, 2=3rd, 4=5th, 6=7th, 7=octave, 1=9th, 3=11th, 5=13th, -1=7th below. " +
        "For anchor='key' it counts from the key tonic through the mode (0=tonic, 4=5th degree).",
    ),
  v: unit.describe("Velocity 0..1; use dynamics and accents."),
  approach: z
    .boolean()
    .optional()
    .describe("Bass only: ignore deg and play a chromatic approach tone into the NEXT chord's root."),
});
export type PatternNote = z.infer<typeof PatternNote>;

export const Motif = z.object({
  id: z.string(),
  role: z.enum(["lead", "counter", "arp", "bass"]),
  anchor: z
    .enum(["chord", "key"])
    .describe("'chord' follows the harmony (best for arps and bass, also good for leads); 'key' keeps a fixed melodic contour (memorable hooks)."),
  lengthBeats: z.number().positive().describe("Pattern length in beats; one or two bars."),
  notes: z.array(PatternNote).min(1),
});
export type Motif = z.infer<typeof Motif>;

export const CompHit = z.object({
  t: z.number().min(0),
  d: z.number().positive(),
  v: unit,
});

export const CompPattern = z.object({
  id: z.string(),
  role: z.enum(["pad", "comp"]),
  voicing: z.enum(VOICINGS).describe("close, open (drop-2), shell (1-3-7), spread (root low + upper structure), power (1-5-8), rootless (3-5-7-9), triad."),
  lengthBeats: z.number().positive(),
  strum: z.number().min(0).max(0.5).describe("Beats between successive chord notes within a hit; 0 = block chord, 0.02-0.06 = gentle roll, 0.25 = arpeggiated."),
  hits: z.array(CompHit).min(1).describe("Rhythm of chord attacks. Hits crossing a chord change are re-voiced automatically."),
});
export type CompPattern = z.infer<typeof CompPattern>;

const lane = z
  .string()
  .describe("One character per step: 'X' accent, 'x' normal, 'o' ghost, '.' rest. Empty string = lane unused.");

export const DrumPattern = z.object({
  id: z.string(),
  kind: z.enum(["groove", "fill"]).describe("Fills replace the last bar of a section."),
  intensity: unit.describe("0 = sparse/quiet, 1 = full/driving. The arranger picks grooves near the section's intensity."),
  stepsPerBeat: z.number().int().min(1).max(6).describe("Grid resolution: 4 = 16th notes, 3 = 8th-note triplets, 2 = 8ths."),
  lanes: z
    .object(Object.fromEntries(DRUM_LANES.map((l) => [l, lane])) as Record<DrumLane, typeof lane>)
    .describe("Every non-empty lane must be exactly beatsPerBar * stepsPerBeat characters (one bar)."),
});
export type DrumPattern = z.infer<typeof DrumPattern>;

export const Section = z.object({
  label: z.string().describe("e.g. intro, A, B, bridge, breakdown, outro. Sections sharing a label share material."),
  bars: z.number().int().min(1).max(32),
  intensity: unit,
  roles: z.array(z.enum(ROLES)).min(1).describe("Which instruments play in this section."),
  progression: z
    .string()
    .optional()
    .describe("Optional progression id to bind to this label (e.g. a 12-bar blues). Otherwise the arranger picks one."),
});

export const Form = z.object({
  id: z.string(),
  sections: z.array(Section).min(1),
});
export type Form = z.infer<typeof Form>;

export const MelodyRules = z.object({
  density: unit.describe("How busy the lead is: 0 = sparse long tones, 1 = constant running notes."),
  low: z.number().int().min(24).max(96).describe("Lowest MIDI note for the lead."),
  high: z.number().int().min(36).max(108).describe("Highest MIDI note for the lead."),
  phraseBars: z.number().int().min(1).max(8).describe("Bars per melodic phrase (call/answer unit)."),
  stepwise: unit.describe("Preference for stepwise motion when the arranger varies motifs."),
  restProbability: unit.describe("Chance that a phrase is left silent for breathing room."),
  ornament: unit.describe("Chance of grace notes / neighbour-tone decoration."),
});
export type MelodyRules = z.infer<typeof MelodyRules>;

export const StyleCorpus = z.object({
  title: z.string(),
  description: z.string().describe("One or two evocative sentences shown in the UI."),
  tempo: z.object({ min: z.number().min(40).max(220), max: z.number().min(40).max(220) }).describe("BPM range."),
  beatsPerBar: z.number().int().min(2).max(7),
  swing: unit.describe("0 = straight; 1 = full triplet swing."),
  swingUnit: z.enum(["8th", "16th"]),
  humanize: unit.describe("Timing/velocity looseness. Chip music ~0.05, live trio ~0.5."),
  keys: z
    .array(z.object({ tonic: z.enum(TONIC_NAMES), mode: z.enum(MODE_NAMES as [string, ...string[]]) }))
    .min(1)
    .describe(`Candidate keys. mode is one of: ${MODE_NAMES.join(", ")}.`),
  instruments: z.array(Instrument).min(1),
  progressions: z.array(Progression).min(3),
  motifs: z.array(Motif).min(4),
  comping: z.array(CompPattern).min(1),
  drums: z.array(DrumPattern),
  forms: z.array(Form).min(1),
  melody: MelodyRules,
});
export type StyleCorpus = z.infer<typeof StyleCorpus>;

/** Hand-authored, non-LLM settings bound to a style in BUILD files. */
export interface StyleMeta {
  id: string;
  /** libADLMIDI embedded FM bank number. */
  bank: number;
  /** Swatch colour for the UI. */
  color: string;
}

/** What the browser downloads per style: corpus + build-time metadata. */
export interface StyleBundle extends StyleMeta {
  corpus: StyleCorpus;
  /** CC7 per role, from build-time loudness calibration (else derived from volume). */
  mixer?: Partial<Record<Role, number>>;
  /** Linear output gain that brings the style to the common loudness target. */
  gain?: number;
}
