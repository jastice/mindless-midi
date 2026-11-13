# DJ set generator: design and implementation plan

Nothing here is built. This is written against `main` at `b4dabe6`; the
transitions and backlog work done in another session is not in that checkout,
so where this plan says "new", check first whether that work already has it.

Sizes are rough: S is a day or two, M about a week, L several weeks.

## What we are building

A third app that plays one continuous, seeded, generated DJ set: tracks that
blend into each other on the beat, at a steady tempo, in keys that fit, with
builds and drops, and an energy arc across the whole set.

It keeps what makes this project what it is: every note is arranged in the tab
from a seed, nothing is streamed, a link reproduces the set, and styles are
small corpora an LLM can write.

It gives up one thing on purpose: **the MIDI file is no longer the piece.** Two
tracks overlapping, filter sweeps and risers cannot be written to a `.mid` that
another player would reproduce. Notes stay the internal language; MIDI stops
being a requirement. Mindless Midi and Mighty Midi keep that promise and are
not changed by any of this.

### Terms

- **Track**: one piece (one style, one key, one form), as today.
- **Deck**: a slot that plays one track. There are two, so two tracks can sound
  at once.
- **Transition**: the stretch where the outgoing and incoming track overlap.
- **Phrase**: 8 bars of 4/4. Everything a DJ does starts on a phrase boundary.
- **Move**: a change to the mix over time (open a filter, fade a deck, swap the
  bass). Not a note.
- **Room**: a tempo band a set stays in, with the styles that fit it.

### Goals

1. No gaps and no final chords between tracks; the kick never stops unless a
   breakdown says so.
2. Tempo changes by at most a few percent per transition. Both decks share one
   tempo while they overlap.
3. Consecutive tracks are in compatible keys.
4. Never two bass lines or two kicks at full weight at once.
5. Builds and drops inside tracks, and a planned energy curve across the set.
6. Same seed, same pool, same set. A link lands on the same track and bar.

### Non-goals

- Mixing real recordings, beat detection, or anything that needs audio in.
- A `.mid` of the set.
- The plain FM engine. `fm_bus` could work later; it is not in the first cut.
- Odd meters. A set is 4/4.

## What can be reused, and what cannot

| Area | Reuse | Change needed | New |
| --- | --- | --- | --- |
| Theory, RNG, seeds (`src/theory`) | As is | A key-compatibility function | |
| Corpora and schema (`src/corpus`, `styles/`) | As is | Optional `set` block per style (below) | House and techno corpora |
| `Piece` (`src/engine/piece.ts`) | Planning, sections, all part writers, gestures | Options to fix tempo and tonic, to bias intensity, and to return a bar with some roles left out | |
| `Conductor` | Not reused: it picks each piece independently and plays it to its ending and gap | Extract a small `BarSource` interface that it and the new conductor both satisfy | `SetConductor` |
| Synth, sampler, curves, touch (`src/sound`) | As is | | Custom patches (later), synthesised risers and impacts |
| `BodyLeveler`, `WeightedMix` | The DSP | Run once per deck; ducking and the low end must be decided across decks | `SetMix`, the stage above two decks |
| Render worker | Rendering and levelling code | All its state is global and per role; it moves into a per-deck object | Move automation |
| Stem worklet | As is | Created with twice the outputs | |
| `Bus` | Role chains, sends, reverb, delay | Split into a per-deck strip and one shared master | |
| `Player` (`src/app/player.ts`) | Audio clock, engine boot, sample prefetch, download-rate logic | Those parts are extracted so two players can share them | `SetPlayer` scheduling |
| Pages | Fonts, the serve tool, the Bazel site pattern, the media-key anchor | | A page with two decks, a set timeline, a tracklist |
| `barsToMidi`, FM worklet, `Leveler` | Not used | | |

The honest summary: composition is almost entirely reused, the sound engines
are reused, and the three pieces that assume "one piece at a time" (conductor,
worker state, player scheduling) are where the new work is.

## Which styles can be in a set

A style qualifies if it is in 4/4, has a kick, and its sections are whole
numbers of 4 bars or can be padded to them. From the current corpora:

| Room | Tempo | Styles that fit today |
| --- | --- | --- |
| Downtempo | 84 to 100 | lofi (70 to 88, stretched up), metroid, synthwave (96 to 108), funk (96 to 112) |
| House | 116 to 128 | disco (116 to 126), electro swing (118 to 128), jrpg, retro, monkey island, low log, castlevania at its low end |
| Drum & bass | 170 to 176 | liquid_dnb only |

Excluded by meter or by having no kick: celtic (2/4), musette (3/4), midnight
platform (5/4), orbital glass (7/4), courtyard nine (9/8), baroque, minimalist.
Swing is a problem when two decks overlap: lofi (0.55), electro swing (0.62)
and jazz trio (0.75) should only blend with themselves, or cut in on a phrase
instead of blending.

The house room is thin on actual club music and the drum & bass room has one
style. New corpora (house, techno, a second drum & bass style) are part of the
plan, and they are the cheap part.

## Design

### 1. `SetConductor` (new, `src/engine/set.ts`)

A pure, deterministic generator, like `Conductor`, but its unit is a **slice**:
one bar's worth of time holding one or two bars and the moves that apply.

```ts
interface Slice {
  index: number;              // bar counter since the set started
  bpm: number;                // one tempo for everything in the slice
  decks: DeckBar[];           // one, or two during a transition
  moves: Move[];              // mix changes that start in this slice
  info: SetInfo;              // track number, transition state, set energy
}
interface DeckBar { deck: 0 | 1; bar: Bar; }
```

**Planning a set.** From the seed, up front and cheaply:

- A room, from the selected styles (or chosen by the listener).
- An energy curve over the set: warm up, climb, peak, breathe, peak, cool
  down. For an endless set the curve repeats in waves of about 45 minutes.
- For each track in turn: a style from the room (not the one before), a tempo
  within 3% of the previous track's, and a key compatible with the previous
  track's.

**Key compatibility.** Two keys are compatible when their scales share at
least six of seven pitch classes. That covers the same key, the relative major
or minor, and a fifth up or down, and it works for the modal keys the corpora
use (dorian, phrygian), which a major/minor wheel would not. The piece's tonic
is then chosen from the style's own candidate keys where one fits, else the
style's first key transposed to the nearest compatible tonic.

**Shaping a track for a set.** `Piece` gets three options, all off by default:

- `fixed: { bpm, tonic }` instead of drawing them.
- `frame: "set"`: no ending bar and no gap; section lengths are padded to a
  multiple of 4 bars by repeating their last bar's material.
- `lift`: a number added to every section's intensity, so the set's energy
  curve can make the same form play hotter or cooler.

The set conductor then lays a **mix-in** and a **mix-out** over the track's
first and last 16 bars. These are not new sections. They are the track's own
bars with roles left out: drums and percussion only at first, then bass, then
the rest. `Piece.renderBar` gets an optional set of roles to leave out; the
notes are still generated (so voicing memory and random streams do not move)
and are dropped from the result.

**Transitions.** The outgoing track's mix-out and the incoming track's mix-in
are played in the same slices. The type is chosen from the energy step and the
styles, seeded:

| Type | When | What happens |
| --- | --- | --- |
| Blend | Similar energy, both straight (no swing) | 16 or 32 bars. Incoming drums fade in with its lows cut; at the midpoint, on a phrase, the bass swaps (outgoing lows cut, incoming lows open); outgoing fades out. |
| Filter | Energy going up | Outgoing is high-passed away over 8 bars while incoming enters underneath; riser into the incoming track's first full section. |
| Cut | Swung styles, or a big energy step | Outgoing plays to a phrase end with a one-bar echo throw; incoming starts on the downbeat at full weight. |
| Breakdown | Energy going down | Outgoing drops its drums for 8 bars; incoming pad or lead enters over it; incoming drums land on the next phrase. |

**Builds and drops inside a track.** Before a section whose intensity is at
least 0.25 above the one before it, the set conductor writes a build over the
last 4 or 8 bars: kick left out, a snare roll that doubles in rate (written as
ordinary drum notes), a rising high-pass move and a riser. The drop is the next
section starting with everything in. This is the plan's "transitions" backlog
item; if the other session built it in the arranger, use that and only add the
moves.

**Seeking.** As today, a position is replayed from the seed. Positions are
`track.bar`. Seeking into a transition lands on its first slice.

