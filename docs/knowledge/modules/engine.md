---
type: Code Module
title: src/engine
description: The deterministic in-browser arranger that turns corpora and a seed into an endless stream of MIDI bars.
resource: ../../../src/engine
tags: [module, arranger, determinism, midi]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# src/engine

Bazel target `//src/engine`, test `//src/engine:engine_test`. Pure and
deterministic: the same seed and style selection always yield the same music
(see [determinism and seeds](../concepts/determinism-and-seeds.md)).

| File | Role |
| --- | --- |
| `conductor.ts` | `Conductor` strings pieces together forever, choosing a style for each from the selection. Supports `seek` to a piece/segment (capped so a hand-edited link can't hang the tab). |
| `piece.ts` | `Piece`: one style, key, tempo and form, a few minutes long. Plans up front (key, tempo, form, repeats, orchestration changes, section intensity), renders lazily bar by bar, applies swing and humanization. |
| `parts.ts` | Part writers: drums, ostinatos, chords (voice-led), and developed melodies (sequence, inversion, mutation, cadences). Times are bar-relative beats. |
| `harmony.ts` | A progression looped over the length of a section. |
| `gestures.ts` | Slides, swells, accents, chokes, as curves on notes that become pitch bend and CC11 events. See [gestures](../concepts/gestures.md). |
| `midi_file.ts` | Standard MIDI File (format 0) writer behind the **Save MIDI** button. |
| `types.ts` | `NoteEvent`, `NoteCurve`, the role→MIDI channel map (lead 0 … bass 5, drums 9). |

## Flow

Corpora (from `styles.json`) → `Conductor` → `Piece.plan` → per bar
`parts.ts` writers → swing/humanize → bar of notes and control events →
the [player](../apps/mindless-midi.md), which hands them to the
[FM path](./audio.md) or the [stem engines](./sound.md).
