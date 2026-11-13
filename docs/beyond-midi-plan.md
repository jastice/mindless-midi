# Heavier sound: plan

Merged from `oomph.md` (the phase order and most of phases 1 to 4) and the
earlier survey in this file (measurement, low end, the backlog and the
decisions).

**Status.** Phases 0 to 3 are built, as options on the shared engine. Mighty
Midi (`//src/mighty`) turns them all on, and Mindless Midi now does too, with
Synth as its default sound. Phase 4 is not started. Each phase below has a
"Built" note saying what exists, what was measured and what was left out. The
table under "What the code does today" describes the code before this work.

The weight comes from the mix and from how a note speaks. Through phase 3 the
score, the seed, the corpora and the `.mid` download stay intact: the MIDI file
remains a transcript of the notes. It stops being the piece only in phase 4,
when a bar contains audio that is not a note.

The diagnosis was from reading the code. Phase 0's measurements came with the
build and are in the notes below; one expectation did not hold (crest factor).

Sizes are rough: S is a day or two, M about a week, L several weeks.

## What the code does today

| Area | Today | Where |
| --- | --- | --- |
| Levelling | Three automatic gain stages. `RoleLeveler` steers each stem to a fixed loudness. The bus trim rides the mix toward an RMS target (0.5x to 2x). The FM path's `Leveler` does the same within ±6 dB. | [sound/leveler.ts](../src/sound/leveler.ts), [player.ts:680](../src/app/player.ts), [audio/leveler.ts](../src/audio/leveler.ts) |
| Master | 2.5:1 compressor (attack 20 ms) into a limiter (attack 2 ms). | [bus.ts:289](../src/sound/bus.ts) |
| Mix per role | High-pass, optional chorus, kick-timed gain dip, pan, reverb and delay sends. No EQ beyond the high-pass, no compression or saturation, nothing for the low end. | [bus.ts](../src/sound/bus.ts) |
| Velocity | Mostly amplitude: `vel^1.4` on synth drums, `vel^1.8` on samples, `vel^1.2` on subtractive voices. The subtractive filter envelope does scale with velocity, by `0.4 + 0.6v`. The arranger's floor is high: the quietest section plays at 62% of written velocity. | [synth.ts:361](../src/sound/synth.ts), [sampler.ts:564](../src/sound/sampler.ts), [parts.ts:54](../src/engine/parts.ts) |
| Legato | The synth can glide between notes, but only the bench sets `legato`. The live `notesOf` never does, so glide never runs on the site. | [player.ts:923](../src/app/player.ts) |
| Controllers | CC7, CC10 and CC11 once per piece, CC11 pinned at 127. No pitch bend in `ControlEvent`, `SynthSink`, the wasm binding or the MIDI writer. The stem engines receive notes only. | [piece.ts:482](../src/engine/piece.ts), [events.ts](../src/audio/events.ts) |
| Sections | `intensity` picks roles, groove density and velocity. It never reaches the bus; `Bus.setStyle` runs at piece boundaries. | [piece.ts:367](../src/engine/piece.ts), [player.ts:1008](../src/app/player.ts) |
| Hat choke | Exists on the sampler as `plan.cut`. The synth kit has none. | [sampler.ts:513](../src/sound/sampler.ts) |
| Offline render | Node renders FM only. The bus is a Web Audio graph, so stem engines render only in a browser. Style calibration is measured through the FM `Leveler`. | [tools/render](../tools/render/render_lib.ts) |
| Measurement | The bench has BS.1770 loudness, peak and a spectrogram. No crest factor or band energy. | [bench/loudness.ts](../src/bench/loudness.ts) |

## Phase 0 — Measure (S) — partly done

**Built.** `src/sound/measure.ts` has crest factor, short-term level range,
energy share below 100 Hz and from 100 to 300 Hz, and stereo correlation below
120 Hz. `src/sound/weight.test.ts` asserts them on real pieces rendered through
the synth engine in Node, plain against weighted (stems summed before the bus,
90 bars, past the first 12 seconds):

| Style | Full over sparse sections | Share below 100 Hz | Crest |
| --- | --- | --- | --- |
| Funk | 3.2 → 8.1 dB | 16% → 30% | 25.8 → 23.3 dB |
| Liquid drum & bass | 4.2 → 8.2 dB | 31% → 44% | 21.4 → 14.0 dB |
| Synthwave | 7.0 → 9.5 dB | 41% → 56% | 30.4 → 14.7 dB |

