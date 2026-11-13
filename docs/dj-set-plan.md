# DJ Claudia: design and implementation plan

Built so far: the engine half of step 1 (see "Step 1", "Built"). Nothing else.
This is written against `main` at `b4dabe6`; the
transitions and backlog work done in another session is not in that checkout,
so where this plan says "new", check first whether that work already has it.

Sizes are rough: S is a day or two, M about a week, L several weeks.

## What she is

DJ Claudia is a new app, the third beside Mindless Midi and Mighty Midi. She
plays an endless, seeded DJ set: tracks that blend into each other on the
beat, with builds and drops, travelling slowly across styles and tempos.

The sound she is after is Berlin techno, psychedelic house, big beat and
electro. The goal for a single track is arrangement complexity in the
direction of Professor Kliq: many parts, each a designed sound, with something
changing every few bars. A first version that plays a minimal techno set is
enough to start.

### Decided

- A new app, not a mode of Mighty Midi. Code in `src/claudia`.
- Sets are endless and seeded. Same seed, same pool, same set; a link lands on
  the same track and bar.
- Sets evolve: the style and the tempo drift and travel over time.
- Synth and Samples engines only. No FM chip.
- No `.mid` of a set. Notes stay the internal language; MIDI is not a
  requirement here. Mindless Midi and Mighty Midi keep the promise that the
  MIDI file is the piece, and nothing in this plan changes what they play.

### Out of scope

- Yello-like sample design: collages of found sounds and voices sculpted by
  hand. One-shot drum samples are in; curated audio as the identity of a track
  is not.
- Vocals.
- Mixing real recordings, beat detection, or anything that needs audio in.
- Odd meters. A set is 4/4.

### Terms

- **Track**: one piece (one style, one key, one form).
- **Part**: one line in a track with its own sound (a hat loop, an acid line, a
  stab). Today a track has at most seven; here it has many.
- **Patch**: a designed sound, described as data, with movement built in.
- **Deck**: a slot that plays one track. There are two, so two tracks can sound
  at once.
- **Transition**: the stretch where the outgoing and incoming track overlap.
- **Phrase**: 8 bars of 4/4. Everything a DJ does starts on a phrase boundary.
- **Move**: a change to the sound over time that is not a note (open a filter,
  fade a deck, swap the bass, stutter a bar).

## Order of work, and why

The earlier draft built the set machinery first. That would give a well-mixed
set of tracks that still sound like stock instruments. This order makes one
track sound rich first, so the set machinery has something worth blending.

| Step | What | Size | Model for the code | What you can hear after it |
| --- | --- | --- | --- | --- |
| 1 | The app shell, a minimal techno corpus, and a one-deck set conductor (gapless, steady tempo, compatible keys, cut on the phrase) | M | Opus | Claudia plays an endless minimal techno set, with today's sounds |
| 2 | Patches: designed sounds with movement, for synth voices and drum kits | L | Fable | The same set sounds like techno and not like General MIDI |
| 3 | Parts: many lines per track, and an arrangement grid that brings them in and out by phrase | L | Fable | Tracks that keep changing; layered percussion |
| 4 | Moves inside a track: sweeps, builds and drops, risers, stutters and repeats | M | Opus | Tension, release and the "edited" feel |
| 5 | Two decks: overlapping tracks, bass swap, blended transitions | L | Fable | A set that mixes instead of cutting |
| 6 | Travel: tempo drift, bridges between distant tempos, more styles (psychedelic house, electro, big beat) | M, plus S per style | Opus | A set that goes somewhere |
| 7 | The page finished: decks, set timeline, tracklist, recording | M | Opus for the design, Sonnet for the wiring | The app as a whole |

Steps 2 to 4 are what reach for Kliq-like complexity. Steps 5 and 6 are what
make it a DJ set. Step 1 exists so there is always something playing to judge
the rest by.

## Which model for what

Recommendations, not measurements: no model has been tried on any of this yet.
The Claude tiers are ranked by capability (Fable, then Opus, then Sonnet).
Grok has written corpora for this repo (as has Astra), but how it compares on
the tasks below is not known here, so it is placed only where a second opinion
is useful and a bad result is cheap to throw away.

