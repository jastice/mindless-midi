---
type: Code Module
title: src/corpus
description: The zod schema for a style corpus (which doubles as the LLM authoring guide), its structural and musical validator, and the per-style sound declaration.
resource: ../../../src/corpus
tags: [module, schema, styles]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# src/corpus

Bazel target `//src/corpus`, test `//src/corpus:validate_test` (validates every
checked-in corpus).

| File | Role |
| --- | --- |
| `schema.ts` | The corpus schema (zod). Field `.describe()` texts are sent to Claude as part of the JSON schema, so they double as the authoring guide: keep them precise. |
| `validate.ts` | Structural (zod) plus musical validation. Used by the build (a broken corpus fails it) and by the generator, which feeds errors back to Claude for repair. |
| `sound.ts` | What a style needs to be played: instruments that can sound and the key range of each part. The arranger takes registers from here; the build derives each style's `sound.json` from it to fetch exactly the reachable sample notes; a test holds the arranger to these bounds. |
| `constants.ts` | Vocabulary needed at runtime without zod, e.g. the [gesture](../concepts/gestures.md) names. |

# Schema

Top-level fields of a corpus (see `schema.ts` for the full descriptions):

| Field | Meaning |
| --- | --- |
| `title`, `description` | Display name and a one- or two-sentence blurb shown in the UI. |
| `tempo` | BPM range `{ min, max }`. |
| `beatsPerBar`, `beatGroups` | Meter; optional beat groups give additive meters such as 2+2+3. |
| `swingUnit` | `8th` or `16th`. |
| `keys` | Candidate keys. |
| `instruments` | Per role: name, GM `program`, octave, pan, volume. |
| `progressions` | Chord loops (roman-numeral symbols with beat lengths) with a mood. |
| `motifs` | Melodic/bass/arp patterns for `lead`, `counter`, `arp`, `bass`; notes are scale degrees with onsets and durations. |
| `comping` | Chord rhythm patterns for `pad` and `comp`, with voicing (close, open, shell, spread, power, rootless, triad) and strum. |
| `drums` | Grooves and fills on a step grid. |
| `forms` | Song forms: sections (label, bars, roles, progression), optionally *areas* with their own palette, tempo, keys and instrument swaps. |
| melody rules | Lead range, phrase length, ornament chance, optional `trill` chance on long notes. |
| ending | Optional `picardy` (minor piece ends major) and `ritardando` into the final chord. |

Roles are `lead`, `counter`, `arp`, `pad`, `comp`, `bass`, `drums`; each has
a fixed MIDI channel (drums on GM channel 10).

How corpora are written and compiled: [styles and corpora](../concepts/styles-and-corpora.md).
