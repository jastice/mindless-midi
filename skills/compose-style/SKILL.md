---
name: compose-style
description: Compose, tune, audition, and integrate original music styles for DJ Claudia and Mindless Midi — covering corpus design, custom synth patches and drum kits, offline audio auditioning, acoustic verification, and Bazel integration.
---

# Composing Styles for DJ Claudia and Mindless Midi

Use this skill whenever creating, editing, regenerating, or tuning a musical style in this repository — whether for **DJ Claudia** (endless multi-deck club sets) or **Mindless Midi** (endless multi-engine procedural music across FM, Synth, Samples, and MIDI).

## 1. Choose the Target App

The two apps share the core corpus schema (`src/corpus/schema.ts`), music theory (`src/theory/`), arranger (`src/engine/piece.ts`), and stem engines (`src/sound/`), but differ significantly in structure and constraints:

| Dimension | DJ Claudia | Mindless Midi (and Mighty Midi) |
| --- | --- | --- |
| Style list | `CLAUDIA_STYLES` in `styles/BUILD.bazel` | `STYLES` in `styles/BUILD.bazel` |
| Built pack | `//styles:claudia` (`styles/claudia.json`) | `//styles:styles` (`styles/styles.json`) |
| Conductor | `SetConductor` (`src/engine/set.ts`) — 2 decks, beatmatched blends | `Conductor` (`src/engine/conductor.ts`) — standalone pieces |
| Arrangement | Multi-part (`parts`, `arrangement`, `moves`, `names`) | Role-based (one instrument per role; optional `palette` areas) |
| Meter & tempo | Strictly `4/4`; club tempo ~118–138 BPM (3% max step between tracks) | Any `beatsPerBar` 2..9 (`beatGroups`), any tempo 40–220 BPM |
| Keys | Must link cleanly (`>= 6/7` shared pitch classes) to every other Claudia style | Free choice across all 11 modes |
| Sound engines | **Synth** (`patches` + `synthKit`) and **Samples** (`sample_kit` + packs) | **FM (OPL3)**, **Synth**, **Samples** (SFZ + GM), and **Save MIDI** |
| Tests to add/update | `src/sound/<id>.test.ts`, `src/corpus/names.test.ts`, `src/sound/decks.test.ts` (auto-covers) | `src/engine/golden.test.ts`, `src/sound/worker.test.ts` |
| Deep-dive guide | Read `references/claudia.md` | Read `references/mindless-midi.md` |

## 2. End-to-End Authoring Workflow

Follow this loop for every new style:

1. **Read the right deep-dive reference first:**
   - DJ Claudia → `references/claudia.md`
   - Mindless Midi → `references/mindless-midi.md`
   - Also skim `src/corpus/schema.ts` and `src/corpus/patch.ts` — their Zod `.describe(...)` strings are the exact authoring spec.
2. **Write the style brief** (`styles/<id>/brief.md`):
   - Define the musical identity, tempo/key plan, harmonic vocabulary, rhythmic signature, sound palette (custom patches/kits or SFZ/GM instruments), and contrast between sections.
3. **Author `styles/<id>/corpus.json` and `styles/<id>/BUILD.bazel`:**
   - Hand-author (or start from `bazel run //styles:regen -- styles/<id>` for Mindless Midi).
   - Set `"authors": ["<your model or name>"]` when hand-authoring.
   - Declare `sample_kit(name = "kit", ...)` and `music_style(name = "style", id = "<id>", bank = ..., color = "#...", corpus = "corpus.json", kit = ":kit", packs = [...])`.
   - Every style requires a `kit` (even quiet acoustic styles need kick `36`, crash `49`, and low tom `45` for endings).
4. **Wire into the repo:**
   - Add `"<id>"` to `CLAUDIA_STYLES` or `STYLES` in `styles/BUILD.bazel`.
   - Add a mix preset in `src/sound/bus.ts` (`PRESETS`) and a weight tier in `src/sound/weight.ts` (`TIERS`).
   - Complete the app-specific wiring checklist in `references/claudia.md` or `references/mindless-midi.md`.
