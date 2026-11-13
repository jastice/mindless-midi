---
type: Web App
title: Mighty Midi
description: A second front end in src/mighty that plays the same seeded music for weight (velocity tone, gestures, kick-driven low-end mix) with a stage visualization.
tags: [app, frontend, sound]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: plan
    resource: ../../beyond-midi-plan.md
    title: "Heavier sound: plan"
---

# Mighty Midi

Code in `src/mighty/`. Run it with `bazel run //src/mighty:serve`
(http://localhost:8081). It has its own site target (`//src/mighty:site`) and
deploy target (`//src/mighty:deploy`, pushing to a `mighty-pages` branch).

It shares the arranger, corpora and engines with
[Mindless Midi](./mindless-midi.md), reusing its `Player`. What differs is
how notes are performed (wider velocity range, [gestures](../concepts/gestures.md):
slides, swells, accents, chokes) and mixed (the [weight](../modules/sound.md)
stage: kick-driven, low-end-aware, dynamics kept). Everything it adds still
fits in a MIDI file, so the download is the piece.

Mighty Midi was the testbed for phases 0 to 3 of the
[heavier sound plan](../plans/heavier-sound.md); Mindless Midi has since turned
the same options on by default.[^plan]

## Files

| File | Role |
| --- | --- |
| `app.ts` | Page wiring for the weighted performance. |
| `stage.ts` | The score as blocks of light: brightness is velocity, colour is part; slides lean, swells open like wedges, accents get caps, choked hats a stop, kicks thump the floor. |
| `index.html`, `styles.css`, `favicon.svg` | Page shell. Fonts come from `//src/app:fonts`. |

[^plan]: Heavier sound: plan