**The rule behind the table.** Use the strongest model where a change must
thread through shipped code without altering its output, where correctness
cannot be fully captured by a test, or where the model has to imagine a sound
from numbers. Use a cheaper one where the work is specified, self-contained
and checked by a validator or a test.

**Code**

| Work | Model | Why |
| --- | --- | --- |
| Step 5: `StemDeck`, `SetMix`, the bus split, extracting from `Player`, `SetPlayer` | Fable | The largest change to shipped code, with timing, seeking and prefetch across two tracks; failures are intermittent and audible, not caught by types |
| Step 3: parts through the arranger, worker and leveller; the arrangement grid | Fable | "Role" is assumed everywhere; "no parts means today's output" must hold bit for bit |
| Step 2: the patch engine (modulation, filter modes, FM, drum models) | Fable | Synthesis code where small numerical choices decide whether it sounds right, under the same bit-identical constraint |
| Step 1: `SetConductor`, `Piece` options, key compatibility | Opus | Pure and well specified; the design is done |
| Step 4: moves, risers, stutter | Opus | Self-contained arithmetic on stems with clear tests |
| Step 6: drift, bridges, style neighbours | Opus | Rules on top of step 1 |
| Step 7: the page's visual design | Opus | Taste matters; logic is light |
| Step 7: wiring, tracklist, recording; Bazel targets; tests for any step once the design is fixed; docs | Sonnet | Routine, and the patterns already exist in `src/mighty` |
| Reviewing steps 2, 3 and 5 before merge | Fable | The bit-identical guarantee is only as good as the review of what the comparison test does not cover |

**Musical content** (through `//tools/generate`)

| Work | Model | Why |
| --- | --- | --- |
| Patches, every style | Fable | Forty parameters, no ears: this is knowledge of what a sound is made of. The plan's biggest unknown |
| The first corpus of each genre, with its parts list and arrangement rates | Fable | Genre knowledge and restraint; weaker models write too much music for techno |
| Further corpora in a genre that already has a good one to imitate | Opus or Sonnet | Variation on an example |
| A second take on a corpus, for variety between styles | Grok | The repo already uses other models for this; the validator rejects what is malformed, and a dull corpus is cheap to discard. Not for patches until one has been heard |
| Repair after the validator rejects a corpus | Sonnet | The errors are specific |
| Schema descriptions for parts, patches and kits (they are the prompt) | Fable | Every generated style inherits their quality |

No model replaces listening. Whatever writes a patch or a corpus, someone has
to hear it before it ships; `measure.ts` only catches gross errors.

## What can be reused, and what cannot

| Area | Reuse | Change needed | New |
| --- | --- | --- | --- |
| Theory, RNG, seeds (`src/theory`) | As is | A key-compatibility function | |
| Corpus schema and validator (`src/corpus`) | The format, the validator, the LLM generation flow | Optional blocks for parts, patches, kits and set hints | Claudia's own corpora |
| `Piece` (`src/engine/piece.ts`) | Planning, sections, every part writer, gestures | Options to fix tempo and tonic, to drop the ending and gap, to bias intensity; rendering by part instead of by role | The arrangement grid |
| `Conductor` | Not reused: it picks each piece independently and plays it to its ending and gap | Extract a small `BarSource` interface both conductors satisfy | `SetConductor` |
| Synth (`src/sound/synth.ts`) | The oscillators, filters and voice code | `SubSpec` and `Kit` become public data instead of tables in the source | Modulation, drive, new drum models |
| Sampler | Loading, mirroring, the lock file, one-shot playback | Kits declared by the style instead of a table keyed by style id | Drum-machine kits for techno and electro |
| Curves, touch, `BodyLeveler`, `WeightedMix` | The DSP | Stems keyed by part, grouped by role; later run once per deck | `SetMix`, the stage above two decks |
| Render worker | Rendering and levelling code | Its state is global and per role; it moves into a per-deck object | Move automation |
| Stem worklet | As is | Created with more outputs | |
| `Bus` | Role chains, sends, reverb, delay | Split into a per-deck strip and one shared master | |
| `Player` (`src/app/player.ts`) | Used whole for steps 1 to 4. For step 5: the audio clock, engine boot, sample prefetch | Those parts are extracted so two players can share them | `SetPlayer` scheduling |
| Pages | Fonts, the serve tool, the Bazel site pattern, the media-key anchor | | Claudia's page |
| `barsToMidi`, FM worklet, FM `Leveler`, GM soundfont fallback | Not used | | |

