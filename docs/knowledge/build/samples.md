---
type: Build Pipeline
title: Samples
description: How the Samples engine's recordings are declared per style, fetched at build time, pinned by sha256 in styles/samples.lock.json, and served from the site itself.
resource: ../../../styles/samples.lock.json
tags: [samples, build, licensing]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: README
---

# Samples

1. Each style's [sound declaration](../modules/corpus.md) (`src/corpus/sound.ts`,
   emitted as `sound.json` by `music_style`) lists the instruments it can play
   and their key ranges.
2. `style_samples` (`//styles:samples`) runs `tools/samples`, which works out
   exactly which upstream files those need and downloads them. The action needs
   network access and reruns only when a declaration changes.
3. Files are pinned by sha256 in `styles/samples.lock.json`; a changed or
   unlisted file fails the build. `bazel run //styles:samples_lock` refreshes
   the pin after a style or upstream change. `--output_groups=+report` lists the files.
4. The site serves them under `samples/`, so the page makes no requests to
   other hosts. A listener downloads only the slice a piece needs.

About 2,800 files, 92 MB for all styles. Not checked in.[^readme]

## Sources and licences

From [danigb/samples](https://github.com/danigb/samples) and
[gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts):
Splendid Grand Piano (public domain), VCSL (CC0), D. Smolken double bass
(CC0), Greg Sullivan's Wurlitzer (CC BY 3.0), MusyngKite (CC BY-SA 3.0),
drum-machine and Sonic Pi kits. The page credits whatever it has played. For
every source considered, used or not, see [Sample sources](./sample-sources.md). The
[bench](../apps/bench.md) still streams from upstream.

[^readme]: README
