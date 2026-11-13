---
type: Guide
title: Render offline
description: Render generated music to WAV (and MIDI) from the command line through the FM path in Node.
tags: [guide, render, cli]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# Render offline

# Examples

```bash
bazel run //tools/render -- --styles lofi,jazz_trio --seconds 120 --out /tmp/mix.wav --midi /tmp/mix.mid
```

Options (from `tools/render/render.ts`): `--styles`, `--seconds`, `--out`,
`--seed <s>`, `--midi <path>`, `--raw 1` (skip the gain/AGC/limiter stage the
browser applies).

This renders with the [FM engine](../modules/audio.md) only. To hear or compare
the Synth and Samples engines, use the browser or the
[synthesis bench](../apps/bench.md).
