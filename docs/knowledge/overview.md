---
type: Project Overview
title: Mindless Midi
description: Endless, never-repeating background music arranged and synthesized live in a browser tab from LLM-written style corpora.
tags: [overview, start-here]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../README.md
    title: README
---

# Mindless Midi

Endless background music in a browser tab. A listener picks one or more
[styles](./concepts/styles-and-corpora.md) (Lo-fi Hip Hop, Metroid Vibes, Jazz
Piano Trio, Baroque Court and so on, 22 in all) and the page plays forever
without repeating and without streaming audio: every note is arranged and
synthesized in the page.[^readme] Live at https://mindless-midi.pages.dev/.

## The idea in three layers

1. **LLM-seeded material.** Each style has a checked-in *corpus*
   (`styles/<id>/corpus.json`): chord progressions, motifs, ostinatos, comping
   rhythms, drum grooves, song forms, instrumentation. Claude, Astra and Grok
   wrote them from a prose brief. Because they are checked in, builds are
   hermetic and need no API key. See [styles and corpora](./concepts/styles-and-corpora.md).
2. **Algorithmic arrangement.** In the browser, a seeded arranger
   ([engine](./modules/engine.md)) picks key, tempo and form for each piece,
   develops motifs, voice-leads chords, swings, humanizes and rotates between
   the selected styles. Same seed, same music: see
   [determinism and seeds](./concepts/determinism-and-seeds.md).
3. **Still MIDI, played well.** The arranger writes plain MIDI (notes,
   velocities, program changes, pitch bend, CC11). Several
   [sound engines](./concepts/sound-engines.md) can play it: modelled synths,
   downloaded samples, or an OPL3 FM chip emulation. **Save MIDI** downloads
   exactly what was played.

## Where things are

- The pages: [Mindless Midi](./apps/mindless-midi.md), its weightier sibling
  [Mighty Midi](./apps/mighty-midi.md), and the [synthesis bench](./apps/bench.md).
- Code: [modules](./modules/index.md) under `src/`, build-time
  [tools](./build/tools.md) under `tools/`, custom
  [Bazel rules](./build/bazel-rules.md) under `bazel/`.
- Everything builds, tests, serves and deploys through Bazel:
  [local development](./guides/local-development.md).

## Data flow

`brief.md` → (Claude, via `//styles:regen`) → `corpus.json` → (`music_style`
rule: validate, calibrate loudness) → `styles.json` + sample files → browser:
[conductor](./modules/engine.md) → bars of MIDI → [player](./apps/mindless-midi.md)
→ a [sound engine](./concepts/sound-engines.md) → speakers.
The diagram in `docs/architecture.svg` shows the same pipeline.

[^readme]: README
