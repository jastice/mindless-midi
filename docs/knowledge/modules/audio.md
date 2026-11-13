---
type: Code Module
title: src/audio
description: The FM chip path; a sample-accurate event queue and output leveler shared by the libADLMIDI AudioWorklet and the offline Node renderer.
resource: ../../../src/audio
tags: [module, audio, fm, opl3]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# src/audio

Bazel targets `//src/audio:events`, `:processor`, `:worklet`; tests
`:events_test`, `:leveler_test`.

| File | Role |
| --- | --- |
| `events.ts` | Sample-accurate synth events, shared by the worklet (live) and the Node renderer (offline tests and `tools/render`), so both play the same. |
| `processor.ts` | AudioWorklet: libADLMIDI (Nuked OPL3 emulation, WASM) driven by the event queue; the main thread sends timestamped events a few seconds ahead. Ticks the main thread to drive scheduling. |
| `leveler.ts` | Output stage: the style's calibrated gain, slow ±6 dB auto-gain, soft limiter. |
| `protocol.ts` | Main thread ↔ worklet messages. |
| `adlmidi_wasm.d.ts` | Typings for the parts of libADLMIDI's Emscripten module used. |

The FM path uses 4 emulated OPL3 chips (72 two-operator voices) at roughly 4%
of one core, and renders about 25× realtime offline. Each style picks an FM
patch bank (see [Bazel rules](../build/bazel-rules.md)). The other engines are
in [src/sound](./sound.md); the choice between them is described in
[sound engines](../concepts/sound-engines.md).
