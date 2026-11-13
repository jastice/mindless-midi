---
type: Web App
title: Synthesis bench
description: A developer page in src/bench that renders one score through every engine offline, loudness-matches them, and lets you A/B them (optionally blind).
tags: [app, tooling, sound, measurement]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: README
---

# Synthesis bench

Run with `bazel run //src/bench:serve` (http://localhost:8090). CI deploys it
as a separate Cloudflare Pages project, `<project>-bench`; `bazel run
//src/bench:deploy` publishes it to a `bench-pages` branch by hand.[^readme]

It renders the same score through: FM as shipped, FM through the mix bus, DSP
synths, samples, and samples with an experimental Magenta DDSP neural lead.
Every variant is brought to the same integrated loudness so "louder" never
wins, then they can be compared at the same playhead with per-instrument solos
and a spectrogram.

## Files

| File | Role |
| --- | --- |
| `bench.ts` | Page: render variants, A/B (blind) switching. |
| `score.ts` | Flattens the engine's bars for one style and seed into absolute-time notes, the common input to every backend. |
| `opl.ts` | Baseline: the shipping OPL3 path rendered on the main thread, full mix or one role per stem. |
| `samples.ts` | Offline sampled stems via the app's sampler. |
| `neural.ts` | Magenta DDSP (violin, flute, tenor sax, trumpet) on TensorFlow.js/WebGL for the melody. |
| `loudness.ts` | ITU-R BS.1770 gated loudness matching and peak limiting. |
| `analysis.ts` | Spectrogram rendering. |

Unlike the main site, the bench streams samples from upstream hosts rather
than serving its own copies. See [sound engines](../concepts/sound-engines.md)
and the [sound module](../modules/sound.md).

[^readme]: README
