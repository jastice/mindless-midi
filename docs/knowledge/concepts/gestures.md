---
type: Concept
title: Gestures
description: How a note is played beyond pitch, length and velocity (slide, swell, accent, choke), expressed only with per-channel MIDI so the .mid download stays the piece.
tags: [gestures, midi, performance]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# Gestures

Defined in `src/engine/gestures.ts`, with the names in
`src/corpus/constants.ts`.

| Gesture | MIDI expression |
| --- | --- |
| slide | pitch bend into the note from the one before |
| swell | expression (CC11) rising across a long note |
| accent | velocity |
| choke | where the note stops (an open hi-hat closed by the next hit) |

A gesture is stored on a `NoteEvent` as a curve (`NoteCurve`, breakpoints in
beats). The same curve becomes the channel's bend and CC11 events for the FM
engine and the MIDI file, and is applied directly to the rendered note by
`src/sound/shape.ts` for the stem engines, which render a note all at once.

Gestures came in as phase 3 of the [heavier sound plan](../plans/heavier-sound.md)
and are drawn explicitly by [Mighty Midi's stage](../apps/mighty-midi.md).
