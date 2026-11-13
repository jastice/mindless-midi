---
type: Concept
title: Styles and corpora
description: A style is a prose brief plus an LLM-written JSON corpus of musical material, compiled and loudness-calibrated by Bazel; this page explains the pipeline and lists every style.
resource: ../../../styles
tags: [styles, corpus, pipeline, catalog]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: README
---

# Styles and corpora

Each style lives in `styles/<id>/`:

| File | Role |
| --- | --- |
| `brief.md` | Prose description of the music: the input to generation. |
| `corpus.json` | The material, conforming to the [corpus schema](../modules/corpus.md). Checked in, so builds need no API key. |
| `BUILD.bazel` | A `music_style` target with the FM `bank` and UI `color`, plus a `corpus` copy for tests. |

`styles/BUILD.bazel` holds the `STYLES` list, the `style_pack` that merges
them into the `styles.json` the app fetches, `style_samples` (see
[samples](../build/samples.md)) and the `regen` alias.

## Pipeline

1. **Write** `brief.md`.
2. **Generate** with `bazel run //styles:regen -- styles/<id>`
   ([guide](../guides/regenerate-style.md)): Claude returns structured JSON
   against the schema, the build's validator checks it, errors are fed back for
   up to two repair rounds.
3. **Compile** at build time with `music_style` → `tools/stylec`: validate (an
   invalid corpus fails the build), attach bank and colour, and calibrate
   per-instrument CC7 levels and a style gain by rendering through the FM synth.
4. **Pack** into `styles.json` and fetch samples.
5. **Play**: the [engine](../modules/engine.md) recombines the material endlessly.

The original eighteen corpora were written by Claude (Opus 5.5) during
development; Astra added Orbital Glass and Midnight Platform; Grok added
Courtyard Nine and Low Log.[^readme]

# Catalog

| id | Title | FM bank |
| --- | --- | --- |
| `metroid` | Metroid Vibes | 14 |
| `retro` | Retro Games | 58 |
| `lofi` | Lo-fi Hip Hop | 72 |
| `jazz_trio` | Jazz Piano Trio | 68 |
| `minimalist` | Minimalist Piano | 72 |
| `monkey_island` | Monkey Island Vibes | 1 |
| `electro_swing` | Electro Swing | 72 |
| `synthwave` | Synthwave | 68 |
| `bossa_nova` | Bossa Nova | 72 |
| `funk` | 70s Funk | 72 |
| `western` | Spaghetti Western | 68 |
| `celtic` | Celtic Tavern (jigs in 6/8) | 1 |
| `musette` | Café Musette (3/4 valse) | 68 |
| `liquid_dnb` | Liquid Drum & Bass | 68 |
| `castlevania` | Castlevania Vibes | 68 |
| `jrpg` | 16-bit JRPG | 68 |
| `disco` | Mirrorball Disco | 68 |
| `baroque` | Baroque Court (trills, ritardando, Picardy third) | 68 |
| `orbital_glass` | Orbital Glass (7/4 as 2+2+3) | 68 |
| `midnight_platform` | Midnight Platform (5/4 as 3+2 jazz quintet) | 68 |
| `courtyard_nine` | Courtyard Nine (9/8 aksak 2+2+2+3, double harmonic) | 68 |
| `low_log` | Low Log (4/4, the tune is in the bass) | 68 |

Some forms are *areas* (e.g. Metroid's Crateria, Brinstar, Norfair) with their
own tempo, keys and instrument swaps, using material tagged with the same
palette. To add a style: [add a style](../guides/add-a-style.md).

[^readme]: README
