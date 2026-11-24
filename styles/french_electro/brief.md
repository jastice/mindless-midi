# French Electro

Written by hand by Neon (Gemini 4) for DJ Claudia's pack only.

Neon-lit Parisian electro-house at 122 to 130 bpm, 4/4, straight sixteenths with
a light French-touch pocket (`swing: 0.08`). Seven aeolian keys around the
circle of fifths (`C`, `G`, `D`, `A`, `E`, `B`, `F#`), so every key has
compatible neighbours of its own and in all six of Claudia's other styles, while
opening up full minor-key chord movement (`i7`, `i9`, `bVI`, `bVImaj7`, `bVII`,
`bIII`, `bIIImaj7`, `iv7`, `v7`) that none of the one-chord techno or breakbeat
styles use.

Four-on-the-floor punch: a tight, chest-thumping club kick with a clean sub tail
and no Berlin rumble, a fat LinnDrum-style snare on two and four with funky
sixteenth ghost strokes, sizzling metallic-noise hi-hats, a disco tambourine
shaker, a crisp FM rim-snap, and Simmons-style pitched toms tuned to the root
and fifth of the track's key. Builds roll on the LinnDrum clap, doubling into
the drop. Sample playback pairs the Detroit TR-909 kick with velocity-layered
LinnDrum LM-2 snares, clap, hats, stick, toms, tambourine and crash.

The low end is a mono sawtooth-plus-sub slap bass driven into analog saturation,
with snappy filter envelopes, barking accents and tied octave slides across all
four beats so it grooves under the heavy sidechain pump and hands off seamlessly
across bass swaps. Above it, six designed voices:

- `neon_arp`: a glassy harmonic FM bell-pluck (`ratio: 2`, fast FM decay) on the
  tonic, fourth, fifth and octave (`{0, 3, 4, 7}`), in 1-, 2- and 3-bar loops.
  As the coolest running line (`enters: 0.10`), it is what the set brings in
  over another track's bass in blends.
- `acid_saw`: a gritty resonant sawtooth counter-riff with tied slides and
  barking accents that drifts across sections.
- `super_stab`: a five-voice stereo supersaw chord stab with a four-bar French
  filter sweep, chorus and hard kick-driven ducking.
- `vocoder_choir`: a three-voice PWM pulse through three fixed vocal formants
  (`720`, `1350`, `2600` Hz) above a 580 Hz low-cut for wide robotic choir
  punctuation.
- `neon_lead`: a soaring stereo saw-plus-sub synth lead with pitch glide and
  gentle delayed vibrato, entering at the drops and peaks.
- `pwm_pad`: a four-voice Juno-style stereo PWM pad that swells in breakdowns
  and pumps under the kick when the floor returns.

Six forms of 128 to 160 bars: tonic-anchored mix-in and mix-out sections (`0.3`
intensity) for clean overlaps, full four-bar harmonic progressions in the body
and peaks, sixteen-bar breakdowns without the low end, mostly eight-bar builds
into explosive drops, frequent filter sweeps and phrase-end micro-stutters
(`0.16`). Fifteen parts in all; at most nine at once, three pitched lines, two
percussion parts and two noise layers.

Mix preset in `src/sound/bus.ts` (tight bright club room, dotted-eighth
ping-pong delay, chorused chords and pad, hard French-touch sidechain pump) and
punchy drive/crush weight in `src/sound/weight.ts`. Sounds and mixes are
verified by acoustic measurement (`src/sound/french_electro.test.ts`).
