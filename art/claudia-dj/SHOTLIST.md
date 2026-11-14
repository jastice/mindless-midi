# Claudia DJ: shot list

Everything the visualizer plays, built as a small state machine. Four poses
are still frames. Each pose has loops that start and end on its frame, and
transitions run from one pose's frame to another's, so any clip can follow
any other without a seam. Made in Grok Imagine using its loop and first/last
frame options. Background and lessons: [PROMPTS.md](PROMPTS.md).

**MVP** marks the 7 clips and 2 new poses that make a first usable version.

## Rules for every clip

- **Same shot.** Every pose is an edit of the Home still, so framing, the
  fisheye, the room and the light stay identical. Never generate a pose from
  scratch.
- **Camera locked**, no zoom, no cut, nobody else in the room, no text.
- **Lengths: 6 s or 10 s, 16:9, 720p.** At 128 BPM a 6.04 s clip is 3 bars
  and a 10.04 s clip is 5 bars, each about 7% faster than generated, and
  3 + 5 = 8, one phrase. So every phrase is 3+5 or 5+3 and ends on a pose
  frame, ready for the next event. Transitions and flourishes are 6 s (3
  bars); loops come in both lengths, ideally a 6 s and a 10 s loop per pose.
  Never slow a 6 s clip to fill 4 bars (×0.8 reads as slow motion).
- **Loops** use Grok's loop option (first frame = last frame = the pose).
- **Transitions** set the first frame to the start pose and the last frame
  to the end pose.
- **Prompts stay short.** The short prompt with uploads beat the long ones.
  Describe motion only; the frames carry the look.
- **2–3 takes each.** Pick by: canon intact (streak on the viewer's left,
  star clip on the other side, adult face), the camera stayed still, the
  nods are steady, the start and end land on the pose.
- **Files** go to `~/workspace/claudia/takes/` as `<id>-<take>.mp4` (for
  example `L2-home-mid-1.mp4`), poses as `<id>.png`. Chosen takes are copied
  to `~/workspace/claudia/selects/<id>.mp4`.

**Decide before making poses:** the Home still has no headset microphone,
which is part of her canon look. Either accept that for this room, or
regenerate Home with "thin headset microphone at her cheek" first, since
every other pose is made from it.

## Poses (stills)

Upload `P0-home` and edit it. Prompt prefix for all edits:

> Same image, same room, same camera, lens and light, same woman and
> clothes. Only her pose changes:

| ID | Pose | Edit prompt (after the prefix) | MVP |
|---|---|---|---|
| P0-home | Hands on the decks, neutral face, headphones around her neck | Have it: `takes/s1-simple-1.jpg` | ✓ |
| P1-cue | Cueing on headphones | she presses the right cup of her headphones to her right ear with her right hand, head tilted toward it, eyes down at the left player, left hand on its jog wheel | ✓ |
| P2-build | Leaning in for the build | she leans in over the mixer, right hand on a large knob in the middle of the mixer, left hand hovering flat above the decks, eyes on the mixer, lips pressed together | |
| P3-peak | Peak after the drop | both her hands are raised high above her head, fingers spread, mouth open in a big grin, eyes on the camera | ✓ |

## Loops (first = last = the pose)

| ID | Pose | Prompt | Use | MVP |
|---|---|---|---|---|
| L1-home-low | P0 | she plays a slow minimal techno track, small nods on every beat, hands making small adjustments on the mixer, calm and focused | Intros, breakdowns, low energy | |
| L2-home-mid | P0 | she grooves to a steady 128 bpm techno beat, head nodding down on every beat, shoulders bouncing loosely, right hand turning a mixer knob, eyes on the decks | Default | ✓ |
| L3-home-high | P0 | she dances hard to a fast techno beat, bouncing on every beat, bob swinging, shoulders and head moving, both hands working the mixer, smiling | High energy, after drops | |
| L4-cue | P1 | she listens on the headphone cup, nodding to a different beat, left hand nudging the jog wheel, lips moving slightly as she counts | During a blend between tracks | ✓ |
| L5-build | P2 | she slowly turns the large knob, her bouncing growing, left hand rising and sinking above the decks, tension building | The bars before a drop | |
| L6-peak | P3 | she jumps on every beat with her hands up, waving them, grinning, hair flying | The first bars after a drop | ✓ |

## Transitions (first frame → last frame)

| ID | From → to | Prompt | Use | MVP |
|---|---|---|---|---|
| T1-home-cue | P0 → P1 | she lifts the headphones from her neck and presses the right cup to her ear, tilting her head toward it, left hand moving to the jog wheel | A blend starts | ✓ |
| T2-cue-home | P1 → P0 | she lowers the headphones back around her neck and puts both hands back on the decks, nodding | A blend ends | ✓ |
| T3-home-build | P0 → P2 | she leans in over the mixer and takes hold of the large knob in the middle, her left hand lifting flat above the decks | A build starts | |
| T4-build-peak | P2 → P3 | on the drop she throws both hands up above her head and grins at the camera | The drop after a build | |
| T5-home-peak | P0 → P3 | on the drop she throws both hands up above her head and grins at the camera | A drop without a build | ✓ |
| T6-peak-home | P3 → P0 | she brings her hands down to the decks, still smiling, and settles back into nodding | Coming down after a peak | ✓ |
| T7-build-home | P2 → P0 | she lets go of the knob, straightens up and settles back into nodding with both hands on the decks | A build that fizzles into a breakdown | |

## Flourishes (P0 → P0)

Short one-offs that break up long grooves. Same first and last frame.

| ID | Prompt |
|---|---|
| F1-point | she looks up at the camera, smiles and points at the lens on one beat, then looks back down at the decks |
| F2-fist | she pumps her right fist on four beats, grinning, then puts her hand back on the mixer |
| F3-look | she glances up and around the room, smiles to herself, and looks back down at the decks |

## Totals

| | Poses | Loops | Transitions | Flourishes | Clips |
|---|---|---|---|---|---|
| MVP | 2 new | 3 | 4 | 0 | 7 |
| Full | 3 new | 6 | 7 | 3 | 16 |

At 2–3 takes per clip, the full set is about 40–50 generations. The MVP
should fit in one sitting.

## Order of work

1. Decide on the microphone, then make P1-cue and P3-peak.
2. MVP clips: L2, L4, L6, then T1, T2, T5, T6.
3. Check the MVP in the visualizer.
4. The rest: P2-build, L1, L3, L5, T3, T4, T7, then F1–F3.

## Covered so far by the first takes

The first three takes (not true loops) cover parts of this until the real
clips exist: `grok-18e66b16` frames 20–64 stand in for L2, and the drop and
cue takes stand in for T5+T6 and T1+T2 as boomerangs.
