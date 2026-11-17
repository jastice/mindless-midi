# Claudia DJ: shot list

The clips the booth cam plays, made from the poses in
[PROMPTS.md](PROMPTS.md). Every clip starts on one pose and ends on one
(the same one for loops), so any clip can follow any clip that ends on its
start pose.

## Lengths

Only two lengths, 6 s and 10 s. At 128 BPM a 6.04 s clip plays as **3 bars**
and a 10.04 s clip as **5 bars**, and 3 + 5 = 8, one phrase. Every 8-bar
phrase is therefore 3+5 or 5+3 and ends on a pose, ready for whatever the
music does next. Transitions and flourishes are always 6 s. Loops come in
both lengths; the resting pose needs both.

Never slow a 6 s clip to fill 4 bars: ×0.8 reads as slow motion.

**MVP** marks the 8 clips for a first full version. They need no new poses
(only P0, P2 and P5) and give the prototype what it is missing: a plain
6 s loop at Home and a 10 s loop for blends.

## Loops (first frame = last frame, loop option on)

| ID | Pose | Length | What she does | Plays during | MVP |
|---|---|---|---|---|---|
| L01-home | P0-home | 10 s | Grooves at the mixer: head nodding on every beat, shoulders loose, small knob turns with both hands | The default, mid energy | ✓ |
| L02-home | P0-home | 6 s | The same groove, a different set of knob moves | Fills the 3-bar half of a phrase | ✓ |
| L03-home-low | P0-home | 10 s | Barely moving: small nods, one slow fader move, calm and focused | Intros, breakdowns, low energy | |
| L04-home-high | P0-home | 6 s | Bouncing on every beat, bob swinging, shoulders working, a quick smile | High energy, after a drop | |
| L05-vinyl | P2-vinyl | 10 s | Nudges the record to keep it in time, head bowed and nodding, right hand easing a fader up | A blend between tracks | ✓ |
| L06-cue | P3-cue | 6 s | Holds the cup to her ear, listening, nodding to a different beat, counting under her breath | Checking the incoming track | |
| L07-build | P4-build | 6 s | Finger still pointing up, bouncing harder and faster, turning the filter knob slowly | The bars before a drop | |
| L08-peak | P5-peak | 6 s | Arms up, swaying side to side with the beat, eyes closed, lost in it | The first bars after a drop | ✓ |
| L09-look | P1-look | 6 s | Holds eye contact, nodding with a half smile, hands working the decks | A flourish that stays for a phrase | |

## Transitions (6 s, first frame → last frame)

| ID | From → to | What she does | Plays when | MVP |
|---|---|---|---|---|
| T01-home-vinyl | P0 → P2 | Reaches over and lays her left hand on the record, keeps nodding | A blend starts | ✓ |
| T02-vinyl-home | P2 → P0 | Lets go of the record and brings both hands back to the mixer | A blend ends | ✓ |
| T03-vinyl-cue | P2 → P3 | Lifts her right hand to the headphone cup and presses it to her ear | Mid-blend, checking the incoming track | |
| T04-cue-home | P3 → P0 | Lets go of the cup, both hands back on the mixer, nodding | The blend is done | |
| T05-home-build | P0 → P4 | Grabs the filter knob and slowly raises her left hand, finger pointing up | A build starts | |
| T06-build-peak | P4 → P5 | On the drop throws both arms up, head back, eyes closing | The drop after a build | |
| T07-home-peak | P0 → P5 | On the drop throws both arms up, head back, eyes closing | A drop without a build | ✓ |
| T08-peak-home | P5 → P0 | Brings her arms down slowly, opens her eyes, back to the mixer, nodding | Coming down after a peak | ✓ |
| T09-build-home | P4 → P0 | Lowers her hand, lets go of the knob, settles back to nodding | A build that fizzles into a breakdown | |
| T10-home-look | P0 → P1 | Looks up into the camera with a half smile, one hand moving to the jog wheel | Starting a flourish | |
| T11-look-home | P1 → P0 | Looks back down to the mixer, both hands on it | Ending a flourish | |

## Flourishes (6 s, P0 → P0)

One-offs inside a long groove, never two in a row.

| ID | What she does |
|---|---|
| F01-look | Glances up into the camera with a half smile on one beat, then back down to the mixer |
| F02-fist | Pumps her right fist on four beats, then her hand returns to the mixer |
| F03-sip | Reaches back for the water bottle, takes a sip, puts it back, hands back on the mixer |

F03 moves a prop; check that the bottle ends exactly where it started.

## Totals

| | New poses | Loops | Transitions | Flourishes | Clips |
|---|---|---|---|---|---|
| MVP | 0 | 4 | 4 | 0 | 8 |
| Full | 3 (P1 redo, P3, P4) | 9 | 11 | 3 | 23 |

At 2–3 takes each, the MVP is about 20 generations and the full list about
60.

## Order of work

1. MVP: L01, L02, L05, L08, then T01, T02, T07, T08.
2. Check them in the booth cam prototype.
3. Redo P1-look; make P3-cue and P4-build; check each against P0-home.
4. The rest, in the order L06, T03, T04 (cueing), then L07, T05, T06, T09
   (builds), then L03, L04, the look clips and the flourishes.