Composition and the sound engines carry over. The new work is in three
places: sounds and parts as data (steps 2 and 3), things that are not notes
(step 4), and everything that assumes one piece at a time (step 5).

## Step 1: something playing (M)

Model: Opus for the code; Fable for the `minimal_techno` corpus, as the first of its genre.

**The app.** `src/claudia` with its own page, design and Bazel targets
(`:site`, `:serve`, `:deploy`), built the way Mighty Midi was. It uses the
shared `Player` with the weighted mix and gestures on.

**Her corpora.** A separate pack, `//styles:claudia`, so her styles do not
appear in the other apps and theirs do not appear in hers by default. The
first is `minimal_techno`: 126 to 132 bpm, one- and two-chord progressions,
short ostinatos, sections of 8, 16 and 32 bars.

**`SetConductor`** (`src/engine/set.ts`), in its first form. It satisfies the
same `BarSource` interface as `Conductor` (`nextBar`, `seek`, `layout`,
`setStyles`), so the existing `Player` can drive it.

- Each track's tempo is within 3% of the one before; its key is compatible
  with the one before.
- No ending chord and no gap. The next track starts on the bar after the last,
  on a phrase boundary. This is a cut; blends come in step 5.
- The first and last 16 bars of a track are a mix-in and mix-out: the track's
  own bars with roles left out (drums first, then bass, then the rest), so
  even a cut sounds like one track handing over to the next.

**`Piece` options**, all off by default:

- `fixed: { bpm, tonic }` instead of drawing them.
- `frame: "set"`: no ending bar and no gap; section lengths padded to a
  multiple of 4 bars.
- `lift`: added to every section's intensity, so the set can play the same
  form hotter or cooler.
- Roles to leave out of a bar. The notes are still generated, so voicing
  memory and random streams do not move, and are dropped from the result.

**Key compatibility.** Two keys are compatible when their scales share at
least six of seven pitch classes. That covers the same key, the relative
major or minor and a fifth either way, and it works for the modal keys techno
uses (phrygian, dorian), which a major/minor wheel would not.

### Built (2026-11-13, not committed)

The engine half: key compatibility, the `Piece` options, `BarSource` and the
first `SetConductor`. Written by Opus, reviewed by Fable. `bazel test //...`
passes (11 targets).

| What | Where |
| --- | --- |
| `keysCompatible` (six of seven pitch classes) | `src/theory/theory.ts` |
| `fixed`, `frame: "set"`, `lift` on `PieceOptions`; `renderBar(bar, index, leaveOut)` | `src/engine/piece.ts` |
| `BarSource`, which `Conductor` implements; `Player`'s field is typed as it | `src/engine/conductor.ts`, `src/app/player.ts` |
| `SetConductor`, `mixLeaveOut` | `src/engine/set.ts` |
| Tests | `src/engine/set.test.ts`, `golden.test.ts`, additions to `engine.test.ts` and `theory.test.ts` |

**The other apps are unchanged.** `golden.test.ts` hashes 240 bars of every
style under two seeds and three option sets, plus the whole pool and a seek.
The same test file was run against the sources at `43957bc` in a separate
worktree and passes there too, so the hashes are those of the code before
this change.

Decisions made where the plan was silent:

- `fixed` takes a `mode` as well, since compatibility is about the whole key.
  The draws it replaces still happen, so the form and material match the
  unfixed piece.
- `frame: "set"` also drops the ritardando and the transposition on later
  passes (a track stays in one key), and pads the last section so a track is
  whole 8-bar phrases.
- Mix-in is 8 bars of drums, 8 with bass added, then everything; mix-out
  mirrors it. If a bar's section has none of the stage's roles, the next
  stage is used, so an intro without drums is not silent.
- The next tempo is drawn from the style's range and clamped to within 3% of
  the last. The next key is one of the style's keys compatible with the last;
  if none is, one of its modes on a compatible tonic. Keys of area forms are
  not considered.
