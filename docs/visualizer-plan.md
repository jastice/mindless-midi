# DJ Claudia visualizer: implementation plan

A booth cam on DJ Claudia's page: Claudia playing in the yellow tiled room,
in time with the set. The page plays short generated clips (loops,
transitions, flourishes) in an order picked from the music, on the audio
clock, so her nods land on the beat and her moves land on the set's events.
It is not a music video: no clip is made for a particular track.

The clips are made by hand in Grok Imagine from
[the shot list](../art/claudia-dj/SHOTLIST.md); how they were found to work,
and why they join the way they do, is in
[the prompt notes](../art/claudia-dj/PROMPTS.md). This plan covers
everything after a clip has been chosen.

Sizes as in [the DJ set plan](dj-set-plan.md): S is a day or two, M about a
week, L several weeks.

## What is known from the tests (2026-11-14)

- Grok clips are 6.04 s, 1280×720, 24 fps, with audio we drop.
- At 128 BPM a bar is 45 frames, so a 6 s clip is 3 bars at ×1.074 speed.
  Speed changes of a few percent are invisible.
- Cutting between clips whose end and start states differ looks broken.
  Joining on a shared pose frame, plus a 6-frame crossfade, measures as
  smooth as ordinary motion. Hence poses, and clips that start and end on
  them.
- Her nods follow the clip, not our beat; a loop's phase within the bar has
  to be set once per loop, by hand or by measurement.

## The model

**Poses** are still frames: Home, Cue, Build, Peak. **Clips** start on one
pose and end on one (the same pose for loops and flourishes). Any clip may
follow another clip that ends on its start pose. Every clip is a whole
number of bars.

```ts
type Pose = "home" | "cue" | "build" | "peak";
type ClipKind = "loop" | "transition" | "flourish";

interface Clip {
  id: string;                 // "L2-home-mid"
  kind: ClipKind;
  from: Pose;
  to: Pose;
  energy?: "low" | "mid" | "high";  // loops at Home
  file: string;               // relative to the clips base URL
  frames: number;             // usable frames, after trimming
  bars: number;               // how many bars the clip fills
  bpm: number;                // tempo at which it plays at ×1
  beatPhase: number;          // frame of the first downbeat nod, 0..frames/bars
  fadeFrames: number;         // crossfade when another clip follows, default 6
}

interface ClipSet { fps: number; clips: Clip[] }
```

`bpm` is `bars * beats * 60 * fps / frames`; a clip plays at
`rate = setBpm / clip.bpm`. A clip is usable only when the rate is within
0.9–1.1. Outside that range the director stays on the Home loop that comes
closest, until a second batch of clips exists for another tempo band.

## Parts

### 1. Clip preparation tool (S)

`tools/clips/`: a Node script calling `ffmpeg`, run by hand on a folder of
selects (`~/workspace/claudia/selects/` by default). Per clip:

- Trim to the usable range and find the loop point for loops: the frame
  pair 45×n apart that matches best (the pixel-difference search used in the
  tests).
- Check the joins: the first frame against its `from` pose still, the last
  against its `to` pose still. Report any difference above a threshold
  (3.0 on the test scale) so a bad take is caught before it ships.
- Estimate `beatPhase` from the nod rhythm (motion energy per frame, the
  phase that best matches a 4-beat comb), overridable in a sidecar file.
- Transcode without audio to H.264 MP4, 1280×720, CRF about 26, keyframe
  every 12 frames so seeks are cheap. Roughly 1–1.5 MB per clip; 16 clips
  come to about 20 MB.
- Write `clips.json` (the `ClipSet` above) and a contact sheet per clip.
- Render a preview MP4 of a scripted sequence over a click, as in the tests.

Tests: the loop search and the join check on synthetic frames.

### 2. Director (M)

`src/claudia/director.ts`: pure, no DOM. Given the bars that are coming and
the clip set, it plans which clip plays in which bars. Same seed, same set,
same booth cam: it is seeded from the set seed and the bar index, so a
shared link lands on the same clip.

**What it listens to now**, from `BarInfo` and the set conductor:

| Signal | Source | Clip choice |
|---|---|---|
| Energy | `intensity` of the bar, plus the track's `lift` | Home loop: low, mid or high |
| Blend zone | `mixStage`: the first and last `MIX_BARS` of a track | Home → Cue at its start, Cue loop through it, Cue → Home at its end |
| Section change upward | next section's intensity at least 0.25 above this one | Home → Build a phrase before; Build → Peak landing on the downbeat |
| Section change downward | the same, the other way | Build → Home or Peak → Home; then the low loop |
| Long stretch with no event | more than 4 phrases | One flourish, starting on a phrase |

**Later**, from the steps of the DJ set plan that are not built yet:
step 4's builds, drops, risers and impacts replace the section-intensity
guess; step 5's transition types (blend, filter, cut, breakdown) choose
between the cue sequence and others. The director takes these as optional
inputs so it works before and after.

**Planning rules:**

- Plans in whole bars, a phrase (8 bars) at a time, at least 4 bars ahead.
- A transition that must land on a downbeat (Build → Peak on a drop) starts
  `clip.bars` before it.
- If the next event is too close for its transition, it is skipped: she
  stays in the current pose rather than jump.