### 2. Moves (new)

```ts
interface Move {
  deck: 0 | 1 | "master";
  target: "gain" | "lowCut" | "highCut" | "lows" | "reverbSend" | "delaySend" | "riser" | "impact";
  roles?: Role[];             // default: the whole deck
  from: number; to: number;   // in the target's own unit (gain 0..1, Hz, ...)
  beats: number;              // length, from the start of the slice
  curve?: "linear" | "ease";
}
```

Gain, filter and low-end moves run in the worker on the stems, sample by
sample, so they are deterministic and testable in Node like `WeightedMix`.
Send throws are scheduled on the bus as `AudioParam` ramps. Risers and impacts
are synthesised in the worker (filtered noise and a pitched sweep; a low thump
with a noise tail) into an `fx` stem per deck. Audio clips, if phase 4 of the
other plan happens, become another source for the same `fx` stem.

Every move ends at a stated value, and a deck that leaves the mix is reset, so
a seek or a skip can never leave a filter half closed.

### 3. Two decks in the worker

Today `worker.ts` keeps one of everything at module level: `windows`,
`levelers`, `bodies`, `prev`, one `WeightedMix`. That becomes:

```ts
class StemDeck {            // one track's rendering state
  windows, bodies, prev, weighted
  render(bar message): Map<StemId, Stereo>   // today's renderBar body
}
class SetMix {              // above both decks, per slice
  process(decks: Map<StemId, Stereo>[], moves: Move[], dominant: 0 | 1): Map<Role, Stereo>[]
}
```

The existing single-deck path is `StemDeck` used once, with `SetMix` skipped,
and must stay bit-identical for the other two apps.

`SetMix` owns what cannot be decided per deck:

- **One kick ducks everything.** The dominant deck's kick envelope ducks both
  decks' pads, comps and basses.
- **One low end.** Below about 150 Hz only the dominant deck's kick and bass
  pass; the other deck's are cut. The bass swap is the dominant flag changing
  on a phrase, with a short crossfade.
- The moves.

The worker message becomes a slice: both decks' notes for the same frames, the
moves, and which deck is dominant. Both decks have the same tempo, so they
have the same frame count.

### 4. Bus and worklet

The stem worklet already writes each stem to an output by index; it is created
with `2 x ROLES` outputs (plus two for `fx`).

`Bus` is split:

- `DeckStrip`: the per-role chains (high-pass, chorus, pan, sends), the
  reverb and delay, set from one style's preset. One per deck, because the two
  tracks are different styles with different rooms.
- `Master`: tape chain, compressor, limiter, ceiling, trim, meter. One.

`Bus` stays as a thin class that builds one strip and one master, so the other
apps are untouched.

### 5. `SetPlayer` (new, beside `Player`)

`Player` is 1,057 lines built around one stream of bars: its timeline, its
engine switching, its sample prefetch and its seek all assume it. Bending it to
slices would put every existing behaviour at risk. Instead, extract what both
need and write the scheduler new:

| Extracted from `Player` (shared) | New in `SetPlayer` |
| --- | --- |
| `AudioClock`: the smoothed `now` | Timeline of slices; "what is audible" is one or two tracks |
| `EngineHost`: context, worklet, worker, bus wiring, wasm loading | Dispatching slices; strips' `setStyle` per deck at each track start |
| `SamplePlanner`: planning, download-rate tracking, prefetch horizon | Prefetch must cover the incoming track before its mix-in starts; if it cannot, the transition is postponed by a phrase |
| | Position as track and bar; jumping to a track |

No engine switching mid-set in the first cut: the engine is chosen before
play. That removes the most intricate part of `Player`.

### 6. Corpus additions

An optional block per style; styles without it use defaults:

```json
"set": {
  "room": "house",
  "mixBars": 16,
  "blend": true,
  "drops": true
}
```

Later, and independent of the rest: `Instrument.patch` beside `program` (the
other plan's "patches instead of programs"), so a house bass is a designed
sound and not GM program 38. Club styles will sound generic until this exists.

### 7. The page

Its own design and Bazel target, like Mighty Midi (`//src/set`, working name).
What it shows that the others do not: two decks with what each is playing, the
set's energy curve with a marker for now, the transition in progress (type,
bars left), and a tracklist that grows as the set plays.