Crest went down, not up as phase 1 expected: drive and the compressed drum
copy lower it by design, and the plain path's figure is inflated by its own
gain spikes. Hypothesis 2 holds only mildly: the old leveller moves a written
two-bar crescendo by 1.1 to 1.6 dB, the new one by 0.4 to 0.65 dB; after a
single 60 ms burst the old one turns a steady tone down by more than 3 dB.

**Not done.** The numbers are not in the bench or in `tools/render`, there is
no reference track, and hypothesis 1 (bus trim and FM `Leveler` under a
four-on-the-floor bar) was not tested. Mighty Midi shows live peak, body,
crest and low-end share meters, which are for the eye, not for assertions.

Add to the bench, per engine and per stem, and to `tools/render` for the FM
path so the numbers can be asserted in tests:

- crest factor and short-term loudness range,
- energy share below 100 Hz and from 100 to 300 Hz,
- stereo correlation below 120 Hz,
- the same numbers for a dropped-in reference track.

Use them to test the two hypotheses phase 1 rests on:

1. A kick lifts the gain stages' envelope and the following half second gets
   quieter. The bus trim reads a 43 ms window about twelve times a second with
   slow smoothing, so a single kick may barely move it; the steady-state effect
   (a kick-heavy mix is simply turned down) may matter more. Plot gain against
   time under a four-on-the-floor bar.
2. `RoleLeveler` scales a drum or bass stem by its loudest hits, and flattens a
   written crescendo.

Done when the bench shows these numbers beside each variant and a reference,
and both hypotheses have a plot.

## Phase 1 — Let the peaks through, and give the low end a floor (M) — done

**Built.** In the render worker, on the stems, so it runs in a Node test
(`src/sound/weight.ts`, `src/sound/body_leveler.ts`; opt in with
`PlayerOptions.weighted`):

- `BodyLeveler` replaces `RoleLeveler` in the weighted path. It measures mean
  energy over 200 ms blocks with 20 seconds of memory, caps what one block can
  add, divides out the section's velocity scale, and reads a whole bar before
  applying gain. The kick and the rest of the kit share one leveller.
- The kick is rendered as its own stem until the mix: driven, shelved up,
  scooped at 280 Hz, then summed back into the drums. Ducking follows its
  envelope. Bass gets drive and its own shelf. A 6:1 compressed copy sits under
  the drums. Every stem is mono below 105 Hz.
- Section intensity scales duck depth, drive and the compressed copy in the
  worker, and the reverb send on the bus (fuller sections are drier).
- The bus limiter attacks in 8 ms with a soft clipper after it
  (`BusOptions.openLimiter`); the bus trim follows a 0.68 s window slowly,
  within 0.6x to 1.6x.
- `weightFor(styleId)` sets the amounts in three tiers, keeping each style's
  existing duck depths.

**Left out or open.** The FM `Leveler` is unchanged. Style calibration was not
rebuilt. Per-engine loudness is not tuned: Samples sat about 3.5 dB over target
on a fresh load. The weight presets are first guesses and have not been judged
by ear. Low shelf and mid band are fixed per role, not per style.

**Gain stages.** Change `RoleLeveler`, the bus trim and the FM `Leveler` so the
gain rides a slow body envelope and skips peaks when it measures loudness. Keep
the limiter as a ceiling, with a slower attack, so a short click survives. On
drums and bass, slow `RoleLeveler`'s upward move so one hit does not scale the
whole stem down to the pad. The leveller should correct how loud an instrument
is, not follow the performance.

**Drums and bass in the bus.** Blend a compressed copy of the drum stem under
the dry drums. Put a drive on the bass and the kick before the master
compressor.

**Low end.** Sum to mono below about 100 Hz. Add a low shelf and one mid band
per role next to the existing high-pass, so bass and kick can be given separate
space. Duck from the kick's actual envelope instead of a fixed dip.

**Intensity reaches the mix.** Pass `bar.info.intensity` to the bus at each
section start and scale duck depth, drum drive and reverb send around the style
preset. This is the cheap route to section contrast.

**What stays the same.** `NoteEvent`, `barsToMidi` and the FM event queue. The
plain chip only hears the leveller change.

**Afterwards.** Rebuild style calibration, because those gains were measured
through the old stage. Listen to funk and liquid drum & bass on the bench
before touching corpora.

**Tests.**

- A short burst above a steady tone does not drop the leveller gain inside 100 ms.
- A written two-bar crescendo leaves each stem engine within 1 dB of its shape.
- Phase 0 numbers before and after: crest factor and sub-100 Hz share should
  move toward the reference.