- Never two flourishes in a row; never the same flourish twice in a phrase.
- After a seek or a reseed, start at Home on the next bar.

**Lookahead.** The director needs the next 1 to 3 phrases of section
starts and intensities. `Player.window()` only covers what has been
scheduled (seconds ahead), so the plan is to read the section layout from
the piece instead (`Player.layout()` gives sections with start bars; it
would also need each section's intensity). **To verify before starting:**
what `layout()` can give for the current and the next track in set mode, and
whether exposing intensity there is cheap.

Tests (`node:test`, as in `set.test.ts`): over long seeded sets,

- every clip starts on the pose the previous one ended on;
- every clip starts on a bar line and fills whole bars;
- Build → Peak ends exactly on the section start it was planned for;
- the same seed and starting bar give the same plan;
- rates stay within 0.9–1.1 at the styles' tempos.

### 3. Player for clips (M)

`src/claudia/booth.ts`: plays the director's plan in the page, driven by
`player.now` (the smoothed audio clock).

- **Two `<video>` layers**, muted, `playsinline`, stacked. The next clip is
  loaded and seeked to its first frame on the hidden layer a bar ahead. At
  the join the hidden layer starts and fades in over `fadeFrames` while the
  outgoing layer plays on underneath (the crossfade used in the tests).
- **Sync.** For the clip on screen, the target media time is
  `(now - clipStart) * rate`, plus the loop wrap for loops. Each animation
  frame: set `playbackRate` to the rate, nudged by up to ±3% to close small
  drift; seek only when it is more than 2 frames off. Pausing the set pauses
  the video; a tempo change between tracks changes the rate.
- **Loops** wrap by seeking back at the loop point, hidden by a short
  crossfade to the other layer playing the loop's start.
- **Preload** all clips of the current and next pose once playback starts
  (about 5–8 MB), the rest in the background. If a clip is not loaded in
  time, the director's fallback is to stay in the current loop.
- **On by default**, phones included. `prefers-reduced-motion`, or the user
  turning the booth cam off: show the Home still. Before play: the Home still. Hidden tab:
  pause the videos, and resync when the tab comes back.

Measured on a laptop and a mid-range phone: drift against the click,
dropped frames, CPU. Reverse playback is not used: boomerangs are rendered
forward by the prep tool when needed.

**To verify before starting:** how well `playbackRate` and seeking hold sync
on iOS Safari. If they do not, the fallback is WebCodecs: decode the clips
and draw frames to a canvas from the audio clock. That is exact and also
allows reverse playback, but costs more memory and code (M on its own).

### 4. Light on the beat (S)

An overlay on the video, driven by the bar's notes: a soft flash of the
tile glow on each kick, brighter on a drop's downbeat, and a slow pulse of
the light tube during builds. CSS blend modes or a small canvas. It hides
any join the crossfade does not, and ties the picture to the sound even
when her nod is a little off.

### 5. Page and credits (S)

The booth cam is the top of the page, 16:9, full width on phones, with a
button to hide it and a fullscreen button. Part of the DJ set plan's
step 7 page design, which this does not replace.

Credits under it, always visible:
"Claudia is an open character by anabology (claudia.gallery). Video
generated with Grok Imagine." No HÖR name or logo anywhere.

## Hosting the clips

Decided: the finished clips (about 20 MB, changing rarely) live on R2 in
content-addressed storage, named by the hash of their bytes. Samples may
move there too, so the store is shared and not clip-specific. `clips.json`
is committed and refers to each clip by hash, so the page and the tests know
exactly which bytes to expect, and a new take never overwrites an old one.
Until the store exists, the prototype serves clips from a local folder
through the dev server.

## Order of work

| Step | What | Size | Needs |
|---|---|---|---|
| 0 | MVP clips from the shot list (7 clips, 2 new poses) | by hand | — |
| 1 | Clip preparation tool | S | Step 0's selects |
| 2 | Director, with tests | M | The `layout()` check |
| 3 | Clip player in the page, with the existing groove/drop/cue takes until step 0 is done | M | 1, 2; the iOS check |
| 4 | Light on the beat | S | 3 |
| 5 | Page placement and credits | S | 3; DJ plan step 7 |
| 6 | The full shot list, then a second tempo band if the set leaves 126–132 BPM | by hand, then S | 3 |

Steps 1 and 2 can run in parallel. Step 3 can start on the three test takes
as boomerangs, so the page work does not wait for new clips.

## Decided

- Clips live on R2 in content-addressed storage (see above).
- The booth cam is on by default, phones included, with a button to turn it
  off (remembered per browser).

## Decisions to make

- The headset microphone: accept Home without it, or regenerate Home (and
  every pose after it).

## Risks

- **Sync on phones.** Media elements can lag the audio clock, which is
  covered by the iOS check and the WebCodecs fallback.
- **Repetition.** With 16 clips a long set repeats every few minutes. The
  energy loops and flourishes help; more takes per loop, picked at random,
  help more and cost nothing in code.
- **Tempo range.** The clips suit 126–132 BPM. Other styles need their own
  batch or a slower and faster set of loops.
- **Generated look.** The takes have a slight AI feel. Accepted for this
  use; the light overlay and the room's own look carry most of it.
