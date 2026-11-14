# Sample packs: a unified format and Bazel dependencies

Built so far: steps 1 and 2 (2026-11-14), see "Built" under each. Written
against `main` at `c6cbd10`. Step 3 is not tried yet; see "To verify before
starting" for what steps 1 and 2 settled.

Sizes are rough: S is a day or two, M about a week, L several weeks.

## Why

Samples reach the build and the page in an ad hoc way:

- A sample is named by its **upstream URL**. `src/sound/sampler.ts` hard-codes
  the two prefixes it mirrors (`danigb/`, `gleitz/`).
- Drum kits are a TypeScript table (`KITS`) keyed by style id.
- Licences are prose in `docs/knowledge/build/sample-sources.md` and in a few
  code comments. Nothing checks that a source has one.
- Integrity is a lock file per app (`styles/samples.lock.json`,
  `claudia_samples.lock.json`) written by a refresh step.
- Fetching is one network-using action (`tools/samples`, 16 requests at a time)
  that works out which files a style needs by downloading each instrument's
  region document and filtering by the style's key ranges.
- URLs point at live GitHub Pages sites, so upstream can change under the pin.

The goal is one format for every sample source, each sample or group
addressable as a Bazel label, fetched lazily and hash-pinned to an upstream
commit, with the licence carried by the data.

CAS (content-addressed storage of samples outside the upstream hosts) is out of
scope here. Pinning by sha256 keeps that door open.

## Decided

- **One manifest per pack**, checked in, `samples/<source>/<pack>/pack.json`.
  Every source is converted to it once, by a generator run by hand. The app and
  the build never read upstream's `dm.json`, websfz document or `names.json`
  after that.
- **Commit pinning.** A pack records its upstream repo and commit; file URLs are
  built from them (for danigb/samples,
  `https://raw.githubusercontent.com/danigb/samples/<commit>/audio/<path>`).
  Bumping a pack means a new commit and a generator run, and the hash check
  flags any file that changed.
- **Granularity.** One Bazel target per sample for one-shots (drum hits, which
  kits name individually). One group per instrument for multisamples (a piano's
  196 files are never referenced one by one).
- **Bazel depends on a static superset; the shipped site is a trimmed slice.**
  A style's `BUILD` names the packs or instrument groups it uses, and all of
  those are fetched. A packaging action (no network) reads the style's
  `sound.json` and the manifests and copies only the files the key ranges can
  reach into `samples/`. The superset is the cost of fetching, the slice is
  what ships.
- **A check replaces discovery.** If a style's declared key range reaches a
  region outside the packs it depends on, the action fails and names the style,
  the key and the pack. The BUILD file stays authoritative; a corpus change
  cannot silently drop a sample.
- **Keep each file's original codec** (wav, m4a, ogg). Hashes then match
  upstream. Transcoding to one codec belongs with the CAS work.
- **Licence is mandatory data.** Packs without a licence block fail validation.
  The credits the page shows are generated from it.
- **Licence policy:** a source counts when it states its terms itself. Accepted
  for this project as general policy (decided 2026-11-14): free licences,
  non-commercial licences (CC BY-NC and the like), public domain and
  "public domain or similar" claims, and "free to use" or "royalty free"
  declarations. Attribution and share-alike terms are carried in the licence
  block and the credits. The catalogue records what each source actually says.
- **Choosing an instrument is data.** Which pack plays a GM program (today the
  `instrumentFor` switch in `sampler.ts`, with the gleitz soundfont as the
  fallback for every other program) becomes a checked-in table next to the
  manifests. The runtime and the Bazel rules both read it, so a style's BUILD
  and what the page actually loads cannot drift apart. The GM fallback is an
  explicit group per program and font, not an implicit "anything else".
  Instrument labels ("VCSL marimba (CC0)") come from the licence block, not
  from strings in code.
- **One implementation of "which files can sound".** The trim action and the
  reach check run the same TypeScript `required()` the runtime uses (as
  `requiredSamples` does today), pointed at the manifests and the fetched files
  instead of upstream. No second version in Starlark.
