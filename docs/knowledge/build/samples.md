---
type: Build Pipeline
title: Samples
description: How the Samples engine's recordings come from checked-in, hash-pinned sample packs, which pack plays each program, how a style declares its packs, and how an offline action trims what the site serves and checks the declared ranges.
resource: ../../../samples/instruments.json
tags: [samples, build, licensing]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-14T00:00:00Z }
sources:
  - id: plan
    resource: ../../sample-format-plan.md
    title: Sample packs plan
---

# Samples

Every recording the Samples engine plays comes from a **sample pack**: a
checked-in manifest, `samples/<source>/<pack>/pack.json`, typed and validated
by `src/corpus/pack.ts`. A manifest pins its files to an upstream commit, with
a URL, sha256 and size each, and carries a mandatory licence block. See
[the sample pack plan](../../sample-format-plan.md) for the design.

- **One-shots** (`kind: "oneshots"`): drum hits, one per sample id.
- **Multisamples** (`kind: "multisample"`): one instrument. `samples` lists its
  files; `regions` are the flattened SFZ regions (key and velocity range, root,
  tune, volume, offset, crossfades, round robin, loop), each naming a sample.
  `source` pins the upstream document they were generated from.

## Which pack plays a program

`samples/instruments.json` maps each General MIDI program to a pack per
soundfont (`MusyngKite`, `FluidR3_GM`), with its release, sustain and whether
it is flat (one recording per note). SFZ libraries (Splendid piano, Wurlitzer,
VCSL vibraphone, marimba and tenor sax, Smolken bass) play the same in both
fonts; every other program has a soundfont group per font,
`gleitz-musyngkite/<name>` and `gleitz-fluidr3-gm/<name>`. The jRhodes Rhodes
(CC BY-NC 4.0) is a pack no program plays yet. A program the table
does not list plays nothing, and a style cannot declare it. The sampler
(`src/sound/sampler.ts`) and the Bazel extension both read the table.

## Build

1. The `samples` extension (`//bazel:samples.bzl`) loads the table and every
   pack it names, plus the drum packs `MODULE.bazel` lists. It declares one
   `http_file` per one-shot and one repository per multisample that downloads
   all its files at once (`ctx.download`, each checked against its hash), and
   the `@samples` labels: `@samples//<pack id>:<sample id>` and
   `@samples//<pack id>` for a whole pack.
2. Each style names the packs its instruments play in
   `music_style(packs = [...])`, and its drum kit in `kit`: a `sample_kit` in
   the same BUILD file, mapping General MIDI keys to `@samples` labels. A hit
   is a label or `{"default", "hard", "soft"}`; with touch, a hard hit plays
   the hard recording and a light one the soft (the Sonic Pi kits' hard and
   soft drums). Key aliases (35 as 36, 40 as 38, ...) default to the GM ones
   whose target the kit has. Every style needs a kit: each declares at least
   the ending's kick, crash and low tom. Its
   [sound declaration](../modules/corpus.md) (`sound.json`) lists the
   instruments and key ranges it can play.
3. `style_samples` (`//styles:samples`, `//styles:claudia_samples`) is offline.
   It runs the sampler's own `reach()` over each style's declared ranges,
   against the manifests, and copies only the files that can sound into
   `samples/` (each at `<pack id>/<sample id>.<ext>`, every touch variant of
   every reachable drum key included), with the table, the used manifests and
   `credits.json`, one entry per pack from its licence block. If a
   range reaches a pack the style does not declare, it fails and names the
   style, part, keys and pack, with the labels to add.
   `--output_groups=+report` lists the files.
4. The site serves them under `samples/`, so the page makes no requests to
   other hosts. A listener downloads only the slice a piece needs. The dev
   servers (`bazel run //site:serve` and the others) serve `samples/` from the
   `superset` output group instead: every file of every declared pack.

About 2,900 files, 95 MB for all styles; the declared superset is 6,500 files,
175 MB. Not checked in. CI keeps the downloads in its Bazel repository cache.

## Adding or bumping a pack

`bazel run //tools/packs -- <source> ...` writes a manifest from upstream at a
commit (default: the branch head) and hashes every file:

- `sampled` and `samples`: one-shots from danigb/sampled and danigb/samples.
- `websfz <document> <pack id> [--sample-path DIR]`: an SFZ instrument from a
  danigb/samples websfz document. Where only the case of a file name differs
  (the Splendid piano's `MF-` and the hosted `Mf-`), the hosted name wins.
- `gm <font> <program>...`: soundfont programs from gleitz/midi-js-soundfonts.

The licence block and description are kept from an existing manifest; a new
pack gets a placeholder that fails validation until someone reads the source's
terms. Free, non-commercial, public-domain and "free to use" terms are all
accepted ([Sample sources](./sample-sources.md) says how). After a new
instrument, add it to `samples/instruments.json`; `//tools/packs:zones_test`
then checks, key by key, that it plays what the upstream document did.

## Sources and licences

From [danigb/samples](https://github.com/danigb/samples),
[danigb/sampled](https://github.com/danigb/sampled) and
[gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts):
Splendid Grand Piano (public domain), VCSL (CC0), D. Smolken double bass
(CC0), Greg Sullivan's Wurlitzer (CC BY 3.0), MusyngKite (CC BY-SA 3.0),
FluidR3 (CC BY 3.0), drum-machine and Sonic Pi kits. Each pack's licence block
says what its source states. The page reads `samples/credits.json` and shows
one line per credit among the packs it has played (a soundfont's programs
share one).
For every source considered, used or not, see
[Sample sources](./sample-sources.md). The [bench](../apps/bench.md) serves
the table and manifests itself and streams the audio from each manifest's
pinned upstream URL.
