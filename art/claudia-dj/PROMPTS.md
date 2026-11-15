# Claudia DJ: Grok Imagine test batch

First test of the hybrid video plan: short clips of Claudia playing in a tiled
room, generated in the Grok app on the subscription, later looped and synced
to the engine's clock in the browser.

Claudia is an open character by anabology (claudia.gallery). Keep her canon:
black blunt bob with heavy bangs, one clay-orange streak (on her right side,
the viewer's left), small clay-orange eight-pointed star clip (on her left),
thin headset microphone, adult face in her late twenties. Never write "young".

## Materials (`refs/`)

| File | Use |
|---|---|
| `claudia-face.png` | Main reference upload: front face, clearest identity |
| `claudia-body.png` | Body proportions and the white tank top |
| `claudia-reference-sheet-small.png` | Whole sheet, 1440 px, if Grok accepts several images |
| `claudia-face-sheet.png`, `claudia-reference-sheet.png` | Originals from claudia.gallery/kit, full size |

## Settings

- 16:9, 720p. Video length: the longest Grok offers (we cut 4 bars = 7.5 s at
  128 BPM, or 2 bars = 3.75 s).
- Audio: ignore it, we throw it away.
- Generate 2–4 takes per prompt. Save to `~/workspace/claudia/takes/` as `<id>-<n>.mp4`
  (e.g. `v1-groove-2.mp4`), stills as `<id>-<n>.png`.

## The workflow

1. **Stills first.** Make the first frame as an image (S1, S2), uploading
   `claudia-face.png` as the reference. Pick the best one: every flaw in it
   carries into every video made from it.
2. **Then animate the chosen still** with the video prompts (V1–V5) using
   Grok's image-to-video. The still sets the look; the video prompt only
   describes motion.
3. Faceless shots (S0, V6, V7) need no reference and are where Grok is
   safest. Do them anytime.

## The room

Shared block, pasted into every still prompt:

> A small, narrow room where every surface — walls, floor and ceiling — is
> covered in small square glossy ceramic tiles in pale sea-green with thin
> white grout lines, like an old public washroom. Flat cold light from a
> fluorescent tube on the ceiling, plus one warm red lamp low in the corner.
> The tiles reflect the lights as soft smudges. No signs, no text, no logos,
> no posters, no windows.

## Stills

### S0 — empty room plate (no person)

> [room block] A plain folding table stands across the room facing the
> camera, holding two black DJ media players and a small black mixer between
> them, cables hanging down. The room is empty; nobody is in it. Camera at
> chest height on the far side of the table, slightly wide lens, looking
> straight at the back wall. Photographic, natural colour, a little grain.

### S1 — hero first frame, medium shot

Upload `claudia-face.png`.

> Use the uploaded image only for the woman's face and hair; do not show the
> uploaded image itself. A 28-year-old Caucasian American woman with an
> angular face, pale skin and light freckles, a glossy black blunt jaw-length
> bob with heavy straight bangs, one clay-orange streak through the bangs, a
> small flat clay-orange eight-pointed star hair clip, and a thin headset
> microphone at her cheek. She wears a white ribbed racer-back tank top and
> black over-ear headphones resting around her neck. She stands behind a
> plain folding table with two black DJ media players and a small black
> mixer, one hand on a mixer knob, head tilted down toward the decks, a small
> smile. [room block] Medium shot from across the table at chest height, her
> head and upper body in the centre with space above her head. Photographic,
> natural colour, a little grain. Nobody else in the room.

### S2 — hero first frame, wider

Same upload.

> Use the uploaded image only for the woman's face and hair. A Caucasian
> American woman in her late twenties with pale skin and a glossy black blunt
> bob with heavy straight bangs and one clay-orange streak, plus a thin
> headset microphone. She wears a white ribbed racer-back tank top, black
> high-waisted shorts and black over-ear headphones around her neck. She
> stands behind a plain folding table with two black DJ media players and a
> small black mixer, both hands on the decks. [room block] Wide shot from the
> doorway, showing the whole tiled room, the table and her from the waist up
> above it. Photographic, natural colour, a little grain. Nobody else in the
> room.

### What worked first (2026-11-14)

With `claudia-face.png` and our own room render `refs/tiled-room.jpg`
uploaded to a Grok project, this short prompt gave the first frame
(`~/workspace/claudia/takes/s1-simple-1.jpg`):

> use claudia-face as a reference, place her in tiled-room as a dj

Grok kept the room as rendered and got her face, streak side, star clip, tank
top and hands on the decks right. Only the headset mic is missing; add
"thin headset microphone at her cheek" when it matters.

The room is ours, not the generic one in "The room" below: yellow tiles, a
fisheye lens (the room's signature, keep it), a tall split mirror, a white
light tube on the left, four players and a mixer. Upload the render instead
of describing it. Image-to-video from this still was tested and is good
enough: a slight AI feel, fine for this use.

## Videos (image-to-video from S1 or S2)

Keep the camera still in all of them: locked cameras loop and cut best.

### V1 — base groove (the loop we'll see most) — from S1

> She is fully in the groove, playing a steady techno beat at about 128
> beats per minute. Her head nods down on every beat and her shoulders
> bounce with it, relaxed and loose; her bob swings slightly. Her right hand
> rests on a mixer knob and turns it slowly. She keeps looking down at the
> decks. Locked camera, no zoom, no cut. The room stays empty.

### V2 — build — from S1

> She leans in over the mixer and slowly turns a large knob with her right
> hand, her bouncing gets bigger and faster, her left hand rises flat above
> the decks with palm down and lifts slowly as the tension builds. She bites
> her lip, eyes on the mixer. Locked camera, no zoom, no cut. The room stays
> empty.

### V3 — drop — from S1

> On the drop she throws both hands up above her head, then brings them
> down and pumps her right fist on the beat, grinning, head bouncing hard,
> bob swinging. After two seconds she puts both hands back on the decks and
> keeps nodding. Locked camera, no zoom, no cut. The room stays empty.

### V4 — cueing the next track — from S1

> She lifts the right cup of her headphones from her neck and presses it to
> her right ear with her right shoulder raised, listening, eyes down, nodding
> to a different beat; her left hand nudges the edge of the left player's
> jog wheel. Then she lets the headphones drop back to her neck. Locked
> camera, no zoom, no cut. The room stays empty.

### V5 — looks up and smiles — from S1

> She keeps nodding to the beat, then looks up straight into the camera,
> smiles and points at the lens with her right index finger on one beat,
> then looks back down at the decks. Locked camera, no zoom, no cut. The room
> stays empty.

### V6 — hands only (no face) — no reference

> Close-up of a woman's hands on a small black DJ mixer on a plain folding
> table: her right hand slowly turns a filter knob while her left hand slides
> a channel fader up. Her white ribbed tank top is just visible at the top of
> the frame; her face is out of frame. Behind her, out of focus, small square
> glossy pale sea-green tiles reflect a fluorescent light and a warm red
> lamp. Locked camera, shallow depth of field. No text, no logos.

### V7 — the room breathing (no person) — from S0

> The red lamp in the corner pulses brighter and dimmer on a steady beat
> about twice a second; its reflection swells and fades in the tiles. The
> fluorescent tube flickers once. Nothing else moves. Locked camera. Nobody
> enters the room.

## What to look for when picking takes

- Her canon: streak on the viewer's left, star clip on the other side,
  headset mic present, adult face. Reject teen-looking or re-faced takes.
- No text, logos or extra people appeared.
- The camera really stayed still.
- Repeating motion (V1): a steady nod we can find a beat in. We'll cut the
  loop and set the playback speed so her nod lands on our beat.

## Rights

- No HÖR name or logo anywhere, here or in the app.
- Credit: "Claudia is an open character by anabology (claudia.gallery)".
- Say the video is AI-generated (Grok Imagine).

## First takes (2026-11-14)

Kept outside the repo in `~/workspace/claudia/takes/`, all from
`s1-simple-1.jpg`, 6.04 s, 1280×720, 24 fps:

| Take | Prompt | Use |
|---|---|---|
| `grok-18e66b16` | V1 groove | Returns to its first frame at 2.00 s (frame 48): a one-bar loop at ×1.067 for 128 BPM |
| `grok-899e68c0` | V3 drop | Hands up, fist pumps, back to the decks |
| `grok-65564935` | V4 cue | Headphones on, listens, back to the mixer |

All three start on the same frame and end near it, so any clip can follow
the groove loop. Preview with a 128 BPM kick:
`~/workspace/claudia/previews/groove-test-128bpm.mp4` (4 bars groove, 3 bars
drop, 2 groove, 3 cue, 2 groove).

## Joining clips

Clips that end in a different state (grinning, headphones on) can't be cut
back into the groove: no frame matches. Play them as a boomerang instead:
forward to a low-motion peak, then reversed back to frame 0, which is the
groove loop's own first frame. Drop turns at frame 70, cue at frame 67; both
fill 3 bars at 128 BPM within 4% speed. Seam jumps fell from 9.7 and 7.7 to
0.4 (normal frame step 0.9). Preview:
`~/workspace/claudia/previews/boomerang-test-128bpm.mp4`.

For new action prompts, ask for the round trip so the reverse half reads
naturally: an action with a clear peak and a calm return to the starting
pose, e.g. "…then lowers her hands back to the decks and keeps nodding,
neutral face, headphones around her neck as at the start".

Refined: the groove's best one-bar loop is frames 20–64 (45 frames, exactly
one bar at 128 BPM and 24 fps, no speed change). Every join (loop seam,
entry, exit) gets a 6-frame crossfade using the outgoing clip's next frames,
and the boomerang turn is a 12-frame dissolve of forward into reversed
frames. Largest step at any join: 2.0, against 3.3–9.7 before (median step
1.1; the biggest steps left are her arms flying up in the drop). Build
script kept in the session scratchpad; preview
`~/workspace/claudia/previews/crossfade-test-128bpm.mp4`.