- **Kits carry their velocity variants and key aliases.** Touch swaps soft and
  hard Sonic Pi hits (`HARD_SOFT`), and `required()` does not list the swapped
  file today; this only works because the shipped set is the union of every
  kit. Once the shipped set is trimmed, a kit has to declare its variants
  (`{"default", "hard", "soft"}` per key) and the drum key aliases (35→36,
  40→38, …), and the trim takes all of them.

## The format

```json
{
  "id": "danigb-sampled/tr909-detroit",
  "kind": "oneshots",
  "origin": {
    "repo": "danigb/sampled",
    "commit": "<40-hex>",
    "path": "DM/TR-909/Detroit/samples/"
  },
  "licence": {
    "spdx": "LicenseRef-public-domain-claimed",
    "note": "The repo claims public domain or similar; accepted 2026-11-14.",
    "attribution": null,
    "share_alike": false,
    "read_on": "2026-11-14"
  },
  "samples": {
    "kick": { "file": "kick.wav", "sha256": "...", "bytes": 0, "tags": ["kick"], "gm": 36 },
    "hihat-open-1": { "file": "hihat-open-1.wav", "sha256": "...", "bytes": 0, "tags": ["hat", "open"], "gm": 46 }
  }
}
```

- `kind: "oneshots"` has `samples` keyed by a stable id. `gm` is the General MIDI
  percussion key the sample is the natural default for; kits may override it.
- `kind: "multisample"` has `regions` instead of `gm`. The generator resolves
  websfz global, group and region opcodes (and a `<control>`
  `prefix_sfz_path`, which applies to every later group) into flat regions,
  each with everything `loadSfz` in `sampler.ts` reads today:
  - `file`, `root`, `lo`, `hi`, `vel: [lo, hi]`;
  - `tune` in cents (`tune` + 100 × `transpose`), `volume` in dB (`volume` +
    `group_volume`), `offset`;
  - `xfin: [lo, hi]` and `xfout: [lo, hi]` (velocity crossfades), or null;
  - `seq: [length, position]` (round robin);
  - `loop` where the source has one.

  Regions `loadSfz` skips (CC conditions, keyswitches, release triggers) are
  left out. A test compares, for every instrument, the zones the websfz
  document gives with the zones the manifest gives, for every key and a few
  velocities, so the conversion cannot change how anything sounds.
- Sample ids are the public names. Upstream file names are an implementation
  detail of `file`.
- `licence.spdx` uses a real SPDX id where one exists (`CC0-1.0`, `CC-BY-3.0`,
  `CC-BY-SA-3.0`) and a `LicenseRef-` id for informal claims.

A TypeScript schema and validator live beside the corpus schema (`src/corpus`
style: a plain type plus a validator and a test that loads every manifest).

## The Bazel side

- A module extension (`//bazel:samples.bzl`) reads the manifests listed in
  `MODULE.bazel` and generates:
  - one `http_file` per one-shot sample, with its sha256;
  - one repository per multisample instrument that downloads its files in a
    single repository rule (`ctx.download`, started concurrently, each checked
    against its hash);
  - a visible `@samples` repository of aliases, so a label reads
    `@samples//danigb-sampled/tr909-detroit:kick`.
- Each target provides `SampleInfo` (id, file, licence). A group provides the
  manifest and its files.
- `sample_kit(name, hits = {"36": "@samples//…:kick", …})` provides
  `SampleKitInfo`. A hit is a label or `{"default": …, "hard": …, "soft": …}`;
  the kit also takes the key aliases. `music_style` takes `kit = ":techno_kit"`
  and the `KITS`, `HARD_SOFT` and `TOUCH_SAMPLES` tables are removed. Agree
  the shape with DJ Claudia's kits-with-patches (`docs/dj-set-plan.md`,
  step 2) before building it.
- File URLs are percent-encoded by the generator (VCSL paths have spaces, some
  sample names have `#`), and pack and sample ids are turned into valid
  repository names.
- `style_samples` becomes an offline action: it takes the style's sound
  declaration, its kit and its instrument groups as inputs, runs the check, and
  writes the trimmed `samples/` tree and a credits file. The lock files, the
  refresh step and the network requirement go away.

