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

**Poses** are still frames: Home, Look, Vinyl, Cue, Build, Peak (see the
prompt notes). **Clips** start on one
pose and end on one (the same pose for loops and flourishes). Any clip may
follow another clip that ends on its start pose. Every clip is a whole
number of bars.

```ts
type Pose = "home" | "look" | "vinyl" | "cue" | "build" | "peak";
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
0.9–1.16 (raised from 1.10, then 1.11: see clip lengths below); a trimmed
drop clip may set its own limit (`maxRate`).

**Clip lengths: 3 and 5 bars.** Grok makes 6.04 s and 10.04 s takes. At
128 BPM those become 3 bars (5.625 s, ×1.074) and 5 bars (9.375 s,
×1.071), and 3 + 5 = 8. So a 6 s take is always 3 bars and a 10 s take 5
bars, never slowed to 4. A phrase is 3 + 5 or 5 + 3 (loop + loop,
transition + loop, loop + transition), 16 bars is 3 + 5 + 3 + 5, and every
phrase starts on a pose frame. Transitions and flourishes are 6 s, so they
pair with a 5-bar loop in the same phrase. Each pose should get a 6 s and
a 10 s loop, which also gives variety. The takes come out at 144 and 240
frames plus a closing pose frame, so every clip plays at 120 BPM at ×1:
×0.98–1.15 across Claudia's 118–138 BPM (psychedelic house to Berlin
techno), hence the 1.16 limit (2026-11-17; 1.11 covered only 126–132).
Outside it the director stays on the Home loop that comes closest.

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

- Plans in whole bars, a phrase (8 bars) at a time, at least 4 bars ahead;
  every phrase start is a clip boundary. After a seek mid-phrase, the gap
  to the next phrase start is filled if 3s and 5s can fill it, else the
  plan runs to the start of the phrase after.
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
would also need each section's intensity).

*Checked (prototype, 2026-11-14):* `window()` holds only the scheduled
bars, 4 s ahead for Synth and 6 s for Samples (`LOOKAHEAD`), about 2–3
bars: no use for planning. `layout(piece)` works for the current track at
any bar and is `null` for the next one until it has started, since the set
conductor only picks a track when it begins. Exposing intensity was one
field on `Segment` (`piece.ts`), now in. The next track is therefore
assumed: a blend zone for its first 16 bars, middling energy, no drops;
the plan is corrected once it starts (see `RollingPlan`). The blend zone of
the outgoing track comes from `pieceBars` alone, so the cue sequence
across a mix is always known in time.

Tests (`node:test`, as in `set.test.ts`): over long seeded sets,

- every clip starts on the pose the previous one ended on;
- every clip starts on a bar line and fills whole bars;
- Build → Peak ends exactly on the section start it was planned for;
- the same seed and starting bar give the same plan;
- rates stay within 0.9–1.16 (a clip's own `maxRate` for trimmed drops) at the styles' tempos;
- every phrase starts on a clip boundary.

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

## Prototype results (2026-11-14)

Branch `claude/booth-cam-prototype-ce2cc9`. What exists:

- `tools/clips/` (`bazel run //tools/clips:prep`): reads
  `art/claudia-dj/selects.json` (which take is which clip, and the pose
  stills), writes clips named by their SHA-256 to `~/workspace/claudia/clips/`
  and `src/claudia/clips.json` (the `ClipSet`, the one committed file).
  752×416 (the frame of the Grok loops; 16:9 takes are cropped to it), 24
  fps, no audio, CRF 26, keyframe every 12 frames: 0.65–1.4 MB a clip.
