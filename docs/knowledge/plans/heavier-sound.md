---
type: Design Plan
title: Heavier sound
description: Pointer to and summary of docs/beyond-midi-plan.md, the phased plan for weightier sound; phases 0 to 3 are built and on by default, phase 4 is not started.
resource: ../../beyond-midi-plan.md
tags: [plan, sound, mixing]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: plan
    resource: ../../beyond-midi-plan.md
    title: "Heavier sound: plan"
---

# Heavier sound

The full plan is [docs/beyond-midi-plan.md](../../beyond-midi-plan.md). It
has a table of what the code did before, per-phase "Built" notes with
measurements, a backlog, decisions and open questions.[^plan]

| Phase | Status | Gist | Code |
| --- | --- | --- | --- |
| 0 Measure | partly done | Weight metrics asserted in tests; not yet in the bench or `tools/render` | `src/sound/measure.ts`, `weight.test.ts` |
| 1 Peaks and low end | done | Let peaks through, give the low end a floor | `src/sound/weight.ts`, `body_leveler.ts`, `bus.ts` |
| 2 Velocity changes the sound | done | Velocity shapes tone, not only level | `src/sound/synth.ts`, `sampler.ts` |
| 3 Named gestures | done | Slides, swells, accents, chokes in one MIDI channel | [gestures](../concepts/gestures.md) |
| 4 The break | not started | Bars containing audio that is not a note; the MIDI file stops being the whole piece | — |

Through phase 3 the score, seed, corpora and `.mid` download are unchanged.
[Mighty Midi](../apps/mighty-midi.md) was built to turn all of it on;
[Mindless Midi](../apps/mindless-midi.md) now does too, with Synth as default.

[^plan]: Heavier sound: plan