CI already caches the Bazel repository cache (`setup-bazel` with
`repository-cache: true` in both workflows), so hash-pinned downloads are
restored between runs and a cold cache is the only time all requests happen.

## Steps

### 1. Schema, validator and the 909 kit (M)

- Add the manifest type, a validator and a test that loads every manifest.
- Write the generator for `danigb/sampled` oneshots and run it for TR-909
  Detroit; hand-check the licence block.
- Write the oneshot generator for `danigb/samples` too, and run it for the
  packs `minimal_techno`'s kit also names: TR-808, LM-2 (ride) and Sonic Pi
  drums (`bd_haus`). The kit then has no hit left on the old path.
- Do the Bazel extension for oneshots only, `@samples` aliases and
  `sample_kit` with variants and aliases. Move `minimal_techno`'s drum kit to a
  `sample_kit` using TR-909 plus those hits.
- The other styles' kits stay on `KITS` and the lock files until step 3; the
  loader accepts both a sample id and an upstream URL until then.
- Done when `minimal_techno` plays a 909 kit from `@samples` labels and
  `claudia_samples.lock.json` no longer lists any drum file.

#### Built (2026-11-14)

- `src/corpus/pack.ts`: the manifest type (zod), `validatePack`, `fileUrl`
  and the `SampleKit` shape the bundle carries; `pack_test` loads every
  manifest. Two additions to the format above: each sample records its `url`
  (the generator percent-encodes it once, the validator checks it equals
  `origin` + `file`, and Starlark never encodes), and the licence block has a
  `source` URL for where its terms were read.
- `//tools/packs`: one generator with a subcommand per source (`sampled`,
  `samples`). It keeps the hand-written parts of an existing manifest
  (licence, description, tags, GM keys) and gives a new pack a placeholder
  licence that fails validation. It refuses Git LFS pointers.
- Packs: `danigb-sampled/tr909-detroit` (14 wav, 6.0 MB), and from
  danigb/samples `tr-808` (116), `lm-2` (29) and `sample-pi-drums` (117), all
  m4a. Licences read and written by hand; the 909's notes the dead source link.
- `//bazel:samples.bzl`: the extension, the `@samples` hub (one `sample`
  target per sample, providing `SampleInfo`), and `sample_kit`
  (`SampleKitInfo`, `kit.json`). Hits are a label or
  `{"default", "hard", "soft"}`; aliases default to the GM table the sampler
  used, and a kit's own hit wins over an alias.
- `music_style(kit = ...)` passes the kit to `stylec`, which puts it in the
  bundle and `sound.json`. `style_samples` hands the kit's files to
  `tools/samples`, which copies the ones the runtime's `required()` reaches
  (every touch variant of every reachable key) and does not lock them.
- `minimal_techno`'s kit: 909 kick (hard: Sonic Pi `bd_haus`, soft:
  `kick-short`), snare, rim, claps, hats, cymbal and high tom; LM-2 ride; 808
  low tom and maraca, since the 909's low tom and ride are 2 MB each. The
  kit's files add 1.7 MB to Claudia's site (15 files; the corpus never plays the high tom).
- Refreshing `claudia_samples.lock.json` also fixed a stale pin: the
  committed one was written for an older corpus (lead files an octave higher).
- Not done in step 1: the instrument table, credits from licence blocks, and
  removing `KITS`, `HARD_SOFT`, `TOUCH_SAMPLES` (other styles still use them).

### 2. Multisample groups and the packaging action (L)

- Generators for the websfz documents (Splendid piano, VCSL, Smolken, Rhodes,
  Wurlitzer) and for the GM soundfonts, with the zone-equivalence test.
- The program-to-pack table, read by `sampler.ts` and by the rules; one GM
  group per program and font, about 88 files each.
- Group repositories, the offline trim action and the reach check, both
  running the runtime's `required()`.
- The dev server and tests serve the fetched superset (no upstream fallback
  once the loader is keyed by sample id).
