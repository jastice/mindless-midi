# DJ Claudia: design and implementation plan

Built so far: all of step 1, and the first of step 6's conductor rules (legs
with a target tempo, energy waves through `lift`). Step 2's engine half is
built too (patches, the synth kit, six sounds for minimal techno), and so is
step 3 (parts, the arrangement grid, pattern evolution, fifteen parts and
four more sounds for minimal techno, a light per part on the page), and so is
step 4 (moves: sweeps, drift, builds with a roll, riser and impact, stutters
and send throws). Steps 2 to 4 were first heard on 2026-11-15 (see "Heard"
under step 3). Step 5 is built (2026-11-16): tracks overlap on two decks in
four kinds of transition, with one low end and the two grids interleaved; it
has been checked in a browser and by measurement, and nobody has listened to
it yet (see "Built" under step 5). This was first written against `main` at `b4dabe6`; where it says "new", check first whether later work already has it.

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

### Built (2026-11-13, committed as `5f4ef00` and the commit after it)

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

The app shell (`src/claudia`, its page and Bazel targets), the
`//styles:claudia` pack and the `minimal_techno` corpus followed in `4ddd415`.
The app passes `(styles, seed, pieces) => new SetConductor(...)` as `Player`'s
`source`.

Gaps closed afterwards (2026-11-14):

- Skipping: the app's next-track control calls `Player.nextPieceOnPhrase`, so
  the track plays to the end of its phrase before the next one comes in.
  `SetConductor.skip()` itself still cuts, for callers that want that.
- Short tracks: the mix at each end is `mixBars(totalBars)`: 16 bars, or 8 for
  a track of under 40 bars, or none under 24, so at least one phrase plays
  whole and the ends never overlap. Minimal techno's forms are never under 112
  bars, so this only matters for other styles.
- `set.test.ts` uses `minimal_techno`; the stand-in styles stay for choosing
  between styles, which needs more than one.

Still open: `Player` has no tests and calls each track a piece.

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

### Built (2026-11-15)

Written by Fable. `bazel test //...` passes (17 targets). Nobody has listened
to it yet: the six sounds were tuned by measurement.

| What | Where |
| --- | --- |
| `Patch` and `Kit` schemas, with the descriptions a model writes from | `src/corpus/patch.ts` |
| `patches`, `synthKit` and `instrument.patch` in the corpus; their validation | `src/corpus/schema.ts`, `validate.ts` |
| The GM families and built-in kits as data | `src/sound/patches/gm.ts`, `kits.ts` |
| The voice: modulators, band and high-pass, FM, drive, stereo spread, glide, accent | `sub()` in `src/sound/synth.ts` |
| Drum models: kick sub tail, rumble, noise hats, clap, ride, tuned percussion | `drum()` in `src/sound/synth.ts` |
| The six sounds, also copied into `styles/minimal_techno/corpus.json` | `src/sound/patches/minimal_techno.ts` |
| Tests | `src/sound/baseline.test.ts`, `patch.test.ts`, `patch_library.test.ts`, `src/corpus/validate.test.ts` |

How a patch reaches a voice: the piece's program change carries the
instrument's patch name; `barScore` puts `patch`, `beat` (seconds per beat)
and `pos` (beats from the start of the track) on each note of that channel;
the `Player` sends the style's `SoundSet` with every bar; the synth looks the
name up. A modulator's phase is `pos` plus the time into the note, so it runs
on across notes and follows a drifting tempo.

**The other apps are unchanged.** `baseline.test.ts` hashes the samples of all
128 programs and every built-in kit; the hashes were taken before the change.

Decisions and gaps:

- The corpus field is `synthKit`; `kit` on the bundle is the sampled kit.
  Under the Samples engine, notes with a patch are played by the synth and
  the drums stay sampled.
- Modulator targets are `cutoff`, `pitch`, `pw`, `amp`, `pan` and `width`
  (stereo spread), each with one meaning; `patches` is a list with ids, not a
  map, to suit structured output.
- With `glide`, a slide starts from the previous note's pitch; the envelopes
  still retrigger (no tied 303 slide). An accent adds filter depth and
  resonance; it does not shorten the decay.
- A swell on a patched note is cut 2.5 s after the note ends (`renderShaped`).
- The patch schema has not been through the generator's structured output.

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

### Built (2026-11-15)