- `src/claudia/director.ts` with `director_test`: the director as planned,
  plus `cuesFor` (cues from the bar and its track's sections) and
  `RollingPlan` (the plan as the page keeps it, bar by bar, replanning only
  when the music turns out other than assumed).
- `src/claudia/booth.ts`: the clip player, at the top of the page, on by
  default, a hide button remembered in the page's store, the still for
  reduced motion and before play. Clips are served by the dev server from
  `~/workspace/claudia/clips` (`clips/` mount, skipped if the folder is
  missing; the page hides the cam when the still does not answer, so the
  deployed site is unchanged until the store exists). `?clips=<url>` points
  it elsewhere.

**The takes.** Measured with the prep tool (diff scale as above):

| Clip | Take | Range | Bars, bpm | Close | Off Home |
|---|---|---|---|---|---|
| L2-home-mid | groove, 10 s, 1280×720 | boomerang 0→112→0 | 5 at 128.6 | 0 | 3.37 |
| L2s-home-mid | groove | boomerang 0→70→0 | 3 at 123.4 | 0 | 3.37 |
| S1-home-cue | cue gesture loop | 11–144 | 3 at 129.9 | 0.98 | 1.32 / 1.43 |
| S2-home-peak | hands-up loop | 2–140 | 3 at 125.2 | 1.37 | 1.07 / 1.54 |

- The groove take is 16:9 and the Grok loops 752×416 (1.81:1): cropping
  the groove to that aspect around the centre brings its first frame from
  7.4 to 3.4 off the Home still, and no crop offset or zoom does better.
  The rest is a different frame (exposure does not explain it: 3.2 after
  matching brightness). After frame 0 the take wanders 7–12 away from Home
  and never comes back, and the best loop inside it (2 bars, close 1.8) is
  9.9 off Home. So it cannot loop at Home; it plays as a **boomerang**
  (forward, then reversed), turning on its stillest frame. The reversal is
  visible if you look for it (her hands run backwards); a proper Home loop
  of this groove is the first clip to make.
- The search prefers trimming the Grok loops by a few frames (frames 11–144
  and 2–140) over their own first/last frames: they close better there
  (0.98 vs 1.43) and land nearer 128 bpm.
- Clip lengths are 3 and 5 bars (see the model). A first version used 4-
  and 2-bar groove cuts; that filled any gap but let joins fall anywhere
  in a phrase. With 3 + 5 every phrase starts on a clip boundary, and the
  tests land over 80% of drops on their downbeat (the rest are too close
  to the previous drop or the track start).
- Each phrase needs a 3-bar clip, and the only plain 3-bar Home clip was
  the cue gesture, which then played in every phrase. The 3-bar groove
  boomerang (L2s) is a stopgap for the 6 s Home loop. For the same reason
  the cue can fill at most 3 of every 8 blend bars (about 30% measured)
  until there is a 10 s cue loop.
- **Beat phase** from motion is weak on these takes (comb strength
  1.15–1.25, where 1 is no beat): her nods are not steady at a tempo. The
  groove nods about every 20 frames (72 per minute), not on our beats. The
  phases found sit within a frame of the clip start, so they change
  nothing; set them by hand in `selects.json` if a take nods clearly.

**The director with these clips.** No Cue or Peak poses exist yet, so the
cue gesture and the hands-up are scenes at Home (`scene: "blend"`,
`"drop"`): the cue gesture fills about half the bars of each blend zone,
the hands-up lands on drops and very rarely elsewhere as a flourish. The
same code plans with real poses and transitions: the tests run it on a
synthetic full shot list too.

**Sync, measured** in headless Chrome on a MacBook (desktop Chrome, 60 s
of a set, drift of each presented frame against `player.now` via
`requestVideoFrameCallback`): mean 0.25 frames (10 ms), worst 1.1 frames,
bias under 0.05 frames, no seeks after the first, 12 joins. With the 3/5
clips, 45 s: mean 0.17, worst 0.91, no seeks, joins on bars 8, 16, 24, 32
and 40 of the track. Pause holds the
frame and resume continues without a seek. A skip replans after the clip
on screen and the cue gesture starts on the new track's mix-in; one
measurement there peaked at 3.7 frames (not yet explained: the tempo step
between tracks, or the bars the skip replaces). A new set restarts the
plan at Home with one seek, a visible cut, as planned. Phone width (390
px) lays out without horizontal scroll. **Not measured:** iOS Safari and a
real phone (the iOS check below is still open), and the in-app browser
pane, which throttles animation frames when hidden.

**Joins.** The Grok loops are 1.1–1.5 from the shared Home frame, the
groove 3.4. Rendered the way the page joins them (the outgoing clip holds
its last frame, the incoming starts at frame 0 and fades in over 6 frames)
and measured frame to frame: every step through S1→L2, L2→S1 (the groove
join), S2→S1 and S1→S1 is 0.3–1.1, inside the clips' own motion (median
0.7, 95th percentile 1.6). So even the groove's 3.4 joins smoothly. The one
artifact is a repeated frame at the join, where the outgoing clip has run
out; a clip one frame longer, or starting the fade a frame early, removes
it. This was measured offline on the encoded clips, not on screen
captures of the page.

**Open problems.**

- ~~A Home groove loop, then the other poses~~: done with the full shot
  list, below.
- iOS Safari: `playbackRate` bending and seeks on muted inline video.
- The spike after a skip, above.
- The next track's sections are unknown until it starts, so a drop in its
  first 16 bars (inside the mix-in, rare) can be missed.