**Deferred decision.** Whether listeners get a "Dynamics: even / natural"
setting for section-level contrast. Peak-blind levelling keeps the even
background level while letting hits through, so this no longer blocks anything.
Decide after hearing phase 1.

## Phase 2 — Make velocity change the sound (S to M) — done

**Built.** Subtractive voices open the filter further and close it sooner with
velocity; synth drums scale click, strike pitch and ring. The sampler takes
Sonic Pi's hard recording from velocity 100 and the soft one up to 52 where a
kit has both (all already in `samples.lock.json`, so no refresh), and low-passes
single-recording instruments when played softly. Lead, counter and bass are
marked legato in `barScore`. The velocity floor is an arranger option
(`Expression.velocityFloor`); both pages use 0.5. Calibration was not rechecked.

Accents already exist: drum lanes are `X`, `x` and `o`, and motif velocities
are real. Playback mostly turns them into loudness.

- **Subtractive voices.** `sub()` already opens the filter envelope a little
  with velocity. Widen that range and shorten the decay as velocity rises, for
  bass and leads.
- **Synth drums.** Scale click and decay from velocity, not only output gain.
- **Sample kits.** Where the source set has hard and soft recordings of a drum,
  pick the harder one above a velocity threshold. New files mean refreshing
  `styles/samples.lock.json`. For an instrument with a single GM file per note,
  open a lowpass with velocity.
- **Legato.** Set it in `notesOf` when two notes of the same monophonic role
  touch, as the bench does. Glide then works for every lead that has it.
- **Velocity floor.** Lower the 0.62 floor in `vel()` so there is more range for
  the above to act on. Recheck calibration.

The `.mid` keeps the same note-ons and velocities. A General MIDI module plays
those velocities as loudness; the page also plays them as brightness, click and
glide. The file is still the piece; the rendering is ahead of the file.

## Phase 3 — Named gestures, still one channel (M) — done

**Built.** `g` on pattern notes in the corpus schema; `NoteEvent.gesture` and
`NoteEvent.curve`; `bend` in `ControlEvent`, `pitchBend` in `SynthSink`,
`EV_BEND` in the queue, `0xE0` in `barsToMidi`, RPN 0 at piece start
(`src/engine/gestures.ts`). The bundled libADLMIDI does export
`_adl_rt_pitchBend`. Synth and sampler play the same curve from
`ScoreNote.curves` by rendering the note plain and reading it back along the
curve (`src/sound/shape.ts`). The synth kit chokes. A test checks that FM
events, MIDI bytes and the note's curve agree.

No corpus has written gestures yet: they all come from arranger rules that look
at one bar (slide on a joined line note up to a fifth away, swell on a long
sustaining note or pad chord, accent on bass and kick opening a full section,
choke on an open hat before a closed one). Whether libADLMIDI honours CC11
rides audibly was not checked by ear.

Add an optional gesture on pattern notes: `swell`, `slide`, `accent`, `choke`.
Describe it in the corpus schema so a regen can use it, and reject anything
else. The arranger writes it onto `NoteEvent`.

**Plumbing this needs, none of which exists yet:**

- `bend` in `ControlEvent`, `pitchBend` in `SynthSink`, an event type in the
  queue, `0xE0` in `barsToMidi`, and the bend range set by RPN 0 at piece start.
- The bend call bound in the wasm module. To verify: upstream libADLMIDI has
  `adl_rt_pitchBend`, but the binding file only declares the calls in use and
  the bundled `libadlmidi-js` 2.2.0 export was not checked.
- The synth and sampler render a whole note at once, so a channel message that
  arrives after a note starts cannot reach it. Give them the same curve as
  breakpoints on the note (`ScoreNote.curves`), produced by the same code that
  emits the bend and CC11 events, so all engines and the file agree.

**Scope.** Slides and per-note swells on lead, bass and counter only: one MIDI
channel carries one bend and one expression lane. A whole-channel swell on a
pad is fine. A filter opening on one note of a chord cannot be a channel
message, so pads and comps otherwise stay block chords. `choke` makes the
sampler's existing `plan.cut` explicit and adds it to the synth kit.

This is the edge of MIDI. A piano roll of the download shows the notes and a
bend lane. The FM chip plays the bend and the volume ride if libADLMIDI honours
them, and a plain note where the gesture was timbre.

Done when one bar rendered to FM events, to a MIDI file and to
`ScoreNote.curves` describes the same curve in all three.

## Phase 4 — The break (L)

A clip is a second kind of event: asset, source range, the bars it covers,
gain, role. The seed picks it, so a seek can replay it. A style lists the clips
it may use; forms say where they go. The generator places them. It does not
invent the audio. The validator checks that the id exists, the length matches
and the tempo sits in the style's range.