5. **Validate, calibrate, and resolve sample packs:**
   ```bash
   bazel test //src/corpus:validate_test
   bazel build //styles/<id>:style --output_groups=+calibration
   # Claudia:
   bazel build //styles:claudia //styles:claudia_samples
   # Mindless Midi:
   bazel build //styles:styles //styles:samples
   ```
   - Target **zero warnings** from `validateCorpus`.
   - If `//styles:samples` or `//styles:claudia_samples` fails, copy the printed `@samples//...` labels into `packs = [...]` in `styles/<id>/BUILD.bazel`.
   - Check the calibration JSON output (FM loudness per role); an instrument pinned at CC7 `127` is too quiet in the chosen FM `bank`.
6. **Audition real audio offline and iterate by ear** (Section 3 below).
   - **Never ship a style without actually listening to rendered audio.** Automated checks catch clipping and balance, but only listening catches squawky leads, smeared clap rolls, awkward melodic contours, lifeless chords, or jarring transitions.
7. **Write / update tests and run the full suite:**
   ```bash
   bazel test //...
   ```

## 3. Offline Audio Auditioning Tools

### A. Synth Engine Audition Script (Bundled in This Skill)

Use `scripts/audition.mjs` to render stereo 24 kHz `.wav` clips through the **exact production render worker** (`src/sound/worker.js`) for either **DJ Claudia** or **Mindless Midi**, alongside bar/section summaries and acoustic weight metrics (`measureWeight`).

First build the pack and render worker:

```bash
# For DJ Claudia:
bazel build //styles:claudia //src/sound:worker //src/sound //src/engine

# For Mindless Midi:
bazel build //styles:styles //src/sound:worker //src/sound //src/engine
```

Then run `scripts/audition.mjs` (writes WAVs to `/tmp/` by default — never write temporary WAVs inside the git repo):

```bash
# Inspect track layout (form, key, BPM, sections, active parts) without rendering audio:
node skills/compose-style/scripts/audition.mjs --style french_electro --seed audit-1 --list

# Render a DJ Claudia breakdown -> build -> peak drop (auto-finds the drop boundary):
node skills/compose-style/scripts/audition.mjs --style french_electro --seed audit-1 --find drop --bars 28 --out /tmp/drop.wav

# Render a DJ Claudia stretch where specific parts play together (use --track 2 to get past track-0 warmup):
node skills/compose-style/scripts/audition.mjs --style french_electro --seed audit-1 --track 2 --find parts:vocoder,acid --bars 16 --out /tmp/parts.wav

# Render a Mindless Midi piece opening (weighted Synth engine):
node skills/compose-style/scripts/audition.mjs --style lofi --seed audit-1 --bars 24 --out /tmp/lofi_open.wav

# Render a Mindless Midi piece ending (tests cadence + ritardando/picardy):
node skills/compose-style/scripts/audition.mjs --style lofi --seed audit-1 --find ending --bars 16 --out /tmp/lofi_end.wav

# Render plain (unweighted) synth without expression/weight:
node skills/compose-style/scripts/audition.mjs --style lofi --seed audit-1 --plain --bars 16 --out /tmp/lofi_plain.wav
```

If your agent environment supports multimodal audio inspection (for example `read_file` on `.wav`), open `/tmp/*.wav` directly and critique the timbre, rhythm, mix separation, transitions, and energy arc by ear!

### B. FM (OPL3) Offline Renderer (Mindless Midi)

To audition the exact OPL3 FM synth path (and optionally export a `.mid` file):

```bash
bazel run //tools/render -- --styles <id> --seconds 45 --seed audit-1 --out /tmp/<id>_fm.wav --midi /tmp/<id>.mid
```

Pass `--raw 1` to bypass the browser's AGC/limiter stage.

### C. Live Browser Dev Servers (All Engines + Mix Bus + Visuals)

The offline worker script renders stems before the Web Audio `MixBus` (reverb/delay/chorus/lofi); use the dev servers to audition the full browser mix bus, Samples engine, and live transitions:

| Command | URL | Purpose |
| --- | --- | --- |
| `bazel run //src/claudia:serve` | `http://localhost:8082` | Full DJ Claudia app (2 decks, booth cam, Synth + Samples) |
| `bazel run //src/claudia:serve_arranger` | `http://localhost:8083` | Manual DJ Claudia set arranger (toggle parts & moves live) |
| `bazel run //site:serve` | `http://localhost:8080` | Mindless Midi (FM, Synth, Samples, Save MIDI) |
| `bazel run //src/mighty:serve` | `http://localhost:8081` | Mighty Midi |
| `bazel run //src/bench:serve` | `http://localhost:8090` | Synthesis bench (A/B compare FM, Synth, and Samples per patch/note) |