- Bars are counted by the page as they become audible; a link to a bar
  starts at Home there rather than where an uninterrupted session would be.

## The full shot list (2026-11-17)

All 23 clips of [SHOTLIST.md](../art/claudia-dj/SHOTLIST.md) over six poses
(Home, Look, Vinyl, Cue, Build, Peak), in `art/claudia-dj/selects.json`.
The takes stay in `~/workspace/claudia/clips/`; prep encodes them to
`src/claudia/clips/` in the repository (see hosting below): 1280×720, CRF
27, a keyframe a second, 24 MB for all 23 (SSIM 0.985 against the takes;
CRF 24 with a keyframe every 12 frames was twice the size). Pose stills come
from the pose PNGs.

- **Every take is whole:** a Grok take's last frame is its end pose, so a
  clip is frames 0–143 (or 0–239) and the next clip starts on the pose.
  Loops close at 0.9–1.6 (the scale above), every first and last frame is
  within 2.0–2.9 of its pose PNG (a video frame never matches the PNG
  closer than about 2), and joins between clips measure median 1.7, p90
  2.7, against 0.4 between frames inside a clip; the 6-frame crossfade
  carries them.
- **Drop clips are trimmed:** in T06 and T07 the arms go up a bar in (frame
  52 and 44). Played from the drop, the gesture would land a bar late, so
  T06 is frames 48–144 and T07 frames 40–144, 2 bars each, starting on the
  drop: the drop phrase is 2 + 3 + 3. T07 then plays at 110.8 BPM at ×1, so
  it may run to ×1.25 (×1.15 at 128). Their starts are 3.1–4.6 from the
  clip before, the largest joins in the set, on the drop itself. F03 (the
  sip) ends 3.4 off Home, the only other one over 3.
- **The director** wants a pose per bar: Home in a track's body (Look
  allowed except at low energy), Vinyl or Cue in the blend zones, Build in
  the 8 bars before a drop and Peak in the 8 after (`Cue.moment`). A clip's
  weight is its end pose's affinity, ×4 when it arrives somewhere better,
  times its energy match. Paths are chosen by weight among the clips that
  leave a way to the phrase end; weighting by the number of ways onward
  pulled her back to Home within a bar of every drop.
- **Measured** over 4 × 3000-bar seeded runs: 83% of drops land on their
  first bar (52% of those out of a build), 73% of the drop phrase at the
  peak, 77% of blend-zone bars at the record, Look 2.9% and flourishes 5%
  of body bars. With only the 8 MVP clips: 84% of drops, 88% of blend bars.
  In headless Chrome at 132 BPM (×1.10), 2 minutes: 17 joins, drift mean
  0.23, max 1.07 frames, no seeks.

**Joins (2026-11-17, after use).** The joins stuttered. The player had
shifted each clip by its measured beat phase (−5 to +2 frames), so at a
join the old clip froze on its last frame or the new one started while the
old still moved, up to 7 frames apart, for beat estimates barely above
noise (strength 1.1–1.3; Grok does not know the tempo). Now every clip's
frame 0 is on its bar line, so the new clip's first frame takes the place of
the old one's closing pose frame, and the crossfade is 10 frames (was 6) to
carry the takes' slightly different pose frames. Traced per animation frame
in headless Chrome: old clip to its last frame, new clip from frame 0 on the
next tick, no held picture; drift mean 0.26, max 0.90 frames, no seeks.

**What the shot list cannot do yet.** A phrase of 3 + 5 holds one 6 s clip,
and only Home and Vinyl have 10 s clips, so a visit to Look, Cue or Build is
always transition in, transition out: **L06-cue, L07-build and L09-look
never play**, and L08-peak only right after a drop (2 + 3 + 3). 10 s
versions of L06, L07 and L09 fix it: a look becomes T10 + L09 (3 + 5),
the whole phrase before a drop T05 + L07, and a blend can stay on the
headphones. A build is also reached only from Home 8 bars before the drop,
which is why half the drops come straight from Home (T07).

## Hosting the clips

The clips (24 MB) are committed in `src/claudia/clips/`, named by the
SHA-256 of their bytes, and ship with the site at `clips/`;
`clips.json` refers to each by hash, so a new take never overwrites an old
one, and prep removes files the new `clips.json` no longer names. Earlier
plan: content-addressed storage on R2, shared with samples; the names
already fit it, and `?clips=<url>` points the page elsewhere.

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
