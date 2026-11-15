/**
 * Sounds as data: a `Patch` is one subtractive synth voice with movement
 * built in, a `Kit` is a modelled drum machine. A style may declare its own;
 * the synth's General MIDI families and built-in kits are written in the same
 * format (see sound/patches).
 *
 * As in schema.ts, the descriptions are the authoring guide a model writes
 * patches from: each says the unit, a sensible range and what it sounds like.
 */
import { z } from "zod";
import { DRUM_LANES } from "./constants.js";

const seconds = (min: number, max: number) => z.number().min(min).max(max);

export const WAVES = ["saw", "pulse", "tri", "sine", "noise"] as const;
export const FILTER_TYPES = ["low", "band", "high"] as const;
export const MOD_TARGETS = ["cutoff", "pitch", "pw", "amp", "pan", "width"] as const;
export const MOD_SHAPES = ["sine", "saw", "square", "random"] as const;

export const PatchOsc = z.object({
  wave: z
    .enum(WAVES)
    .describe(
      "Oscillator shape. 'saw' is bright and buzzy with every harmonic (basses, stabs, strings, acid). 'pulse' is hollow and reedy (see pw). " +
        "'tri' is soft with weak odd harmonics (flutes, mellow keys). 'sine' has no harmonics: a pure sub, or the carrier of an FM sound. " +
        "'noise' is unpitched white noise, shaped only by the filter (wind, sweeps, breathy hits); pitch, detune and fm do nothing to it.",
    ),
  pw: z
    .number().min(0.05).max(0.95)
    .optional()
    .describe("Pulse width, for wave 'pulse' only: the share of each cycle spent high. 0.5 (the default) is a square, hollow; 0.25-0.35 is nasal; 0.1 is thin and buzzy."),
  voices: z
    .number().int().min(1).max(7)
    .describe("Unison: how many copies of the oscillator sound together. 1 is a single focused voice (bass, acid, flute); 2-3 is thick; 4-7 is a supersaw wash. More voices cost more CPU."),
  detune: z
    .number().min(0).max(100)
    .describe("How far the unison copies are spread in pitch, in cents from the lowest to the centre and the centre to the highest. 0 with one voice. 5-10 is a slow chorus; 12-20 is a wide pad; over 30 is sour."),
  spread: z
    .number().min(0).max(1)
    .optional()
    .describe(
      "Stereo spread of the unison copies: 0 or omitted is mono, 0.5 is roomy, 1 is the copies fully left to right. Needs voices >= 2. " +
        "Leave it out for bass and kick-range sounds: the low end must be mono. Costs a second filter.",
    ),
  sub: z
    .number().min(0).max(1.5)
    .optional()
    .describe("Level of a square wave one octave below the note, added before the filter. 0.3 firms up a lead; 0.6-1 makes a bass sit under the mix. Omit for none."),
  fm: z
    .object({
      ratio: z
        .number().min(0.25).max(16)
        .describe("Frequency of the modulating sine as a multiple of the note's pitch. Whole numbers (1, 2, 3) stay in tune and add harmonics; 1.41, 2.76, 3.5 and the like are clangorous: bells, metal, techno stabs."),
      amount: z
        .number().min(0).max(12)
        .describe("Modulation index: how hard the modulator bends the oscillator. 0.5 adds a little edge, 2-3 is bright and electric, 6+ is harsh and noisy."),
      decay: seconds(0.005, 10)
        .optional()
        .describe("Seconds for the amount to fall away after the note starts (to about a third each time this passes). 0.05-0.2 gives a struck, bell-like attack that mellows; omit for a constant amount."),
    })
    .optional()
    .describe("One FM operator: a sine that modulates the oscillator's frequency. Cleanest on wave 'sine' (classic FM bells, electric pianos, hollow basses); on saw or pulse it adds growl. Omit for none."),
});

