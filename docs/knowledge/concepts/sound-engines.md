---
type: Concept
title: Sound engines
description: The ways the same MIDI can be turned into audio (Synth, Samples, FM chip, and FM through the bus), where each lives and how they differ.
tags: [sound, engines, architecture]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: README
---

# Sound engines

The arranger only writes MIDI. An engine turns it into sound. The type is
`Engine = "fm" | "fm_bus" | "synth" | "samples"` in `src/sound/protocol.ts`.

| Engine | In the page as | Where | Path |
| --- | --- | --- | --- |
| `synth` | Synth (default) | `src/sound/synth.ts` | Modelled instruments, nothing to download. Stems rendered in a worker → stem worklet → mix bus. |
| `samples` | Samples | `src/sound/sampler.ts` | Recorded instruments downloaded on demand from the site's own `samples/`. Same stem path. |
| `fm` | FM chip | `src/audio/` | Events to libADLMIDI (Nuked OPL3, WASM) in an AudioWorklet with DOS-era patch banks; output through `audio/leveler.ts`, no bus. |
| `fm_bus` | (bench) | `src/sound/worker.ts` | OPL3 rendered per role as stems and sent through the mix bus. |

For the stem engines, velocity shapes tone and stems are mixed through a
per-style studio bus (kick ducking, drive on kick and bass, parallel drum
compression, mono low end, reverb, echo, tape) with a leveller that keeps
quiet sections quiet.[^readme] Details: [sound module](../modules/sound.md).

The listener's choice is part of the [URL session](./url-session.md)
(`sound=`, omitted for the default). Each engine is also an "edition" of the
page, with its own look keyed on `data-engine` in `src/app/styles.css`.

Comparing engines side by side: [synthesis bench](../apps/bench.md).

[^readme]: README