- Done when a style builds with no network action and a corpus change that
  widens a range fails the check with a clear message.

#### Built (2026-11-14)

- `src/corpus/pack.ts`: `kind: "multisample"` with `samples` (file, url,
  sha256, bytes) and flat `regions`. One change to the format above: a region
  names its file by sample id (`sample`), so a file shared by regions is
  hashed and served once, and served paths stay `<pack>/<sample id>.<ext>`
  like one-shots. A `source` block pins the upstream document. The validator
  checks every region's sample exists and every sample is played; the SPDX
  pattern accepts CC BY-NC ids. The program table's type,
  `InstrumentTable`, and `packCredit` (credit lines from licence blocks) live
  there too.
- `//tools/packs`: `websfz` and `gm` subcommands. `tools/packs/websfz.ts` is
  the old `loadSfz`, kept as the reference. Region files are matched to the
  commit's tree; where only the case differs the hosted name wins, which
  handles the Splendid piano's `MF-`/`Mf-` (24 files) without
  `UPSTREAM_RENAMES`. No region names a file upstream lacks.
- Packs: the six SFZ instruments in use (Splendid piano, Wurlitzer EP200,
  VCSL vibraphone, marimba and tenor sax, Smolken pizz bass), and 61 GM
  programs per font from gleitz at `044fab8` (`gleitz-musyngkite/*`,
  `gleitz-fluidr3-gm/*`, 88 files each, 120 MB and 117 MB). Casio RZ-1 as a
  one-shot pack, so every drum the older kits play is in a pack.
- **Rhodes:** `danigb-samples/jrhodes3d-st` (65 files). jlearman's own
  LICENSE puts the samples under CC BY-NC 4.0 (danigb/samples' README says
  CC0); accepted under the licence policy of 2026-11-14, with the attribution
  on the pack. No program plays it yet (programs 4 and 5 stay on the
  Wurlitzer), so `MODULE.bazel` lists it and it is
  `@samples//danigb-samples/jrhodes3d-st`; the zone test checks it against
  its document too, including the `<control>` `prefix_sfz_path`.
- `samples/instruments.json`: the program table, one pack per program and
  font, with release, sustain and flat. It reproduces the old
  `instrumentFor` switch for the 67 programs the styles and the bench use; a
  program not listed plays nothing and cannot be declared. FluidR3 is now
  credited CC BY 3.0, as gleitz's README says (the code said MIT).
- `//tools/packs:zones_test`: every program in the table, both fonts, keys
  0-127, eight velocities, four passes for round robins: the zones from the
  manifest equal the zones the old loader computed from the pinned document
  (`//samples:sources`). Passes for all 140 combinations, and for the Rhodes,
  which is in no program yet.
- `//bazel:samples.bzl`: `samples.table(file = ...)` loads every pack the
  table names; one group repository per multisample (`ctx.download` with
  `block = False`, then waited on); `@samples//<pack id>` is a `sample_pack`
  (`SamplePackInfo`) for one-shots and multisamples alike.
- `music_style(packs = [...])` declares a style's packs. `style_samples` is
  offline: `//tools/samples` runs `reach()` from `sampler.ts` per style and
  key, trims, and fails with the style, part, keys and pack (and the labels to
  add). It also ships the older `KITS` drums at their `danigb/` mirror path,
  found in the declared drum packs by file, so no style needs the network:
  the lock files, `_lock` targets and `requires-network` are gone, a step
  early. The trimmed main-site set equals the old lock's exactly (2,843
  audio files, same hashes), plus the table, manifests and `credits.json`.
- The dev servers mount `samples/` from the `superset` output group; tests read
  manifests from `//samples:manifests` and shipped files from the trimmed
  output. The bench serves the table and manifests and streams audio from each
  manifest's pinned URL.
- Left for step 3: the older `KITS`, `HARD_SOFT`, `TOUCH_SAMPLES`,
  `mirrorPath` and `legacySample` in `//tools/samples`. Credits on the page
  still come from the sampler's labels (now licence-derived), not from
  `credits.json`.

### 3. Move the rest and remove the old path (M)