export const PatchFilter = z.object({
  type: z
    .enum(FILTER_TYPES)
    .describe(
      "'low' passes what is below the cutoff: the usual choice, darker as the cutoff falls. 'band' keeps only a band around the cutoff: thin, vocal, telephone-like, the classic chord stab. " +
        "'high' removes what is below the cutoff: airy, weightless (hats, risers, pads that leave room for the bass).",
    ),
  cutoff: z
    .number().min(20).max(18000)
    .describe("Where the filter rests with the envelope closed, in Hz. 80-300 is dark and subby, 400-1200 is warm, 2000-5000 is bright, 8000+ is nearly open. The envelope, keytrack and modulation add to this."),
  q: z
    .number().min(0.5).max(20)
    .describe("Resonance: the peak at the cutoff. 0.7 is flat and neutral, 1.5-3 has an audible edge, 4-8 whistles and squelches (acid), 10+ rings like a tone of its own. For 'band', higher is narrower."),
  keytrack: z
    .number().min(0).max(4)
    .describe("How far the cutoff follows the note: this many times the note's frequency in Hz is added to the cutoff. 0 keeps one cutoff for every note (low notes bright, high notes dull); 1-2 keeps the tone even across the keyboard; 3 keeps high notes brilliant."),
  env: z
    .number().min(0).max(12000)
    .describe("How far the filter envelope opens the cutoff at its peak, in Hz, for a note at full velocity (softer notes open less). 0 is a static filter; 500-1500 is a gentle bloom; 2500-5000 is a pluck or a stab; 6000+ is a hard zap."),
  a: seconds(0.001, 10).describe("Filter envelope attack, seconds to reach the peak. 0.002 for plucks, stabs and bass; 0.3-2 for a pad that opens slowly."),
  d: seconds(0.001, 10).describe("Filter envelope decay, seconds from the peak down to the sustain level. 0.05-0.15 is a tight pluck or stab, 0.2-0.5 a rounder bass, 1+ a slow close."),
  s: z.number().min(0).max(1).describe("Filter envelope sustain: the share of env that stays while the note is held. 0 closes fully (pluck), 0.3-0.6 keeps some brightness, 1 stays open."),
  r: seconds(0.005, 10).describe("Filter envelope release, seconds to close after the note ends. Usually the same as the amp release."),
});

export const PatchAmp = z.object({
  a: seconds(0.001, 10).describe("Attack, seconds from silence to full level. 0.002-0.005 is percussive, 0.03-0.08 is blown or bowed, 0.3-2 fades in (pads)."),
  d: seconds(0.001, 10).describe("Decay, seconds from full level down to the sustain level."),
  s: z.number().min(0).max(1).describe("Sustain level while the note is held, 0..1. 0 with a short decay is a pluck or a stab that ignores note length; 0.7-1 holds like an organ."),
  r: seconds(0.005, 4).describe("Release, seconds to fade after the note ends. 0.02-0.1 stops tight (bass, stabs); 0.5-2 lets a pad trail off."),
});

export const PatchMod = z.object({
  target: z
    .enum(MOD_TARGETS)
    .describe(
      "What moves. 'cutoff': the filter, depth in octaves up and down (0.5 breathes, 1-2 is a clear wobble or sweep). 'pitch': depth in semitones (0.1 is vibrato, 12 is a siren). " +
        "'pw': pulse width, depth 0..0.4 added and taken away (wave 'pulse' only; a slow one is the classic thick PWM pad). 'amp': tremolo or gating, depth 0..1 (1 with 'square' chops the sound to silence). " +
        "'pan': position, depth 0..1 (1 swings fully left to right). 'width': the stereo spread of the unison, depth 0..1 as a share of osc.spread (needs spread).",
    ),
  shape: z
    .enum(MOD_SHAPES)
    .describe("'sine' swings smoothly. 'saw' rises through the period and drops back: a ramp, a sweep that restarts. 'square' jumps between high and low: gating, trills. 'random' holds a new random value each period (sample and hold)."),
  beats: z
    .number().min(0.0625).max(256)
    .describe(
      "Length of one cycle in beats (quarter notes), locked to the track's bar lines and not to the note, so the movement runs on across notes. " +
        "0.25 is a 16th-note chatter, 1 pulses on the beat, 4 is one bar, 16-64 is a slow sweep over a phrase or more. Lengths that do not divide the bar (3, 5, 7) drift against the pattern, which keeps a loop alive.",
    ),
  depth: z.number().min(-24).max(24).describe("How far it moves, in the unit of its target (see target). Negative turns the shape upside down."),
  phase: z.number().min(0).max(1).optional().describe("Where in its cycle the modulator is on the first beat of the track, 0..1. Omit for 0 (a sine starts at its centre, rising)."),
});

