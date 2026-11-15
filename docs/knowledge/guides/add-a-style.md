---
type: Guide
title: Add a style
description: Steps to add a new musical style, from writing its brief to registering it in the style pack.
tags: [guide, styles]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: README
---

# Add a style

1. Create `styles/<id>/brief.md` describing the music (look at an existing
   brief for tone and detail).
2. Generate the corpus: `bazel run //styles:regen -- styles/<id>`
   ([regenerate a style](./regenerate-style.md)).
3. Add `styles/<id>/BUILD.bazel` by copying another style's. Pick an FM
   `bank` (libADLMIDI embedded bank number, e.g. 1 = Bisqwit, 14 = Doom's
   Bobby Prince set, 58 = The Fat Man, 68 = Nguyen/Wohlstand 4-op GM,
   72 = DMXOPL3) and a UI `color`. Give it a drum kit: a `sample_kit` passed
   as `kit = ":kit"` (copy one; every style needs one, since the ending plays
   kick, crash and low tom).
4. Check calibration:
   `bazel build //styles/<id>:style --output_groups=+calibration`. An
   instrument stuck at CC7 127 is too quiet in that bank.
5. Add the id to `STYLES` in `styles/BUILD.bazel`.
6. Build `//styles:samples`. It fails if the style's ranges reach sample packs
   it does not declare, and prints the `packs = [...]` labels to add to its
   `music_style` ([samples](../build/samples.md)).
7. `bazel test //...`, serve, listen.[^readme]

Background: [styles and corpora](../concepts/styles-and-corpora.md).

[^readme]: README
