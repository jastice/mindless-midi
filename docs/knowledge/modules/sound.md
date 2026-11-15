---
type: Code Module
title: src/sound
description: The stem-based sound engines (DSP synths, sampler, FM-through-bus), the per-style mix bus and weight stage, levelers, and the worker/worklet that stream stems.
resource: ../../../src/sound
tags: [module, audio, synthesis, mixing]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# src/sound

Bazel targets `//src/sound`, `:worker`, `:render_worker`, `:stem_worklet`;
tests `:sampler_test`, `:weight_test`.

## Pipeline

Main thread ([player](../apps/mindless-midi.md)) → `worker.ts` renders each
role's audio per bar → per-role levelling and `weight.ts` → streamed through a
MessagePort to `stem_worklet.ts` (one stereo output per role) → `bus.ts` (Web
Audio graph) → speakers.

## Files

| File | Role |
| --- | --- |
| `synth.ts` | "Approach 1": hand-written synthesis, no downloads. Modal piano, FM e-piano, modal mallets, Karplus-Strong plucks, PolyBLEP subtractive voices, analog-style kit. Renders a whole note at once. |
| `sampler.ts` | "Approach 2": multi-sampled instruments from SFZ libraries and GM soundfonts, per-style drum kits (`sample_kit`, carried in the bundle). `SampleLibrary` (main thread, downloads/decodes) is split from playback (worker). |
| `bus.ts` | Per-style mix bus: high-pass, chorus, kick ducking, pan, ping-pong delay and reverb sends; master tape/vinyl, glue compression, limiter. Style changes are scheduled AudioParam changes so they land on a piece boundary. |
| `weight.ts` | Stem-level "weight" before the bus: driven kick, envelope-following ducking, driven bass kept out of the kick's octave, parallel drum compression, mono low end. |
| `leveler.ts` | `RoleLeveler`: causal per-stem loudness matching to a role target. |
| `body_leveler.ts` | Level matching that corrects instrument loudness without following the performance, so hits and dynamics survive. |
| `shape.ts` | Applies [gesture](../concepts/gestures.md) curves (bend as read speed, swell as gain) to notes that render all at once. |
| `measure.ts` | Weight metrics: crest, short-term level range, sub/low-mid energy share, low-end stereo correlation. Asserted in `weight.test.ts`. |
| `dsp.ts` | Small allocation-free DSP blocks. |
| `score.ts`, `types.ts` | A bar as the stem engines see it: notes in seconds with the program sounding. |
| `protocol.ts` | Messages between main thread, worker and worklet; defines `Engine = "fm" \| "fm_bus" \| "synth" \| "samples"`. |
| `worker.ts`, `stem_worklet.ts` | Render worker and the worklet that plays its stems; the worklet ticks the main thread like the OPL processor. |

Engine overview: [sound engines](../concepts/sound-engines.md). Background and
measurements: [heavier sound plan](../plans/heavier-sound.md). Where samples
come from: [samples](../build/samples.md).
