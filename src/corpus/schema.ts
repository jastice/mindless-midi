/**
 * The style corpus: musical raw material written by an LLM at build time and
 * recombined endlessly by the in-browser arranger.
 *
 * Field descriptions are sent to Claude as part of the JSON schema, so they
 * double as the authoring guide. Keep them precise.
 */
import { z } from "zod";
import { CHORD_SUFFIXES, MODE_NAMES, TONIC_NAMES, VOICINGS } from "../theory/theory.js";

import { DRUM_LANES, type DrumLane, GESTURES, type Gesture, ROLES, type Role } from "./constants.js";
import { Kit, NamedPatch } from "./patch.js";
import type { SampleKit } from "./pack.js";

export { DRUM_LANES, GESTURES, ROLES, type DrumLane, type Gesture, type Role };

const unit = z.number().min(0).max(1);

const palette = z
  .string()
  .optional()
  .describe("Optional area tag. Forms with the same palette prefer this material; untagged forms use untagged material.");

const material = z
  .string()
  .optional()
  .describe("Optional part tag, for styles with `parts`: this item belongs to the part that names the same `material`, and to no other. Untagged items are for parts without one.");

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
    patch: z
      .string()
      .optional()
      .describe(
        "Id of one of the style's `patches`: the designed sound this instrument plays in the synth, instead of the stock sound of `program`. Not for drums (they play the style's `synthKit`). " +
          "Still give a `program` of the same family: players without patches use it, and it decides which gestures the arranger writes (38 or 39, synth bass, for a patch that should get slides and accents).",
      ),
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
  palette,
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
  g: z
    .enum(GESTURES)
    .optional()
    .describe(
      "Optional gesture, for lead, counter and bass lines only; use sparingly. 'slide' glides into the note from the one before, " +
        "'swell' lets a long note grow from soft to full, 'accent' leans on it. Omit for a plain note. Players that cannot bend or swell play the plain note.",
    ),
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
  palette,
  material,
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
  palette,
  material,
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
  palette,
  material,
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

export const Key = z.object({ tonic: z.enum(TONIC_NAMES), mode: z.enum(MODE_NAMES as [string, ...string[]]) });

export const Form = z.object({
  id: z.string(),
  sections: z.array(Section).min(1),
  palette: z
    .string()
    .optional()
    .describe("Area tag (e.g. 'lava caverns'): this form prefers material with the same palette. Shown to listeners."),
  tempo: z
    .object({ min: z.number().min(40).max(220), max: z.number().min(40).max(220) })
    .optional()
    .describe("Overrides the style's BPM range for this form."),
  keys: z.array(Key).optional().describe("Overrides the style's candidate keys for this form."),
  instruments: z
    .array(Instrument)
    .optional()
    .describe("Per-role instrument overrides for this form (e.g. a choir pad in a haunted area)."),
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
  trill: unit
    .optional()
    .describe("Chance that a long lead note opens with a trill from its upper neighbour (baroque ornamentation). Omit for none."),
});
export type MelodyRules = z.infer<typeof MelodyRules>;

export const Ending = z.object({
  picardy: z.boolean().optional().describe("A piece in a minor mode ends on the major tonic chord (a Picardy third)."),
  ritardando: z
    .number().min(0).max(0.5)
    .optional()
    .describe("How far the last bar slows into the final chord: 0 = in tempo, 0.3 = it arrives 30% slower. Chip and dance music 0; chamber music 0.2-0.35."),
});
export type Ending = z.infer<typeof Ending>;