- Generate manifests for the remaining danigb/samples drum machines and Sonic
  Pi.
- Delete the legacy-URL handling in `tools/samples` and `mirrorPath` (the lock
  files and `UPSTREAM_RENAMES` went in step 2). The runtime loader is keyed by
  sample id.
- Generate the credits list from the licence blocks.

## To verify before starting

- That thousands of `http_file` repositories from one extension stay quick to
  evaluate, and that the aliases in `@samples` resolve to repositories the same
  extension generated. Try it with two files in a scratch workspace first.
  Fallback if evaluation is slow: group repositories for everything. Include
  the GM soundfont groups in the count (about 88 files per program per font).
  **Checked 2026-11-14 (Bazel 9.2.0):** aliases in a hub repo resolve to
  `http_file` repos of the same extension. With 6,001 repos, a cold
  `bazel query` of the hub took 1.2 s including server start, re-evaluation
  after a manifest change 0.27 s, and building all 6,001 from the repository
  cache 6.1 s. One-shot repos are fine at that scale; group repositories for
  multisamples remain the plan for other reasons (one label per instrument).
- Whether danigb/samples keeps any folder in Git LFS. raw.githubusercontent
  serves the pointer file, not the audio, for those; the hash check would
  catch it, but the URL scheme would need `media.githubusercontent.com`.
  **Checked 2026-11-14 at `eae8c5c`:** no `.gitattributes` with LFS filters
  anywhere (the only one, in `jlearman/rhodes-mki`, sets line endings), and no
  audio blob under 200 bytes; TR-808, LM-2 and Sample Pi drums all hash as
  real audio. The 48 drum files the lock files pinned hash the same from
  `raw.githubusercontent.com` at the commit as from Pages.
- **danigb/samples.** The converted files are on `main` under `audio/`; a
  workflow publishes that folder to GitHub Pages. One file was compared
  (TR-808 `clap/cp.m4a`: Pages and `main` hash the same, and match the lock
  file). Compare a few more, especially the Splendid piano's `MF-`/`Mf-`
  naming that `UPSTREAM_RENAMES` works around.
- **gleitz/midi-js-soundfonts.** Its default branch is `gh-pages`, so the pin
  is a `gh-pages` commit. Its 4.9 GB size means no whole-repo archive.
  **Checked 2026-11-14 at `044fab8`:** the generator lists each program's
  folder tree (the recursive listing is too big) and every used program has
  all 88 files. The packaged site's files hash the same from
  raw.githubusercontent at the commit as the old lock pinned from Pages. A
  cold cache downloads about 6,000 files from raw.githubusercontent; if that
  hits rate limits in CI, add the Pages URL as a second `url` (the hash still
  pins it).
- **danigb/sampled.** The 909 sets are wav, and the app currently decodes
  `.m4a` and `.ogg` from the mirror. Check that the sampler path takes wav
  (the browser decodes it; sizes are larger) and what the 14 and 16 files add
  to the page's download.
  **Checked 2026-11-14:** Claudia plays the Detroit set's wav files in the
  browser. All 14 are 6.0 MB; the kit reaches 11 of them (1.7 MB) and leaves out
  the 2 MB low tom and ride. Its default branch is `master`.
- **Where the 909's provenance goes.** Its README names a blog post that no
  longer loads. The licence note should say so.
  **Done 2026-11-14:** the link returns 404, and the licence note says so.
- Whether to key the extension's cache on the manifest hashes in CI, and how
  `setup-bazel` keys the repository cache today.

## Open

- Whether manifests should be generated into `samples/` and checked in, or
  built. Checked in is assumed, so licence and hash changes show in review.
- Whether `kit` belongs on `music_style` or on a separate rule the app picks.
  Settle it together with DJ Claudia's kits-with-patches.
- Whether the trim targets a style or a style pack. Today `samples` and
  `claudia_samples` are each one union over a pack, so the site ships one
  `samples/` per app; trimming per pack keeps that and dedupes shared files.
- How a kit that mixes packs (techno: house kick, 808 snare, 909 hats) appears
  in the credits: one line per pack used, not per sample.
