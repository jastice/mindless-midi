# Claudia DJ: look, poses and prompts

The booth cam shows Claudia playing in the yellow tiled room. Every clip
starts and ends on a **pose**: a still frame of the same shot. Clips that
share a pose join without a seam, so the poses are the foundation and are
made first. Which clips to make from them, and how long each is, is in
[SHOTLIST.md](SHOTLIST.md).

Claudia is an open character by anabology (claudia.gallery). The video is
generated with Grok Imagine. No HÖR name or logo anywhere.

## The look (settled 2026-11-17)

- **Reference:** the DJ Claudia full-length image (standing, grey
  background), kept as `~/workspace/claudia/refs/dj-claudia.png`. It
  replaces every earlier reference; the claudia.gallery face and body sheets
  and the white-tank-top look are retired.
- **Her:** glossy black blunt bob with heavy bangs, an orange streak and an
  orange star clip both on the viewer's right (her left), winged eyeliner,
  grey-blue eyes, light freckles, orange nails. Black over-ear headphones
  worn on her head (no headset microphone in this look). Black blazer, open,
  over a white satin crop top, black pleated mini skirt.
- **The room:** pale yellow square tiles with dark grout, fisheye lens (the
  room's signature), a curved yellow-white light tube on the left, a door at
  the back, a wooden bench on the right.
- **The booth:** a white counter with two Pioneer media players, a silver
  turntable with a black record with an orange star label, and a mixer.
- **Props:** an orange plush, a record sleeve and a water bottle on the
  shelf behind her on the left.
- **Camera:** locked, at chest height across the booth, the same framing in
  every pose and clip.

Every prop and the bench must be in every pose, in the same place. A prop
that is missing from one pose pops in and out at every join.

## Poses

All files in `~/workspace/claudia/poses/` (PNG and WebP, 1672×941). New
poses are made by **editing P0-home**, never from scratch, so the room,
props, light and framing stay identical.

| ID | Pose | Status | Used for |
|---|---|---|---|
| P0-home | Both hands on the mixer, head bowed, focused | Done | The resting pose: most loops start and end here |
| P1-look | Looks into the camera with a half smile; right hand on a mixer knob, left hand on the right player's jog wheel | Done (redone 2026-11-17 with the bench; the first version is in `poses/old/`) | Eye contact with the viewer |
| P2-vinyl | Left hand on the record, right hand on the mixer, head bowed | Done | Beatmatching during a blend |
| P3-cue | Right hand pressing the headphone cup to her ear, head tilted toward it, left hand on the mixer | Done | Listening to the incoming track |
| P4-build | Left hand raised high with the index finger pointing up, right hand on the mixer's filter knob, eyes on the mixer | Done | Building tension before a drop |
| P5-peak | Both arms raised, hands open, eyes closed, head tilted back | Done | The drop and its first bars |

All six were checked against P0-home (2026-11-17): the bench, door, light
switch, light tube, shelf with plush, sleeve and bottle, and the booth are
in the same place in every pose. Only her body moves. P4-build has a small
made-up "FILTER" label on the mixer next to her hand; harmless, but watch
that it does not crawl in clips.

### Edit prompts

Upload `P0-home.png` and start every edit with:

> Edit this image. Keep everything identical: the room, tiles, light tube,
> door, bench, the shelf with the orange plush, record sleeve and water
> bottle, the booth and all its equipment, the camera, lens and framing, and
> the woman, her face, hair, headphones and clothes. Only her pose changes:

Then one of:

| Pose | Pose text |
|---|---|
| P1-look | she looks straight into the camera with a confident half smile, her right hand on a knob of the mixer, her left hand resting on the jog wheel of the right player. |
| P3-cue | she presses the right cup of her headphones to her ear with her right hand, head tilted toward it, eyes down, her left hand on the mixer. |
| P4-build | her left hand is raised high above her head with the index finger pointing up, her right hand holds the filter knob in the middle of the mixer, eyes on the mixer, lips pressed together. |

Check each result against P0-home before using it: flip between the two;
only her body should move.

## Prompts for clips

Grok takes a first frame, a last frame and a loop option. The frames carry
the look, so the prompt only describes motion. Short prompts work best.

- **Loops:** the pose as the first frame, the loop option on. Prompt the
  motion only.
- **Transitions:** the start pose as the first frame, the end pose as the
  last frame.
- End every prompt with: *Locked camera, no zoom, no cut. Nobody else
  appears. Nothing in the room moves except her.*
- Lengths are 6 s or 10 s only (see the shot list for which).
- 16:9, 720p. Audio is thrown away.
- 2–3 takes per clip. Save takes to `~/workspace/claudia/takes/` as
  `<clip id>-<take>.mp4`; copy the chosen one to
  `~/workspace/claudia/selects/<clip id>.mp4`.

## Picking takes

- Her face, streak side, star clip and outfit hold for the whole clip.
- The camera, the room and the props did not move.
- The first and last frames match their poses (the clip prep tool measures
  this; a difference under about 2 on its scale is invisible after the
  crossfade).
- Loops: a steady nod with no single standout gesture, which would repeat
  visibly every few bars.

## What the first tests showed (2026-11-14)

Kept short; the earlier look and its prompts are retired.

- At 128 BPM one bar is 45 frames at 24 fps. A 6.04 s clip plays as 3 bars
  and a 10.04 s clip as 5 bars, both about 7% fast, which is invisible.
- Hard cuts between clips that end in different states look broken. Joins
  on a shared pose frame with a 6-frame crossfade measure as smooth as
  ordinary motion. This is why everything is built on poses.
- Her nods follow the clip, not our beat; each loop's beat phase is set once
  by the clip prep tool.
- A clip that cannot end on its pose can be played forward and back
  (boomerang) as a stopgap, but true first/last-frame clips are better.