Written by Fable. `bazel test //...` passes (19 targets). Nobody has listened
to it: the grid was judged by reading it, the sounds and the mix by
measurement.

| What | Where |
| --- | --- |
| `parts`, `arrangement` and the `material` tag in the corpus; their validation | `src/corpus/schema.ts`, `validate.ts` |
| The arrangement grid, `mixBars` | `src/engine/grid.ts` |
| Parts in the arranger: material per part, `renderPart`, evolution, `info.parts` / `thin` / `turn` | `src/engine/piece.ts`, `parts.ts` (`evolveMotif`, `evolveLanes`), `types.ts` |
| Part and patch on the note | `src/sound/score.ts`, `types.ts` |
| Windows, previous notes and levellers by part, summed by role | `src/sound/worker.ts`, `protocol.ts` (`partLevels`) |
| Fifteen parts, rates, tagged material, and the acid, bleep, chord and air patches | `styles/minimal_techno/corpus.json`, `src/sound/patches/minimal_techno.ts` |
| A light per part | `src/claudia/app.ts` |
| Tests | `src/engine/grid.test.ts`, `src/sound/worker.test.ts`, additions to `validate.test.ts`, `patch_library.test.ts`, `set.test.ts` |

**How part and patch reach the worker.** The piece's setup has, after the
program change per channel, one more program change per part that names the
part (and its patch, its own or its role instrument's). `barScore` keeps the
patch per part beside the patch per channel; a note carries `part` and plays
its part's patch. The worker keys its window and the previous note by part.
In the weighted mix every part has its own `BodyLeveler`, except that a kit's
parts share the kit's, the way the kick and the rest of the kit already did:
a kit's balance is the kit's. Parts are then summed by role, so the mix, the
worklet and the bus see one stem per role, as before. A part's level is its
`volume` (sent as `partLevels`), else its role's.

**How the grid sits with what was there.** Sections still say which roles
play and how intense; the grid decides which parts, every 4 bars. It is
planned once per piece from its own stream (`grid`), so a seek cannot move it.

- A part may enter where the section has its role and is at least as intense
  as its `enters`. `lift` is already in the section's intensity, so nothing
  more is needed for a cooler track to be sparser (measured over 24 seeds:
  3.8 parts in on average at lift -0.3, 6.0 at 0, 6.8 at +0.3).
- The low end is the part with the kick lane and the first bass part. They
  ignore `enters`: they play wherever the section has both drums and bass. A
  section without one of those roles is a breakdown, and there the kick is
  out. Builds (kick out before a hotter section) are left to step 4.
- A slot changes one part, or swaps one for another; a phrase changes at most
  two. The exception is a turn, the first bar of a section where the low end
  leaves or returns or which is 0.25 hotter or cooler than the last: at a
  "drop" what may play comes in, at a "break" what may not goes. A part the
  next section will not allow leaves ahead of the boundary, one a slot.
- Mix-in and mix-out: for a style with parts the grid does them, and
  `mixLeaveOut` leaves nothing out. A track starts on the kick alone and adds
  one part every 4 bars, the bass at bar 8; from 16 bars before the end one
  part more may play per remaining slot, the bass leaves 8 bars out, and the
  track ends on the kick and at most one more. Styles without parts mix by
  role as before.
- The last bar of a phrase rests one drum part other than the kick, at the
  style's `thin` rate.
- Rates are the style's `arrangement`: `change`, `swap`, `drop`, `thin`,
  `evolve`.

**Evolution.** At each phrase boundary inside a section a part's pattern
takes one step at the `evolve` rate: a note more, a note less, an accent
moved, or a turn by a sixteenth (the kick and the bass only move an accent).
A new section starts from the pattern as written. Each boundary has its own
stream and the steps so far are replayed, so a bar is the same however it is
reached. It sits beside `develop` in `parts.ts` and shares its cell; it does
not reuse its operations, which are melodic.

**The other apps are unchanged.** `golden.test.ts` and `baseline.test.ts`
pass as they were. `worker.test.ts` is new: it drives `worker.ts` itself as
the player does and hashes the stems it posts, for every shipped style
(synth, plain and weighted) and three through the samples path. It was
committed first, from the code at `500d40c` (`44900ff`), and passes unchanged
after. Minimal techno was pinned in none of the three. Without a `parts`
block the new code is skipped, not run with neutral values: the grid's and
the parts' streams are forks that are never made.

Measured (in the tests' output):

- Render time through the worker at 24 kHz, a whole track: 90 ms per bar with
  parts against 98 ms for the same style without them (a bar is 1.9 s); at
  lift 0.3, with 7 parts in on average and 12 at most, 106 ms against 107 ms.
  Parts cost no more than the style did before: the new parts are small and
  the pad's five saws dominate either way. Not measured at 48 kHz or on a
  phone, and not with `?perf` in a browser.
- The mix of a whole track: within 1 dB of the style without parts (-26.7 dB
  against -27.5 dB RMS), low end mono, each role's loudest bar within 2.5 dB
  of what it was.
- Acid: 95% of its energy from 100 Hz to 4 kHz, 3.5% under 60 Hz, filter from
  1490 Hz to 919 Hz within a sixteenth, an accent 1.8 times brighter, the
  12-bar sweep 2.5 times. Bleep: 0.1 s, all of it from 400 Hz to 6 kHz, lands
  up to 11 dB left or right from beat to beat. Chord: rings 0.66 s against the
  stab's 0.2 s, nothing under 150 Hz, correlation 0.48. Air: nothing under
  400 Hz, 28 dB down in its first 200 ms, sweeps from 5.8 kHz to 1.8 kHz,
  wanders 9 dB either way.

Decisions and gaps:

- `material` tags a motif, comping pattern or drum pattern for the one part
  that names it; untagged material is for untagged parts. A drum part reads
  its lanes from the groove nearest the section's intensity that has
  something on them, so two drum parts may read different grooves. A lane no
  part claims is not played.
- A part may also set `octave` and `volume`. It has no program or pan of its
  own: the bus has one chain per role.
- A part whose patch has `glide` or `accent` takes gestures like a line, so
  the acid part (an arp) gets the slides and accents its motifs write.
- A drop brings in `arrangement.drop` of what may play (0.7 for minimal
  techno); the plan said everything.
- The page shows a light per part, lit from `info.parts`. Checked once in a
  browser from the worktree: it plays, no console errors.
- The worker keeps a window per part, about 7 MB each at 48 kHz: fifteen
  parts are about 110 MB where five roles were 40 MB. Untested on a phone.
- The FM path and a `.mid` play all parts of a role on its channel with the
  role's program; gesture bends of two parts on one channel would collide
  there. Claudia uses neither.
- Under the plain (not weighted) mix a kit's parts are summed and levelled as
  one and the other parts each have a `RoleLeveler`. It runs but only the
  weighted mix has a test with parts.
- A style whose track opens without drums and bass starts on its coolest
  part, and a section with drums and no bass counts as a breakdown. Fine for
  minimal techno's forms; other genres may want this said in the corpus.
- The parts schema has not been through the generator's structured output.

### Heard (2026-11-15), and the limits that followed

Steps 2 to 4 were listened to in the browser, Synth engine. Verdict: groovy,
more variety of sound, and the build into a drop is fat (for one,
`?seed=jaunty-coda-capriccio&at=43.57`). The complaint: too many conflicting
noises where many parts were in (`at=42.115` had nine parts, twelve just after
the drop, several of them noise or unpitched).

What changed (`56b41ca`, `712d995`), in `src/engine/grid.ts` and the schema:

- A part may name a `group`; `arrangement.groups` says how many parts of a
  group play at once, and `arrangement.most` how many parts in all. They gate
  entries: at a drop, in the mix-in and for a change by choice. A style with
  neither runs none of it.
- At a drop with limits, what was playing has first claim on the room, then
  the coolest parts, so the hat is not what gets left out.
- Minimal techno: `most` 10; `line` 3 (acid, bleep, stab, chord); `perc` 2
  (blip, rim, clap); `noise` 2 (open hat, ride, shaker, air). A first try at
  8 / 2 / 2 / 1 was judged too thin. Parts in on average at neutral lift:
  5.3, against 6.0 with no limits.
- The same seed gives a different arrangement than before the limits.

Judged good by ear after that. Then the blip and the low tom were tuned: a
kit's `perc` sound with `tuned` is written for a track on A and moves by the
nearest way to the track's tonic (drum notes of a style with parts carry
`tonic`). Not heard yet. Still untouched, and the next suspects if a mix is
harsh: the blip's inharmonic FM (ratio 1.48) and the acid line's resonance.

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

### Built (2026-11-15)

Written by Opus. `bazel test //...` passes (21 targets). Nobody has listened
to it: the riser, the impact, the cuts and the build were tuned by
measurement only.

| What | Where |
| --- | --- |
| `Move`, `bar.moves`, `info.build`, `OPEN_LOW` / `OPEN_HIGH` | `src/engine/types.ts` |
| `moves` rates and `roll` on a part in the corpus; their validation | `src/corpus/schema.ts`, `validate.ts` |
| Builds in the grid (`GridBuilds`, `grid.build`) | `src/engine/grid.ts` |
| `MovePlan` (sweeps, drift, builds, stutters, throws), `moveValue` | `src/engine/moves.ts`, wired in `piece.ts` |
| The roll (`writeRoll`) | `src/engine/parts.ts` |
| `MoveRunner` (cuts, lows, gain, stutter, riser), `impact`, `stemMoves` | `src/sound/moves.ts` |
| Moves through the worker; the `moves` field of a bar message | `src/sound/worker.ts`, `protocol.ts` |
| Send throws (`Bus.throws`, `clearThrows`) | `src/sound/bus.ts`, called from `src/app/player.ts` |
| A roll part and rates for minimal techno | `styles/minimal_techno/corpus.json` |
| "Build, 4 bars (2 to go)" and "Drop" beside the section | `src/claudia/app.ts` |
| Tests | `src/engine/moves.test.ts`, `src/sound/moves.test.ts`, additions to `grid.test.ts`, `worker.test.ts`, `validate.test.ts` |

**How moves travel.** The piece plans them once (`MovePlan`, from the grid and
the style's `moves` rates, on a stream `moves` of its own) and puts each bar's
slice on `bar.moves`. `Player` hands the send throws to the bus (`AudioParam`
ramps at the bar's time) and sends the rest to the worker as `moves` on the
bar message (`stemMoves`: the bar's length in beats and the list). A bar with
no moves sends nothing, and the worker skips every line of the new code: the
runner, the fx windows and the patched sound are made only when a bar has
moves.

**Seek safety.** A move over several bars is cut into one per bar, each with
its own `from`, `to` and `span` (bar k of n), all computed from the plan and
the bar's index, so a bar reached by a seek has the moves playing to it gives
(tested through `SetConductor`). The worker keeps a filter's state only while
consecutive bars move the same target on the same stem, so a sweep is smooth
across barlines; a target not moved this bar loses its state, a seek clears
everything, and a filter with no state fades in from the dry sound over 4 ms.
Rendered alone, a sweep's bar matches the bar rendered after its predecessors
to 1e-5 after its first 50 ms. A cut at its open end is the dry signal
exactly (it fades to dry over the top or bottom octave), so a sweep that ends
open hands over to no filter without a step. The bus restores a thrown send
the bar after, or on a seek (`Player.cut` calls `clearThrows`).

**Where the fx go.** Risers and impacts are synthesised in the worker into
windows of their own and added to a role's stem after levelling and the
weighted mix, so no leveller flattens a riser and the kick never ducks it.
The riser joins the pad's chain (wide, chorus, the most reverb); the impact
the drums' (no high-pass, little reverb). No new graph nodes and no new
worklet outputs: the alternative, a seventh "fx" output and chain, would have
touched the bus and worklet the other apps use.

**How the build changes the grid.** For a style with `moves`, every section
the grid would mark as a drop draws a build (at the `build` rate, 4 or 8 bars
at the `long` share) inside the section before it, outside the mix-in and
mix-out. On its first bar the kick leaves and the roll part enters (free, like
a turn); nothing else moves by choice until the drop, which brings the kick
back and sends the roll out with the rest of the turn. The roll part is never
otherwise eligible, never rests and is never the "never silent" fallback.
The grid test now reads "absent only in a breakdown or a build".

Decisions made where the plan was silent:

- `Move` gains `at` (start beat, default 0; before it the target holds `from`,
  after it `to`) and `span`. Units: gain a factor, cuts Hz, `lows` dB of a low
  shelf at 150 Hz, sends 0..1 absolute, `patch` the parameter's own unit
  (cutoff, q, env, drive), stutter `from` the slice in beats and `to` the last
  repeat's pitch in semitones (`param: "gate"` halves each repeat), riser and
  impact Hz. Targets in Hz move in octaves. `deck` is in the type and read by
  nothing.
- Cuts are 24 dB an octave (two Butterworth SVF stages): a 12 dB build
  high-pass took only 6 dB out below 150 Hz by the build's last bar.
- A part's moves run after its levelling (in the weighted mix; in the plain
  mix before it), a role's and everything's on the role stems, then the fx.
  Order on a stem: stutter, lows, cuts, gain.
- Sweeps start on a part as it enters (from silence, so the filter has
  nothing to cut yet) and only where it then plays through 8 or 16 bars; drums
  and lines open a high-cut from 300 Hz, pads and comps half the time a
  low-cut from 1.5 kHz. Drift is an arc away and back in a section (0.6 to 1.3
  octaves, mostly up), on the acid line first, never on a part swept in that
  section. Neither touches the kick, the bass or the roll.
- A build is a master low-cut from open to 600 Hz (8 bars: 1 kHz) and a riser
  from 200 Hz to 6 kHz across it, the roll doubling every quarter of it
  (quarters, eighths, sixteenths, thirty-seconds, rising in level); an impact
  on the drop's downbeat falling from 90 to 38 Hz. The bass stays in a build.
- Stutters are on everything, the last beat or half beat, a half or quarter of
  it repeated; a quarter of them pitched down an octave, a third gated. Throws
  are a delay throw on the comp or arp for the last beat before a break.
- The snare lane moved from the clap part to the roll (only the `lift_roll`
  fill used it), so minimal techno's clap no longer plays that fill's snare.
  Minimal techno was pinned nowhere, so no hash changed.
- Minimal techno's rates: sweep 0.4, drift 0.35, build 1, long 0.5, stutter
  0.05, throw 0.25. Over 24 tracks: 33 sweeps, 29 drifts, 18 stutters at 426
  phrase ends, 9 throws; 90 builds over 72 tracks at three lifts.

Measured (in the tests' output, 24 kHz):

- Riser over 4 bars: from -61 to -31 dB a beat (a stem at full level is
  -26 dB), the share above 1.5 kHz from 1% to 96%, silent at its last sample.
- Impact: 82% of its first 300 ms below 120 Hz, peak -12.8 dBFS, then a tail
  at -50 dB from 0.8 to 1.8 s with 58% above 300 Hz; silent after 2.6 s.
- A 4-bar build through the worker: below 150 Hz, against the same bars
  without the high-pass, -0.4, -0.5, -1.1, -12.8 dB per bar; the riser in the
  pad's stem -56, -44, -38, -30 dB; on the drop the drums' first 300 ms at
  -17 dB (82% below 120 Hz) against -32 dB on the build's last downbeat.
- A high-cut opening from 300 Hz over 4 bars on noise: the share above 2 kHz
  per beat goes from 0 to 0.75, never falling.
- The whole-track mix and per-role levels of the step 3 test still hold
  (the pad's loudest bar is now measured outside builds, where the riser is).

Known gaps:

- Nobody has listened. The riser's level, the impact's and the high-pass's
  shape are guesses checked by numbers.
- Send throws run on the `AudioParam`s and are not tested (`Player` and `Bus`
  have no tests in Node); the restore is by setTarget, so a throw's own echoes
  ring on, as they should.
- The FM bus path ignores moves; Claudia does not use it.
- The worker's levellers remember earlier bars, so the worker test cannot
  compare two runs by hash; determinism is asserted on the bars and the
  runner instead.
- The corpus cannot write moves as lanes yet (the plan's "optionally by the
  corpus"); everything comes from rules.
- The `moves` schema has not been through the generator's structured output.
- Not checked in a browser.

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

### Built (2026-11-16)

Written by Opus, from a first draft of the set conductor that Fable left
unfinished. `bazel test //...` passes (23 targets). Nobody has listened to it:
the transitions were tuned by measurement and checked in a browser by their
levels per deck, not by ear.

| What | Where |
| --- | --- |
| `Slice`, `Transition`, `nextSlice`, `interleave`, `overlapMoves`, `breakdownParts`, `trackPiece` | `src/engine/set.ts` |
| `TransitionInfo`, `bar.deck`, `bar.with`, `bar.transition`; a deck-only `Move` scope covers the deck | `src/engine/types.ts`, `moves.ts` |
| `extra` parts on `renderBar` (a breakdown's pad) | `src/engine/piece.ts` |
| `StemDeck` (all the worker's old module state), `SetMix` (two decks, tails) | `src/sound/worker.ts` |
| `DeckBar`, `deck` and `with` on a bar message | `src/sound/protocol.ts` |
| `DeckStrip` per deck and one master in `Bus` | `src/sound/bus.ts` |
| The `decks` option: twice the worklet outputs, two strips, `bar.with` sent beside the bar | `src/app/player.ts` |
| Both decks and the transition on the page | `src/claudia/app.ts`, `index.html`, `styles.css` |
| Tests | `src/engine/set.test.ts`, `src/sound/decks.test.ts` (new), changes to `grid.test.ts`, `moves.test.ts`, `berlin_techno.test.ts` |

**Transitions.** Tracks alternate decks (track `i` on deck `i % 2`). How a
track hands over is drawn once per pair, on a stream of its own
(`seed/mix/i`), from the step in `lift`: under 0.08 mostly a blend; going up
mostly a filter, going down mostly a breakdown; 0.22 or more mostly a cut.
Successive lifts differ by 0.12 at the median (the energy wave moves a lot in
a track), so those thresholds sit near the 30th and 93rd percentiles. Over 6
sets of 5000 bars: 101 blends, 61 breakdowns, 55 filters, 28 cuts.

| Type | Overlap | Swap | What happens |
| --- | --- | --- | --- |
| Blend | 16 bars (both mixes) | bar 8 | The incoming plays its mix-in, lows cut below 180 Hz and faded in from 0.4 over 4 bars; the low end changes hands over the last half beat before the swap; then the outgoing's cut rises to 450 Hz and it fades to 0.3 over its last 4 bars |
| Breakdown | 16 bars | bar 8 | A blend whose second phrase has no kick and no bass on either deck; up to two pitched parts of the incoming (a pad first) play over it; the incoming's low end lands after it on an impact |
| Filter | 8 bars | bar 0 | The incoming has the low end from the start; the outgoing is high-passed from 180 Hz to 4 kHz and fades over its last 2 bars; a riser on the incoming lands on an impact |
| Cut | none | | The outgoing stops a phrase short of its mix-out with a delay throw on its last beat; the incoming starts past its mix-in, on an impact |

Styles without parts (or tracks too short to mix) cut at the track's end, as
before, and their bars name no deck.

**Interleaving.** In an overlap the dominant deck (the one with the low end)
plays what its grid says; the other plays drums only, so there are never two
basses, pads or lines. Of its drums its kick always plays (its lows cut), and
the rest only while the sum of both decks stays within `most` and each group's
limit, the lower of the two styles' where both name one. At most 7 parts
across both decks were seen in 6 sets. The pitched parts change hands with the
low end at the swap, and each grid keeps adding or taking out one part a slot,
so a blend hands over part by part.

**Tempo.** One per slice. Across an overlap it moves from the outgoing
track's to the incoming's in equal steps a bar (rounded to 0.01 bpm), and both
decks play at it; before a cut it ramps over the 8 bars before the cut. Tracks
are within 3% of each other, so a step is at most about 0.2% a bar (a filter's
8 bars: 0.33%). Outside transitions a track plays at its own tempo.

**Position.** `track.bar` of the dominant deck, so a link in the second half
of a blend names the incoming track. Seeking to a bar inside an overlap lands
in the transition with both decks playing; `skip` in a transition goes on with
the incoming alone. The page's next-track control seeks to the next track's
first bar, which is inside its overlap with this one: it jumps to this track's
mix-out and mixes from there, on the phrase.

**The worker.** Everything the worker kept at module level is one `StemDeck`.
A bar message without `deck` (Mindless Midi, Mighty Midi, any non-set bar) is
rendered by one solo deck exactly as before. A message with `deck` goes to a
`SetMix` of two decks: each renders its bar into its own stems, posted as
outputs `deck * 7 + role`; `with` carries the other deck's bar. A deck that
stops rings out over one more bar, with its transition's filters held and its
level falling to nothing over the first beat, and is then dropped.

**The bus and the player.** `Bus` is a `DeckStrip` (role chains, sends,
reverb, delay, set from one style) per deck and one master (tape chain,
compressor, limiter, trim, meter). Without the `decks` option it builds one
strip and every method is deck 0's. With it (only Claudia passes it) the
worklet has 14 outputs and each strip is set from its own track's style at
its first bar, so minimal techno's preset and Berlin techno's (the default
one) sound side by side in a transition between them. Throws go to their
deck's strip, and a strip with no bar is restored, so a cut's echo throw
does not stick. The other deck's notes are scored from its own programs and
patches, and under Samples planned from its own style's kit.

**The other apps are unchanged.** The worker test's runs (all shipped styles,
plain and weighted, synth and samples, and the minimal techno runs) print a
bit-exact hash with `PRINT_EXACT`; all 56 were the same before and after the
`StemDeck` change. The bus split builds the same nodes in the same graph for
one deck; that was checked in a browser only (no Web Audio in the tests).

Decisions and deviations from the plan above:

- **No `SetPlayer`, no extraction from `Player`.** A slice is one bar of time
  at one tempo, which is already `Player`'s unit, so the conductor's
  `nextBar` returns the dominant deck's bar with the other's on `with`, and
  `Player` sends both. Everything new in `Player` runs only for a bar that
  names a deck. Rewriting the scheduler would have put the other two apps at
  risk for no audible gain. Engine switching mid-set still works, as before.
- **No separate low-end stage.** The low end is the conductor's moves on each
  deck (a 24 dB/octave low cut at 180 Hz on the deck without it, opened over
  half a beat at the swap), so it is pure data, seek-safe and tested in the
  engine. The kick's ducking needs nothing shared either: the deck without
  the low end plays drums only, which the weighted mix never ducks.
- Blends are 16 bars, not 16 or 32: the mix-in and mix-out are 16.
- The incoming track's samples are not awaited before its mix-in; a bar that
  is not ready leaves a gap, as before.

Measured:

- Through the worker (`decks.test.ts`, 24 kHz), the first transition of each
  type in sets over both styles: the deck without the low end adds between
  -0.1 and +0.06 dB below 150 Hz to the dominant deck's in any bar of a blend
  or a filter; across the blend's swap the low end moves at most 1.5 dB from
  beat to beat (0.6 dB in the bars before), the filter's 0.8; the stems' peak
  in a transition is at most 0.3 (the impact where it lands; 0.26 before it).
  A breakdown's second phrase is 20 to 40 dB down below 150 Hz, on purpose.
- In the browser (Chromium, 48 kHz), output level per transition: a blend
  about -25 dB throughout; a filter -25; a cut -22 to -26; a breakdown -25,
  then -35 to -47 dB over its second phrase (a stab and a hat), then back.
- Render time per bar through the worker in Node, over 700 bars of one set:
  at 48 kHz, 78 ms with one deck (95th percentile 272, worst 520) and 80 ms
  with two (95th 96, worst 99); at 24 kHz 39 and 41. A bar is about 1.85 s.
  The second deck costs little because it plays drums only and both ends are
  thin; the worst bars were all single-deck bars.
- Memory: the Node process peaked at 374 MB at 48 kHz (264 at 24 kHz), with
  both decks' windows (about 7 MB a part at 48 kHz). The page's main thread
  heap stayed at 11 to 12 MB through a blend; the worker's own memory cannot
  be read from the page. Not measured on a phone.

Known gaps:

- Nobody has listened. The cut frequencies, the fades, the breakdown's level
  and the swap's half beat are guesses checked by numbers.
- A breakdown's pad comes in for its second phrase and may leave again where
  the incoming grid has no pad after it lands.
- Berlin techno still has the default bus preset and weight.
- The delay time of a strip is set at its track's first bar and does not
  follow a tempo ramp (at most 3% off by the end of an overlap).
- `Player` and `Bus` still have no tests in Node; the bus split and the
  player's two-deck path were checked in a browser only.
- Step 7's page (timeline, the grid scrolling) is not started; the page shows
  the two decks and the transition only.

Example links, a few bars before each type (both styles, the default pool):

- Blend, minimal into Berlin: `?seed=decks-0&at=1.157`
- Breakdown, Berlin into minimal: `?seed=decks-0&at=2.157`
- Filter, minimal into Berlin: `?seed=decks-0&at=3.101`
- Cut, minimal into Berlin: `?seed=decks-0&at=5.101`
- Filter, Berlin into minimal: `?seed=decks-1&at=1.133`
- Blend, Berlin into minimal: `?seed=decks-0&at=4.141`

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

**Built (2026-11-14), in `src/engine/set.ts`:**

- Legs of 30 to 45 minutes, each with a target tempo drawn as a share of the
  pool's whole tempo span. The first track is anywhere in its style; each next
  one takes the style that gets nearest the target in one 3% step (weighted,
  not certain) and the tempo nearest it, within a beat and a half.
- Energy: `lift` is the leg's offset (up to 0.15 either way), plus a sine wave
  of 0.12 with a period of 10 to 20 minutes, minus a warm-up of 0.15 easing to
  nothing over the first 15 minutes; clamped to 0.3. It is the track's `lift`
  for `Piece`.
- Set time is nominal: the tracks' lengths end to end, so skips do not move
  the plan and a link still lands on the same track.
- `trackPlan(i)` gives each started track's style, tempo, lift, target, start
  and length, for the page and tests.

Not yet: drift inside a track (tempo is per track), style neighbours and
bridges (one style so far), and a smooth step in energy where legs meet.

**Styles to write**, each a corpus with parts, patches and a kit:

| Style | Tempo | What defines it | What it needs from earlier steps |
| --- | --- | --- | --- |
| Minimal techno (step 1) | 126 to 132 | Kick, hats, one stab, long filter moves | Patches, parts |
| Berlin techno | 130 to 138 | Rumble kick, ride, dark one-chord stabs, reverb | Kick rumble patch, sweeps |
| Psychedelic house | 118 to 126 | Acid line, off-beat bass, delays, long builds | Slide and accent on a patch, delay throws |
| Electro | 124 to 134 | Syncopated 808 kick, snare on 2 and 4, arpeggiated bass | Sampled or modelled 808 kit |
| Big beat | 105 to 140 | Breakbeat drums, distorted bass, stutters | Programmed breaks from one-shots, drive, stutter |

**Berlin techno, built (2026-11-16)**, by hand, in `styles/berlin_techno`
and in the `//styles:claudia` pack. Nobody has listened: the sounds were
tuned by measurement (`src/sound/berlin_techno.test.ts`).

- 14 keys, aeolian and phrygian; each of minimal techno's keys has a
  compatible one. One chord held for 7 or 8 bars, so a held note is not cut
  at each barline. Six forms of 128 to 176 bars: a breakdown without the
  kick, a build, a peak without the pad role.
- 14 parts: kick, hat, open hat, ride (from 0.8), clap, tick, tuned toms,
  roll, sub, stab, tone, bell (loops of 3 and 5 bars), drone, wash. `most` 8;
  `line` 2, `perc` 2, `noise` 2 (open hat, ride, wash).
- The rumble is short and loud (0.6 s, level 0.75, in after 0.2 s): 6 dB
  fuller before the next kick than minimal techno's, as far under the punch.
  The sub is a plain triangle in the octave above it.
- The mix preset and weight are keyed by style id in `src/sound/bus.ts` and
  `weight.ts`, which step 5 is rebuilding, so this style has none yet and
  plays with the defaults: no delay, reverb on the pad only. The stab's tail
  is its own release. A preset is the first thing to add once step 5 lands.
- With two styles the set alternates them at every track (`choose` leaves
  out the style just played), so Berlin techno plays at 130 to 135 after
  minimal techno and reaches 136 and up only as a first track.

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
  **Checked 2026-11-13: there is no 909.** `danigb/samples` has ten machines:
  808-mini, Casio-RZ1, Casio-SK1, LM-2, MFB-512, Micro-Rhythmer-12,
  Roland-CR-8000, Sequential-Circuits-Drumtraks, TR-808 and Yamaha-MR10. So
  techno's kit is either the 808 and CR-8000 from here, a modelled 909 in the
  synth (step 2's drum models), or a second sample source. Its README calls
  the set "permissive licensed" and points to each folder for the licence;
  the folders hold only a `dm.json`, which was not read. Licences are still
  open.
  **Update 2026-11-14:** a 909 exists in a sibling repo, `danigb/sampled`
  (`DM/TR-909/Detroit` and `/SP`, wav), which claims public domain or similar
  licences; accepted for this project. See
  [sample sources](knowledge/build/sample-sources.md).
- That `sub()` can take modulation synced to the bar clock without changing
  its output when there is none.
  **Read 2026-11-13, not tried.** A voice gets the note's onset in seconds
  (`ScoreNote.t`) and no tempo, so a tempo-synced modulator needs the beat
  length or the modulator's period in seconds passed in with the note or the
  patch. The vibrato already takes its phase from `n.t`, so phase running
  across notes has a precedent. Whether the per-sample loop stays
  bit-identical with the modulators guarded off is for step 2's comparison
  test to show.