export const Patch = z
  .object({
    osc: PatchOsc,
    filter: PatchFilter,
    amp: PatchAmp,
    drive: z
      .number().min(0).max(10)
      .optional()
      .describe("Saturation after the filter. 0.3-1 warms and thickens, 2-4 is overdriven and aggressive (acid, distorted bass), 6+ is fuzz. Louder too: lower level to match. Omit for clean."),
    mod: z
      .array(PatchMod).max(4)
      .optional()
      .describe("Movement: up to four tempo-synced modulators. A sound with none is static; one slow cutoff or pw modulator is usually what makes a loop feel alive."),
    glide: seconds(0.005, 0.5)
      .optional()
      .describe("Portamento, seconds. A note marked with the 'slide' gesture, or one that starts exactly where the last ended, glides in from the previous pitch in about this long. 0.03-0.08 is an acid slide, 0.15+ is a lazy swoop. Omit for none."),
    accent: z
      .object({
        cutoff: z.number().min(0).max(8000).describe("Extra filter envelope depth on an accented note, Hz. 1500-4000 makes accents bark."),
        q: z.number().min(0).max(10).describe("Extra resonance on an accented note, added to filter.q. 1-4 makes accents squelch."),
      })
      .optional()
      .describe("What the 'accent' gesture does besides playing the note louder. With glide, this is what turns a bass line with slides and accents into an acid line. Omit to leave accents as loudness only."),
    vibrato: z
      .object({
        rate: z.number().min(0.1).max(12).describe("Hz. 5-6 is a singer or a violin."),
        depth: z.number().min(0).max(100).describe("Cents each way. 5-10 is subtle, 15-25 is expressive."),
        delay: seconds(0, 2).describe("Seconds before it starts; it then fades in over 0.3 s. 0.15-0.4 so only held notes waver."),
      })
      .optional()
      .describe("A player's vibrato, free-running in Hz (not tempo-synced; use mod for synced movement). For acoustic imitations and leads. Omit for none."),
    scoop: z.number().min(-200).max(200).optional().describe("Onset pitch scoop, cents: the note starts this far off and settles in 30 ms. -30 to -40 imitates brass and sax attacks. Omit for none."),
    breath: z.number().min(0).max(0.5).optional().describe("Level of breath noise mixed in, tuned around the note. 0.03 for reeds, 0.12 for a flute. Omit for none."),
    formants: z
      .array(
        z.object({
          freq: z.number().min(100).max(8000).describe("Centre, Hz."),
          q: z.number().min(0.5).max(20).describe("Narrowness."),
          gain: z.number().min(0).max(4).describe("Level added to the filtered sound."),
        }),
      )
      .max(4)
      .optional()
      .describe("Fixed resonances added beside the filter, as in a voice or an instrument's body (a choir 'ah' is about 700, 1200 and 2600 Hz). Omit for a plain synth."),
    hp: z.number().min(20).max(4000).optional().describe("Low cut after the filter, Hz, to thin a sound out (a muted trumpet, a stab that must stay out of the bass). Omit for none."),
    level: z.number().min(0).max(1.5).describe("Output level before the mix; the mix then balances parts by role. 0.4-0.6 is normal; lower it for patches with drive or high resonance."),
  })
  .describe("A designed synth sound: oscillators into a filter into an amplifier, each with an envelope, plus tempo-synced movement.");
export type Patch = z.infer<typeof Patch>;
export type PatchMod = z.infer<typeof PatchMod>;

export const NamedPatch = Patch.extend({
  id: z.string().describe("Name an instrument refers to in its `patch` field, e.g. 'acid_bass'."),
});
export type NamedPatch = z.infer<typeof NamedPatch>;

// --- Drum kits ----------------------------------------------------------