- Only 4/4 styles are accepted. Tracks run 180 to 360 seconds by default.

Known gaps:

- `Player` constructs `Conductor` itself in two places, so it cannot drive a
  `SetConductor` yet. The app shell needs a factory or an option.
- `skip()` cuts mid-track, so the track after a skip does not start on a
  phrase boundary of the set.
- A track shorter than 32 bars has its mix-in and mix-out overlap.
- `lift` exists but the set conductor does not use it yet.
- Tests use synthwave, disco, funk, electro swing and retro as stand-ins.

### Left in step 1

- The app shell: `src/claudia`, its page and Bazel targets (Opus).
- The `//styles:claudia` pack and the `minimal_techno` corpus (Fable).
- Letting `Player` take a `SetConductor`.

## Step 2: patches (L)

Model: Fable for the engine, the schema descriptions and the patches themselves.

Today a sound is a General MIDI program number, and the synth maps program
families to fixed `SubSpec` tables in `synth.ts`. Drum kits are a table keyed
by style id, in the synth and again in the sampler. For Claudia a sound is
data in the style.

```ts
interface Patch {
  osc: { wave: "saw" | "pulse" | "tri" | "sine" | "noise"; voices: number; detune: number; sub?: number; fm?: { ratio: number; amount: number } };
  filter: { type: "low" | "band" | "high"; cutoff: number; q: number; keytrack: number; env: number; a: number; d: number; s: number; r: number };
  amp: { a: number; d: number; s: number; r: number };
  drive?: number;
  /** Movement: tempo-synced modulation of a parameter. */
  mod?: { target: "cutoff" | "pitch" | "width" | "amp" | "pan"; shape: "sine" | "saw" | "square" | "random"; beats: number; depth: number }[];
  glide?: number;
  accent?: { cutoff: number; q: number };   // what an accent gesture does: the acid line
  level: number;
}
```

- **Synth.** `sub()` already does most of this. It takes a `Patch` instead of
  a `SubSpec`, and gains the modulators, a band-pass and high-pass mode, the
  FM operator and per-note drive. Modulation is synced to the bar clock, not
  to the note, so a filter wobble runs across notes.
- **Gestures become sound design.** Slide and accent already exist. With
  `glide` and `accent` on a patch, a bass line with slides and accents is an
  acid line. This is the cheapest route to psychedelic house.
- **Drum kits as data.** `Kit` moves from the source into the style, and
  grows: a kick with a sub tail and a separate rumble (the Berlin low end is a
  reverberated, low-passed copy of the kick, which is a patch feature, not a
  mix trick), claps, a ride, tuned percussion, noise hats with their own
  filters.
- **Sampled kits.** A style names its one-shot files. The loader, mirror and
  lock file are reused. Which drum machines the upstream sample set has beyond
  the 808, LM-2 and RZ-1 already used is to be checked; a 909 is what techno
  wants.
- **Tests.** The `Patch` schema is validated like the corpus. With no patch,
  a program number renders exactly as it does today.

The LLM writes patches along with the corpus, from schema descriptions, as it
writes motifs today. Whether generated patches are good enough or need tuning
by ear is the main unknown of this step. Start with six patches written by
hand for minimal techno (kick, rumble, hat, stab, bass, pad) before asking a
model for any.

## Step 3: parts and the arrangement grid (L)

Model: Fable for the arranger and worker changes; Sonnet for the tests once the grid's rules are fixed.

Today a style has one instrument per role and seven roles
(`ROLES` in `src/corpus/constants.ts`), each on its own MIDI channel. A
techno track is fifteen small parts, most of them percussion, that enter and
leave one at a time.

**Parts.** Roles stay, as the kinds of line the arranger knows how to write
(drums, bass, arp, lead, counter, pad, comp). A style declares any number of
parts on top of them:

```json
"parts": [
  { "id": "kick",   "role": "drums", "lanes": ["kick"],              "enters": 0.0 },
  { "id": "hats",   "role": "drums", "lanes": ["closedHat","openHat"], "enters": 0.2 },
  { "id": "perc",   "role": "drums", "lanes": ["rim","tomHigh"],     "enters": 0.45, "material": "perc" },
  { "id": "ride",   "role": "drums", "lanes": ["ride"],              "enters": 0.75 },
  { "id": "sub",    "role": "bass",  "patch": "sub",                 "enters": 0.3 },
  { "id": "acid",   "role": "arp",   "patch": "acid", "material": "acid", "enters": 0.6 },
  { "id": "stab",   "role": "comp",  "patch": "stab",                "enters": 0.5 }
]
```

- A part has its own patch and its own pool of material (a tag on motifs and
  patterns, like `palette` today).
- Drum parts split one kit into lanes, so the hats can leave while the kick
  stays, and a second percussion pattern can run over the main groove.
- `NoteEvent` carries the part id. The channel number stops mattering.
- The worker keys its windows and levellers by part. The bus keeps one chain
  per role, so parts of one role share its sends and pan and need no new
  graph nodes.
- A style with no `parts` block is one part per role, which is today's
  behaviour, bit for bit.

**The arrangement grid.** Sections still set the broad shape. Within a
section the arranger writes, per phrase, which parts are in. Rules, seeded:

- One part enters or leaves at most every 4 bars; never more than two at once
  except at a drop.
- A part's `enters` is the intensity from which it may play; the set's `lift`
  moves that line, so the same track is sparser early in a set.
- The kick and the bass leave only for a breakdown or a build.
- The last bar of a phrase may thin out (a one-bar gap in the hats) as the
  simplest kind of fill.

The grid is data on the bar (`info.parts`), so the page can draw it and tests
can assert it.

**Pattern evolution.** Techno repeats on purpose, but not exactly. Over a
section, a part's pattern may gain or lose a step, shift an accent, or rotate
by a sixteenth, at phrase boundaries. This reuses the motif development
already in `parts.ts`, applied to ostinatos and drum lanes at a slow rate.

## Step 4: moves inside a track (M)

Model: Opus.

```ts
interface Move {
  scope: { part?: string; role?: Role; deck?: 0 | 1 } | "master";
  target: "gain" | "lowCut" | "highCut" | "lows" | "reverbSend" | "delaySend" | "patch" | "stutter" | "riser" | "impact";
  param?: string;             // for "patch": which patch parameter
  from: number; to: number;   // in the target's own unit
  beats: number;              // length, from the start of the bar
  curve?: "linear" | "ease";
}
```