**Export.** A tracklist (time, style, key, tempo, track seed) as text, and a
recording of the set as audio through `MediaRecorder` on the output. An
offline render is not possible while the master is a Web Audio graph.

## Implementation, in order

Each step leaves something that plays.

| Step | What | Size | Result you can hear |
| --- | --- | --- | --- |
| 1 | `BarSource` interface; `Piece` options (`fixed`, `frame`, `lift`, roles left out); key compatibility; `SetConductor` with **cut transitions only** (one deck) | M | A gapless set at steady tempo in compatible keys, playable through today's `Player` and Mighty Midi's page with a flag |
| 2 | Moves in the worker for one deck; builds and drops inside tracks; synthesised riser and impact | M | Tension and release within tracks |
| 3 | `StemDeck` and `SetMix` in the worker; bus split; worklet outputs; `SetPlayer` with the extracted clock, host and sample planner; blend, filter and breakdown transitions | L | Two tracks overlapping, beat-locked, with a bass swap |
| 4 | The page and its Bazel targets; tracklist; recording | M | The app |
| 5 | House and techno corpora, a second drum & bass style, `set` blocks on existing styles | S to M | Sets that sound like club music |
| 6 | Patches for club styles | L | Sounds that are designed, not GM |

Step 1 is deliberately small and proves the idea before any plumbing changes.
Steps 5 and 6 can run in parallel with 3 and 4.

## Tests

`SetConductor` is pure, so most of the design can be asserted without audio:

- Tempo never moves more than 3% between consecutive slices, and both decks of
  a slice share it.
- At every transition the two tracks' scales share at least six pitch classes.
- Every transition starts and ends on a phrase boundary, and the bass swap
  falls on one.
- In no slice do both decks have bass notes with their lows open.
- Same seed and pool, same slices; seeking to `track.bar` gives the same slice
  as playing to it.
- With the new `Piece` options off, bars are identical to today's (compare
  against the previous sources, as was done for the weighted mix).

`SetMix` and moves, in Node through the synth:

- During a blend, energy below 150 Hz stays within 1 dB of a single deck's.
- Level across a transition stays within 2 dB of the tracks either side.
- A move produces no step larger than its ramp allows (no clicks), and every
  move's target is at its end value after it.
- The single-deck path through `StemDeck` is bit-identical to the current
  worker's output.

## Risks

- **CPU.** During a transition the worker renders two tracks. The synth has
  headroom on a laptop; phones are unknown. Measure with `?perf` at step 3, and
  be ready to thin the incoming deck (drums only for longer).
- **Samples.** Two styles' samples must be ready before a blend starts. The
  postponement rule covers a slow connection, at the cost of a longer track.
- **Blends that clash.** Compatible keys do not guarantee two melodies sound
  good together. The mix-in and mix-out keep leads out of the overlap; pads
  from both decks may still muddy. If so, only one deck's pad plays at a time,
  like the bass.
- **Section lengths.** Several corpora have 1- and 2-bar sections. Padding to
  4 bars may sound repetitive; the alternative is excluding those forms in set
  mode.
- **It may sound generic** until steps 5 and 6. Judge the idea at step 3 with
  disco and liquid drum & bass, which are closest to club material today.
- **`Player` extraction** touches the two shipped apps. It needs the same
  bit-identical discipline as the last round, plus a browser check of both.

## Decisions for you

1. **Third app, or a mode of Mighty Midi?** A third app is cleaner: Mighty
   Midi stays "MIDI, but heavy", and the set app is free of the MIDI promise.
   Step 1 can live behind a flag in Mighty Midi until step 4 either way.
2. **Finite or endless.** A 60-minute set has a real arc and an ending; an
   endless one repeats its arc in waves. The conductor can do both; the page
   and the link format need to know which.
3. **Rooms.** One room per set (simple, coherent), or sets that travel between
   rooms through half-time and double-time (lofi at 87 into drum & bass at
   174). The second is a good trick and can come later.
4. **Engines.** Synth and Samples only at first, as proposed, or `fm_bus` too.
5. **How far to go on sound design.** Step 6 is the largest item and the one
   that most decides whether this sounds like a club or like a game.