export const KitPerc = z.object({
  lane: z.enum(DRUM_LANES).describe("The drum lane this sound replaces; tomLow, tomHigh, rim and shaker are the usual spare lanes."),
  freq: z.number().min(40).max(6000).describe("Pitch it settles on, Hz. 80-200 is a tom or a low bongo, 300-800 a conga or a bleep, 1000+ a tick or a zap."),
  bend: z.number().min(0).max(48).describe("Semitones above freq at the strike, falling within sweep. 0 is a pure tone, 3-7 a drum skin, 24+ a laser zap."),
  sweep: seconds(0.002, 0.5).describe("Seconds for the bend to fall. 0.01-0.03 for a drum, 0.1+ for a drop."),
  decay: seconds(0.01, 2).describe("Seconds for the tone to die to about a third. 0.03-0.08 is a tick, 0.15-0.3 a tom, 0.5+ rings."),
  fm: z
    .object({
      ratio: z.number().min(0.25).max(16).describe("Modulator frequency as a multiple of freq; non-whole numbers sound metallic."),
      amount: z.number().min(0).max(12).describe("Modulation index; it decays with the tone. 1-3 is a cowbell or a tin, 6+ is noise."),
    })
    .optional()
    .describe("FM on the tone, for metallic and bell-like percussion. Omit for a pure sine drum."),
  noise: z.number().min(0).max(1).optional().describe("Level of a short noise burst at the strike, 0..1. Omit for none."),
  pan: z.number().min(-1).max(1).describe("Stereo position, -1 left .. 1 right."),
  level: z.number().min(0).max(1.5).describe("Level; 0.5-0.7 sits with the kit."),
});