- **Sweeps.** A filter opening over 16 bars on one part, or a patch parameter
  (the acid line's cutoff) drifting across a section. Written by the arranger
  per section from rules, and optionally by the corpus as lanes.
- **Builds and drops.** Before a section at least 0.25 hotter than the last:
  kick out for 4 or 8 bars, a snare roll that doubles in rate (ordinary drum
  notes), a rising high-pass, a riser. The drop is the next section with
  everything in and an impact on the downbeat.
- **Risers and impacts.** Synthesised in the worker (filtered noise with a
  pitched sweep; a low thump with a noise tail) into an `fx` stem. No audio
  files.
- **Stutter and repeat.** The last beat, half beat or quarter beat of a bar is
  repeated to the barline, optionally pitched down or gated. It is arithmetic
  on a stem in the worker, so it is deterministic and testable. Used sparingly
  at phrase ends, more in big beat and electro than in techno.

Gain, filter and stutter moves run in the worker on the stems, sample by
sample. Send throws are `AudioParam` ramps on the bus. Every move ends at a
stated value, and a part that leaves is reset, so a seek can never leave a
filter half closed.

Up to here everything runs through the existing `Player`: one stream of bars,
with moves riding on the bar.

## Step 5: two decks (L)

Model: Fable throughout, including review.

**Slices.** The set conductor's unit becomes a slice: one bar of time holding
one or two bars, the moves, and which deck owns the low end.

```ts
interface Slice {
  index: number;
  bpm: number;                // one tempo for everything in the slice
  decks: { deck: 0 | 1; bar: Bar }[];
  moves: Move[];
  dominant: 0 | 1;
  info: SetInfo;
}
```

**Transitions.** The outgoing track's mix-out and the incoming track's mix-in
play in the same slices. The type is chosen from the energy step and the
styles, seeded:

| Type | When | What happens |
| --- | --- | --- |
| Blend | Similar energy | 16 or 32 bars. Incoming percussion fades in with its lows cut; at the midpoint, on a phrase, the bass swaps; outgoing parts leave one at a time. |
| Filter | Energy going up | Outgoing is high-passed away over 8 bars while incoming enters underneath; riser into the incoming track's first full section. |
| Cut | A big energy step, or swung into straight | Outgoing plays to a phrase end with a one-bar echo throw; incoming starts on the downbeat. |
| Breakdown | Energy going down, or a tempo bridge (step 6) | Outgoing drops its drums for 8 bars; an incoming pad or lead enters over it; incoming drums land on the next phrase. |

With parts (step 3), a blend is not a crossfade of two mixes. It is the two
tracks' arrangement grids interleaved: one part out, one part in, per phrase.

**In the worker.** Today `worker.ts` keeps one of everything at module level.
That becomes a `StemDeck` (one track's rendering state) used twice, and a
`SetMix` above both that owns what cannot be decided per deck:

- One kick ducks everything: the dominant deck's kick envelope ducks both
  decks.
- One low end: below about 150 Hz only the dominant deck's kick and bass
  pass. The bass swap is the dominant flag changing on a phrase, with a short
  crossfade.

The single-deck path is `StemDeck` used once with `SetMix` skipped, and must
stay bit-identical for the other two apps.

**Bus and worklet.** `Bus` is split into a `DeckStrip` (role chains, sends,
reverb and delay, set from one style's preset; one per deck) and a `Master`
(compressor, limiter, ceiling, trim, meter; one). `Bus` stays as a thin class
that builds one of each, so the other apps are untouched. The stem worklet is
created with twice the outputs.

**`SetPlayer`.** `Player` is built around one stream of bars: its timeline,
engine switching, sample prefetch and seek all assume it. Bending it to slices
would put every shipped behaviour at risk. Extract what both need and write
the scheduler new:

| Extracted from `Player` (shared) | New in `SetPlayer` |
| --- | --- |
| `AudioClock`: the smoothed `now` | Timeline of slices; "what is audible" is one or two tracks |
| `EngineHost`: context, worklet, worker, bus wiring | Dispatching slices; each strip's style set at its track's start |
| `SamplePlanner`: planning, download-rate tracking, prefetch horizon | The incoming track's samples must be in before its mix-in; if not, the transition is postponed by a phrase |
| | Position as track and bar; jumping to a track |

No engine switching mid-set: the engine is chosen before play. That removes
the most intricate part of `Player`.

## Step 6: travel (M, plus S per style)

Model: Opus for the conductor rules; Fable for the first corpus and the patches of each new
genre; Opus, Sonnet or Grok for further corpora.

A set is a walk, not a room.

- **Drift.** Tempo moves by at most 3% per transition, and by at most half a
  percent per bar inside a track, only while one deck plays. Over an hour
  that is enough to go from 122 to 134.
- **Direction.** The set plan has a slow target: a tempo and an energy to
  head for, redrawn every 30 to 45 minutes. Each next track is the style and
  tempo that move toward it within the limits. Energy rises and falls in
  waves on top.
- **Bridges.** To cross a gap drift cannot (house at 122 to big beat at 110,
  or anything to drum & bass), use a breakdown transition with no drums: the
  tempo ramps while only pads and textures play, and the incoming drums land
  at the new tempo. Half-time and double-time are the other bridge: 87 and
  174 are the same grid.
- **Style neighbours.** A style's `set` block says its tempo range and which
  transition types suit it. Two styles are neighbours if their tempo ranges
  are within drift of each other or a bridge exists.

**Styles to write**, each a corpus with parts, patches and a kit:

| Style | Tempo | What defines it | What it needs from earlier steps |
| --- | --- | --- | --- |
| Minimal techno (step 1) | 126 to 132 | Kick, hats, one stab, long filter moves | Patches, parts |
| Berlin techno | 130 to 138 | Rumble kick, ride, dark one-chord stabs, reverb | Kick rumble patch, sweeps |
| Psychedelic house | 118 to 126 | Acid line, off-beat bass, delays, long builds | Slide and accent on a patch, delay throws |
| Electro | 124 to 134 | Syncopated 808 kick, snare on 2 and 4, arpeggiated bass | Sampled or modelled 808 kit |
| Big beat | 105 to 140 | Breakbeat drums, distorted bass, stutters | Programmed breaks from one-shots, drive, stutter |

Big beat is the one that strains the scope. Its drums are traditionally
sampled breaks, which this plan excludes. Programmed break patterns from
one-shots, with drive and room, get the rhythm but not the grit of a real
break. Judge it when the others work.

**The existing styles.** Disco, electro swing, liquid drum & bass and
synthwave are 4/4 with a kick and could join later with a `set` block. They
are not in her pack at first: without parts and patches they would sound like
a different app in the middle of a set.

## Step 7: the page (M)

Model: Opus for the design; Sonnet for the wiring, tracklist and recording.

Her own design. What it shows that the other apps do not:

- Two decks, each with its track, key, tempo and the parts playing now.
- The arrangement grid scrolling: one row per part, lit while it plays.
- The set so far and ahead: energy and tempo over time, with a marker for now.
- The transition in progress: type and bars left.
- A tracklist that grows as the set plays.

The URL carries seed, position (`track.bar`) and style pool, as today.

**Export.** A tracklist (time, style, key, tempo, track seed) as text, and a
recording of the set as audio through `MediaRecorder` on the output. An
offline render is not possible while the master is a Web Audio graph.

## Tests

Composition is pure, so most of the design can be asserted without audio.

Set conductor:

- Tempo never moves more than 3% across a transition or half a percent per
  bar, and both decks of a slice share it.
- At every transition the two tracks' scales share at least six pitch classes.
- Every transition starts and ends on a phrase boundary, and the bass swap
  falls on one.
- In no slice do both decks have bass notes with their lows open.
- Same seed and pool, same slices; seeking to `track.bar` gives the same slice
  as playing to it.

Parts and grid:

- No more than two parts change in a phrase outside a drop.
- Kick and bass are absent only inside a build or a breakdown.
- A style with no `parts`, no patches and none of the new `Piece` options
  renders bars identical to today's (compared against the previous sources,
  as was done for the weighted mix).

Sound, in Node through the synth:

- A patch with modulation is periodic at its stated rate.
- With no patch, each program renders the same samples as today.
- During a blend, energy below 150 Hz stays within 1 dB of a single deck's.
- A move produces no step larger than its ramp allows, and its target is at
  the end value after it. A stutter repeats exactly the audio it names.
- The single-deck path through `StemDeck` is bit-identical to the current
  worker's output.

## Risks

- **Patches written by a model may not sound good.** Sound design is judged
  by ear, and the generation loop has no ears. Mitigation: hand-written
  patches first, a small library of named starting points the model varies,
  and the measurements from `measure.ts` as a coarse check (a kick with no
  energy below 60 Hz is wrong).
- **Parts touch the arranger's core.** Role is assumed in the part writers,
  the channel map, the worker, the leveller and the calibration. The
  "no parts means today's output" test is what keeps the other apps safe.
- **CPU.** More parts mean more voices, and a transition renders two tracks.
  The synth has headroom on a laptop; phones are unknown. Measure with
  `?perf` after step 3 and again at step 5.
- **Repetition against complexity.** Techno wants hypnotic repetition and the
  goal asks for constant change. The arrangement grid's rates decide which
  side a style falls on; they belong in the style, not in the code.
- **Blends that clash.** Compatible keys do not guarantee two tracks sound
  good together. Interleaving parts keeps leads out of the overlap; if pads
  still muddy, only one deck's pad plays at a time, like the bass.
- **`Player` extraction** at step 5 touches the two shipped apps. It needs
  the same bit-identical discipline as the last round, plus a browser check
  of both.
- **How close it gets.** With all of this, expect tracks recognisably in the
  territory of the target genres and simpler than a produced record: fewer
  layers, fewer one-off details. Kliq-like arrangement is the direction, not
  a promise.

## To verify before starting

- Whether the other session's transitions work already provides builds, drops
  or pickups in the arranger.
- Which drum-machine one-shots the upstream sample set offers (a 909 in
  particular), and their licences.
- That `sub()` can take modulation synced to the bar clock without changing
  its output when there is none.