Three kinds, in the order to build them:

1. **Free**: textures and beds (room tone, rain, crowd). No tempo, no key. They
   loop under a section.
2. **Sliced**: drum breaks and percussion loops. A build step cuts them at
   onsets; the arranger re-triggers slices on the grid. Tempo changes and the
   final ritardando then need no special handling.
3. **Stretched**: pitched loops that must follow tempo and key. This needs a
   time-stretcher in the worker. Defer until a style needs one, and end such
   clips before the ritardando bar.

What stops being MIDI:

- `barsToMidi` has nothing to write for a clip. The download is the notes
  underneath, and the MIDI button should say so.
- The piano roll walks `bar.notes`. A clip is a region or it is missing; the
  roll is no longer the whole piece.
- The FM worklet has only note-on and note-off. `fm` and `fm_bus` play the note
  reduction; the studio engines play the notes and the tape. One piece, four
  identical scores, ends here.
- Sample fetching is keyed by program and pitch range. A clip needs its own
  declaration: id, url, hash, tempo, bars, key, licence.
- Seeking drops note windows with `clear`. A clip has to restart at the right
  offset inside the asset.
- Calibration measures a note arrangement. Give each clip a fixed gain in its
  declaration so a breakbeat does not move every instrument's CC7.

Do this last, and only for a style that asks for a bed or a break (liquid drum
& bass, lo-fi, electro swing are the candidates).

## Backlog

Independent of each other; pick by what a style lacks once phase 3 is done.

**Still inside MIDI**

- **Layers and doubles (M).** Nine channels are unused. `Instrument.layers`
  doubles a part at an interval and level, entering by section intensity, so a
  chorus can get bigger without new material.
- **Drum vocabulary (M).** More GM lanes (pedal hat, ride bell, tambourine,
  congas), velocity digits beside `X x o`, flams and closing rolls as arranger
  rules, per-lane microtiming instead of one Gaussian for every note.
- **Transitions (M to L).** `build`, `drop`, `break` and `pickup` between
  sections, chosen from the intensity difference, and one planned energy peak
  per piece.
- **Better samples behind the same programs (M to L).** Honour the SFZ regions
  the loader now skips (release triggers, keyswitches, pedal), and replace GM
  fallbacks with multi-velocity CC0 sets for the programs in use.

**Outside MIDI**

- **Mix as style data (M).** Move `MixPreset` from `bus.ts` into
  `styles/<id>/mix.json` with a schema that briefs the LLM.
- **Bus as worker DSP (L).** Makes the mix renderable in Node, so Bazel can
  calibrate and test it and a regen can measure its own output and repair it
  ("kick has no energy below 60 Hz"). A prerequisite for trusting generated
  patches or mixes.
- **Patches instead of programs (L).** `Instrument.patch` beside `program`:
  `SubSpec` and `Kit` made public and extended. FM and the `.mid` fall back to
  the program and become approximations.
- **Parameter automation (M).** Filter sweeps, reverb throws and synthesised
  risers aimed at patch and bus parameters. Not representable in the `.mid`.

## What each step gives up

| Step | FM engine plays it | `.mid` is faithful | No downloads | Seed reproduces it |
| --- | --- | --- | --- | --- |
| Phase 1 | leveller change only | yes | yes | yes |
| Phase 2 | no (velocity stays loudness) | yes | yes | yes |
| Phase 3 | bends and swells, if honoured | yes | yes | yes |
| Phase 4 | note reduction only | no | no | yes, with pinned assets |
| Backlog, inside MIDI | yes | yes | yes, except better samples | yes |
| Backlog, outside MIDI | no, or approximates | patches approximate | yes | yes |

## Decisions

- After phase 1: a "Dynamics" listener setting, or stay even. Still open;
  section contrast is now about 8 to 9 dB.
- Decided: Synth is the default engine on both pages, and "FM + studio" is no
  longer offered in Mindless Midi (Mighty Midi keeps it as "Chip").
- Phase 4: accept a `.mid` that is only the notes underneath, labelled as such.
- Appetite for download size (harder drum recordings, better samples, clips).

## To verify

- Pitch bend is exported by the bundled libADLMIDI (verified). Whether it
  honours CC11 rides audibly, and CC1 and CC64 if used later.
- Phase 0 hypothesis 1 about the bus trim and the FM `Leveler`.
- Loudness per engine in the weighted path.
- CPU headroom in the render worker with `?perf`, before the bus moves into the
  worker or patches grow unison stacks.