export const Kit = z
  .object({
    kick: z.object({
      f0: z.number().min(40).max(600).describe("Pitch at the strike, Hz. 90-120 is a soft acoustic thud, 150-220 a punchy drum machine, 300+ a clicky zap."),
      f1: z.number().min(25).max(120).describe("Pitch the kick settles on, Hz: its note. 42-50 is deep (techno, 808), 50-60 is tight and punchy."),
      sweep: seconds(0.005, 0.2).describe("Seconds for the pitch to fall from f0 to f1. 0.02-0.03 is a hard punch, 0.05 is rounder."),
      decay: seconds(0.05, 1.5).describe("Seconds for the body to die to about a third. 0.15-0.25 is short and dry, 0.3-0.45 is full, 0.6+ booms."),
      drive: z.number().min(0.5).max(8).describe("Saturation of the body and click. 1 is clean, 1.5-2.5 is fat, 3+ is hard and distorted."),
      click: z.number().min(0).max(1.5).describe("Level of the 4 ms noise click on the strike. 0.05 is felt-soft, 0.3-0.5 cuts through, 0.6+ is a hard tick."),
      sub: z
        .object({
          level: z.number().min(0).max(1.5).describe("Level of the tail beside the body. 0.4-0.8."),
          decay: seconds(0.05, 2).describe("Seconds for the tail to die to about a third. 0.25-0.5 fills the gap to the next kick at techno tempo without smearing into it."),
        })
        .optional()
        .describe("A clean sine tail at f1 that outlasts the driven body, as on a 909: the weight under a techno kick. Omit for a plain kick."),
    }),
    rumble: z
      .object({
        level: z.number().min(0).max(1.5).describe("Level against the kick. 0.3-0.5 is felt more than heard, 0.7+ is a wall."),
        cutoff: z.number().min(40).max(400).describe("Low-pass on the reverb, Hz. 70-110 keeps it a sub drone; 150-250 lets some growl through."),
        decay: seconds(0.1, 3).describe("Reverb time: seconds for the rumble to die away completely (60 dB). 1.2-2 keeps it sounding until the next kick at 125-135 BPM, a drone that breathes with the beat; under 0.6 is only a thump after each kick; 3 smears into a constant hum."),
        duck: seconds(0.01, 0.5)
          .optional()
          .describe("Seconds the rumble takes to swell in behind each kick, so the kick's punch stays clear. 0.06-0.12. Omit for 0.08."),
      })
      .optional()
      .describe("The Berlin low end: a reverberated, driven, low-passed copy of every kick, swelling in behind it and filling the gaps between kicks. Omit for none."),
    snare: z.object({
      tone: z.number().min(80).max(600).describe("Pitch of the drum's body, Hz. 170-240."),
      toneDecay: seconds(0.01, 0.5).describe("Seconds the body rings. 0.03 is tight, 0.1 is deep."),
      noiseDecay: seconds(0.02, 1).describe("Seconds the snare wires (noise) ring. 0.1 is dry, 0.3 is a long 80s tail or a brush."),
      noiseHp: z.number().min(200).max(8000).describe("High-pass on the noise, Hz. 800 is fat, 2500 is thin and crisp."),
      mix: z.number().min(0).max(1).describe("Balance from body (0) to noise (1). 0.6 is a drum machine, 0.85 is brushes."),
    }),
    hatScale: z.number().min(0.4).max(2).describe("Pitch of the metallic hi-hat and cymbal partials, 1 = normal. Lower is darker and trashier. Used by the cymbals, and by the hats when `hat` is omitted."),
    hatDecay: seconds(0.01, 0.2).describe("Seconds a closed metallic hat rings. 0.03-0.05. Used when `hat` is omitted."),
    toms: z
      .object({
        low: z.number().min(40).max(600).describe("Low tom pitch, Hz."),
        high: z.number().min(40).max(800).describe("High tom pitch, Hz."),
      })
      .optional()
      .describe("Tom pitches (congas, timpani, floor toms). Omit for 120 and 190 Hz."),
    hat: z
      .object({
        tone: z.number().min(1000).max(16000).describe("Centre of the band the hat is cut from, Hz. 7000-9000 is a classic machine hat, 10000-12000 is thin and silvery."),
        q: z.number().min(0.5).max(8).describe("Narrowness of that band. 0.7-1.5 is a wide hiss, 3+ is a pitched tick."),
        hp: z.number().min(500).max(14000).describe("High-pass after the band, Hz: nothing of the hat sounds below this. 6000-8000 keeps it out of everything else's way."),
        decay: seconds(0.005, 0.3).describe("Seconds a closed hat rings (to about a third). 0.015-0.03 is a tight tick, 0.05 is looser."),
        open: seconds(0.03, 1.5).describe("Seconds an open hat rings. 0.15-0.3 for the off-beat hat of techno and house."),
        metal: z.number().min(0).max(1).describe("Balance from pure filtered noise (0: soft, 606-like, shaker-ish) to six clashing square waves (1: metallic, 808/909-like)."),
      })
      .optional()
      .describe("Noise hats with their own filters, for closed and open hat. Omit to use the built-in metallic hat."),
    clap: z
      .object({
        tone: z.number().min(400).max(4000).describe("Centre of the clap's band, Hz. 1000-1300 is a full machine clap, 2000+ is a snap."),
        q: z.number().min(0.5).max(8).describe("Narrowness of the band. 1.5-2.5."),
        bursts: z.number().int().min(1).max(6).describe("How many hands: quick noise bursts 10 ms apart before the tail. 3-4 is the classic clap; 1 is a single snap."),
        decay: seconds(0.02, 1).describe("Seconds the tail after the bursts rings. 0.08-0.15 is dry, 0.3+ is a clap in a room."),
      })
      .optional()
      .describe("A drum-machine clap. Omit to use the built-in one."),
    ride: z
      .object({
        hp: z.number().min(1000).max(12000).describe("High-pass, Hz. 4000-6000 is a full ride, 8000+ is only the shimmer."),
        decay: seconds(0.05, 3).describe("Seconds it rings. 0.3-0.5 is a tight techno ride that drives 8ths or 16ths; 0.9+ washes."),
        level: z.number().min(0).max(1.5).describe("Level. 0.3 sits behind the hats."),
      })
      .optional()
      .describe("A ride cymbal with its own length and brightness. Omit to use the built-in one."),
    perc: z.array(KitPerc).max(6).optional().describe("Tuned percussion: sine or FM drums that take over drum lanes (toms, bongos, bleeps, zaps, cowbells). Omit for none."),
  })
  .describe("A modelled drum machine. Everything is synthesized, so every number can be chosen freely; there are no samples.");
export type Kit = z.infer<typeof Kit>;
export type KitPerc = z.infer<typeof KitPerc>;
