---
type: Code Module
title: src/theory
description: Music theory primitives and the seeded random number generator every musical decision flows from.
resource: ../../../src/theory
tags: [module, music-theory, determinism]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# src/theory

Bazel target `//src/theory`, test `//src/theory:theory_test`.

| File | Role |
| --- | --- |
| `rng.ts` | sfc32 PRNG with helpers. `fork(label)` derives an independent stream so adding a decision in one part of the arranger doesn't reshuffle every other part. |
| `seed.ts` | Human-friendly session seeds made of three music words, e.g. `mellow-tritone-waltz`. Any string works as a seed; this only makes generated ones readable. |
| `theory.ts` | Pitch classes, modes, roman-numeral chord parsing, chord-scales, scale-degree arithmetic, voice-leading. |

## Conventions (from `theory.ts`)

- Pitch classes are integers 0..11 with C = 0.
- Intervals are semitones.
- MIDI note 60 is C4.

Used by the [engine](./engine.md) for every choice and by the
[corpus validator](./corpus.md) for parsing chord symbols. Why `fork` matters:
[determinism and seeds](../concepts/determinism-and-seeds.md).