export const Part = z
  .object({
    id: z.string().describe("Short name, unique among the parts, e.g. 'kick', 'hats', 'acid'. Shown to listeners."),
    role: z
      .enum(ROLES)
      .describe("The kind of line the arranger writes for it: drums (a pattern), bass or arp (an ostinato), pad or comp (chords), lead or counter (a melody). The style needs an instrument for the role; the part takes its program, register, level and bus from it."),
    patch: z.string().optional().describe("Id of one of the style's `patches`, if this part has its own sound. Omit to play the role's instrument (its patch, if it has one). Not for drums."),
    material,
    lanes: z
      .array(z.enum(DRUM_LANES))
      .min(1)
      .optional()
      .describe(
        "Drum parts only, and required for them: the lanes of the kit this part plays. A lane belongs to one part. " +
          "The part reads these lanes from the drum patterns of its `material` (the untagged ones if it has none), choosing the pattern nearest the section's intensity that has something on them.",
      ),
    enters: unit
      .optional()
      .describe(
        "The section intensity from which the part may play (default 0). A set that plays a track cooler leaves its hotter parts out. " +
          "Ignored for the part with the kick lane and the first bass part: they play wherever the section has drums and bass, and leave only for a breakdown.",
      ),
    octave: z.number().int().min(1).max(7).optional().describe("Register, if not the role instrument's."),
    volume: unit.optional().describe("Mix level 0..1, if not the role instrument's. Not for drum parts: a kit is levelled as one; balance it in the kit and in the pattern velocities."),
  })
  .describe("One line of a track with its own sound. Keep each part tiny: the interest is in which parts are in, not in what one part plays.");
export type Part = z.infer<typeof Part>;

export const Arrangement = z
  .object({
    change: unit.describe("Chance, every 4 bars, that a part enters or leaves when nothing has to. 0.3 is patient, 0.7 restless."),
    swap: unit.describe("Share of those changes that are a swap: one part out and another in on the same bar."),
    thin: unit.describe("Chance that the last bar of an 8-bar phrase drops a hat or percussion part for that bar: the simplest fill."),
    evolve: unit.describe("Chance, per part at each phrase boundary inside a section, that its pattern changes by one small step (a step more or less, an accent moved, a turn by a sixteenth). 0.1 to 0.3; a new section starts from the pattern as written."),
  })
  .describe("How often the arrangement grid changes. These decide whether a style is hypnotic or busy.");
export type Arrangement = z.infer<typeof Arrangement>;

export const StyleCorpus = z.object({
  title: z.string(),
  description: z.string().describe("One or two evocative sentences shown in the UI."),
  tempo: z.object({ min: z.number().min(40).max(220), max: z.number().min(40).max(220) }).describe("BPM range."),
  beatsPerBar: z.number().int().min(2).max(9),
  beatGroups: z.array(z.number().int().positive()).min(1).optional()
    .describe("Optional beat grouping within each bar, e.g. [3, 2] for 5/4, [2, 2, 3] for 7/4, or [2, 2, 2, 3] for 9/8. Must sum to beatsPerBar. Melodies treat the start of each group as a strong beat."),
  swing: unit.describe("0 = straight; 1 = full triplet swing."),
  swingUnit: z.enum(["8th", "16th"]),
  humanize: unit.describe("Timing/velocity looseness. Chip music ~0.05, live trio ~0.5."),
  keys: z
    .array(Key)
    .min(1)
    .describe(`Candidate keys. mode is one of: ${MODE_NAMES.join(", ")}.`),
  instruments: z.array(Instrument).min(1),
  progressions: z.array(Progression).min(3),
  motifs: z.array(Motif).min(4),
  comping: z.array(CompPattern).min(1),
  drums: z.array(DrumPattern),
  forms: z.array(Form).min(1),
  melody: MelodyRules,
  ending: Ending.optional().describe("How pieces come to a close. Omit for a plain in-tempo final chord."),
  patches: z
    .array(NamedPatch)
    .optional()
    .describe("The style's own synth sounds, which instruments name in `patch`. Omit to play General MIDI programs only."),
  parts: z
    .array(Part)
    .min(1)
    .optional()
    .describe(
      "The lines of a track, each with its own sound and material, brought in and out one at a time by the arranger. Several parts may share a role. " +
        "Omit for one part per role (the instruments), all playing wherever a section names their role.",
    ),
  arrangement: Arrangement.optional().describe("Rates for a style with `parts`. Omit for the defaults."),
  synthKit: Kit.optional().describe(
    "The style's own modelled drum machine, played by the drums role in the synth. Omit for the stock kit. (The sampled kit is not written here: it is a `sample_kit` in the style's BUILD file.)",
  ),
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
  /** CC7 for roles whose instrument a form overrides, by form id. */
  formMixers?: Record<string, Partial<Record<Role, number>>>;
  /** Linear output gain that brings the style to the common loudness target. */
  gain?: number;
  /** The style's drum kit from sample packs (`sample_kit`); without one its drums are silent and it cannot declare drum keys. */
  kit?: SampleKit;
}