## 4. Key Test & Build Commands

```bash
# Schema & lint validation (all checked-in corpora):
bazel test //src/corpus:validate_test

# DJ Claudia track-name uniqueness, length (<= 22 chars), and >= 100 titles:
bazel test //src/corpus:names_test

# DJ Claudia two-deck blend, low-end swap, and headroom verification:
bazel test //src/sound:decks_test

# Style-specific acoustic + set-travel + worker test (DJ Claudia):
bazel test //src/sound:<id>_test

# Mindless Midi determinism, worker stability, and weight checks:
bazel test //src/engine:golden_test //src/sound:worker_test //src/sound:weight_test

# Build static sites:
bazel build //src/claudia:site //site

# Full test suite:
bazel test //...
```

> **Note:** On macOS sandboxed setups, Bazel needs access to its cache (`~/Library/Caches/bazel`); run `bazel` outside restrictive file sandboxes while keeping Node scripts and file edits sandboxed.

## 5. Documentation & Source-of-Truth Links

### Skill Deep-Dive References
- `references/claudia.md` — DJ Claudia rules, parts/groups/moves, custom synth DSP gotchas, overlap safety, and test template
- `references/mindless-midi.md` — Mindless Midi rules, multi-engine balance (FM/Synth/Samples), SFZ instruments, meters/modes, and golden/worker test updates

### Repository Guides & Architecture Docs
- `README.md` — Project overview and quick commands
- `docs/dj-set-plan.md` — DJ Claudia design spec, style roster, set grammar, transitions, and booth cam
- `docs/beyond-midi-plan.md` — Stem engines (Synth + Samples), mix bus, weight, and expression
- `docs/sample-format-plan.md` — Sample pack manifests and offline trimming
- `docs/visualizer-plan.md` — Booth cam clip director and tempo rate bounds
- `docs/knowledge/index.md` — Open Knowledge Format repository map
- `docs/knowledge/guides/add-a-style.md` — Short checklist for adding a Mindless Midi style
- `docs/knowledge/guides/regenerate-style.md` — Using `//styles:regen` with `tools/generate`
- `docs/knowledge/guides/render-offline.md` — Offline FM WAV/MIDI rendering with `//tools/render`
- `docs/knowledge/guides/local-development.md` — Dev servers and test targets
- `docs/knowledge/concepts/styles-and-corpora.md` — How briefs, corpora, and style packs work
- `docs/knowledge/concepts/sound-engines.md` — FM, Synth, and Samples architecture
- `docs/knowledge/concepts/gestures.md` — Articulations (`slide`, `accent`, `swell`) across engines
- `docs/knowledge/build/samples.md` — Sample packs, `samples/instruments.json`, and `sample_kit`

### Authoritative Code Files
- `src/corpus/schema.ts` — Full `StyleCorpus` Zod schema & authoring docs
- `src/corpus/patch.ts` — `Patch`, `NamedPatch`, `Kit`, and `KitPerc` schemas
- `src/corpus/validate.ts` — All validation errors and lint warnings
- `src/theory/theory.ts` — Supported modes, chord suffixes, voicings, and `keysCompatible`
- `src/engine/piece.ts` — Piece arrangement, `FRAME_LABELS`, gesture eligibility, and endings
- `src/engine/set.ts` — DJ Claudia `SetConductor`, `MAX_TEMPO_STEP`, `PHRASE_BARS`, blends
- `src/engine/parts.ts` — Multi-part entry/exit, `groups`, `most`, warmup lift, and overlaps
- `src/sound/synth.ts` — Exact DSP signal chain for custom patches and `synthKit`
- `src/sound/bus.ts` — Per-style `PRESETS` (reverb, delay, chorus, duck, lofi, highpass)
- `src/sound/weight.ts` — Per-style `TIERS` (kick/bass drive, parallel drum crush, sidechain ducking)
- `samples/instruments.json` — GM program → SFZ / soundfont sample pack mapping
- `styles/BUILD.bazel` — `STYLES` and `CLAUDIA_STYLES` registration
