# Authoring a Mindless Midi Style

Mindless Midi (`styles/BUILD.bazel` `STYLES`) generates standalone, endlessly varied pieces in a wide spectrum of genres (jazz, baroque, lofi, chiptune, bossa nova, celtic, ambient, synthwave, funk, etc.). Unlike DJ Claudia, every Mindless Midi style must sound great across **four outputs**:

1. **FM (OPL3)** — libADLMIDI 4-op / 2-op FM synthesis with GM banks (`tools/render` + browser worklet)
2. **Synth** — built-in physical/modal/FM/Karplus-Strong voices + optional custom `patches` / `synthKit`
3. **Samples** — recorded SFZ multisamples and MusyngKite / FluidR3 GM soundfonts + `sample_kit`
4. **Save MIDI** — clean standard MIDI files playable in any DAW or synth

## 1. Musical Freedoms & Features

Mindless Midi styles have access to expressive features that 4/4 club sets do not use:

- **Meters & additive rhythms:** Any `beatsPerBar` from `2` to `9`, with optional `beatGroups` (e.g., `[3, 2]` for 5/4, `[2, 2, 3]` for 7/4, `[2, 2, 2, 3]` for 9/8 — must sum to `beatsPerBar`). Melodies treat group starts as strong beats.
- **All 11 modes (`MODE_NAMES` in `src/theory/theory.ts`):** `ionian`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `aeolian`, `locrian`, `harmonicMinor`, `melodicMinor`, `phrygianDominant`, `doubleHarmonic`.
- **Swing & humanize:** `swing` (`0..1`), `swingUnit` (`"8th"` or `"16th"`), `humanize` (`0.05` tight electronic/chip → `0.5` live acoustic ensemble).
- **Multi-area `palette` forms:** Give `forms[]` a `palette` tag (e.g. `"sunlit_courtyard"`, `"deep_cavern"`) plus optional per-form `tempo`, `keys`, and `instruments` overrides. Material (`progressions`, `motifs`, `comping`, `drums`) tagged with the same `palette` is preferred for that form; untagged forms draw from untagged material.
- **Melodic ornamentation & endings:**
  - `melody.trill` (`0..1`) adds baroque/classical upper-neighbor trills on long lead notes.
  - `ending.ritardando` (`0..0.5`, e.g. `0.2–0.35` for acoustic/chamber styles, `0` for chip/electronic) slows the final bar smoothly into the cadence. *(Gotcha: if your bass motifs use `g: "slide"` gestures, combining `ritardando > 0` with bass slides can trigger a `piece.ts` timing-order assertion in `//src/engine:engine_test` — prefer `ritardando: 0` on slide-heavy bass styles, or verify `//src/engine:engine_test` early.)*
  - `ending.picardy: true` resolves minor-mode pieces onto a major tonic chord.
- **Role-based arrangement:** Omit `parts`, `arrangement`, `moves`, and `names`. Write one `Instrument` per active role (`lead`, `counter`, `arp`, `pad`, `comp`, `bass`, `drums`), and control texture through each section's `roles: [...]`, `intensity`, and motif/comp/drum variety.

## 2. Picking Instruments for Multi-Engine Quality

Check `samples/instruments.json` first! Programs not listed in `samples/instruments.json` are **silent** in the Samples engine and cannot be declared in `packs`.

### Featured High-Resolution SFZ Recordings
These programs use multi-velocity SFZ libraries identically in both MusyngKite and FluidR3 fonts:
- `0` — Splendid Grand Piano (public domain)
- `4` — Wurlitzer EP200 electric piano (CC BY 3.0)
- `11` — VCSL Vibraphone (CC0)
- `12` — VCSL Marimba (CC0)
- `32` — D. Smolken Double Bass (CC0)
- `66` — VCSL Tenor Sax (CC0)

Every other listed GM program maps to `gleitz-musyngkite/<name>` and `gleitz-fluidr3-gm/<name>`.

### When to Omit `patch` vs Define Custom `patches`
- **Acoustic / classical / jazz / folk styles:** Often best to **omit `patch`** on acoustic instruments so Samples plays the rich SFZ/GM recording and Synth uses its built-in physical/modal/Karplus-Strong/FM model for that GM program.
- **Electronic / hybrid / retro / sound-designed styles:** You can define custom `patches` and `synthKit` for the Synth engine while keeping an accurate GM `program` on every `Instrument` so FM, Samples, and Save MIDI stay faithful too.
- **Drum kits (`sample_kit`):** Every style MUST define a `sample_kit` in `styles/<id>/BUILD.bazel`, even if drums only play softly or on endings. Include at minimum:
  - `36` (kick), `45` (low tom), `49` (crash) — played by the ending cadence.
  - Plus whichever kit lanes your drum patterns use (`38` snare, `37` rim, `39` clap, `42` closed hat, `46` open hat, `51` ride, `48` high tom, `70` shaker).
  - Available drum sample packs include `danigb-samples/{tr-808,lm-2,casio-rz1,sample-pi-drums}` and `danigb-sampled/tr909-detroit` (check existing `styles/*/BUILD.bazel` files for ready-to-copy `sample_kit` examples, including `{"default", "hard", "soft"}` touch variants on Sonic Pi kits).

## 3. FM Bank Selection & Calibration

In `styles/<id>/BUILD.bazel`, `music_style` requires an FM `bank` (libADLMIDI embedded bank index):
- `1` — Bisqwit (punchy classic OPL3)
- `14` — Bobby Prince / Doom (gritty rock/metal/chiptune)
- `58` — The Fat Man (warm vintage GM)
- `68` — Nguyen / Wohlstand 4-op GM (cleanest all-around 4-op instruments; great default)
- `72` — DMXOPL3 (classic DOS game GM)

After editing `corpus.json` or `bank`, inspect calibration:

```bash
bazel build //styles/<id>:style --output_groups=+calibration
```

Read the generated calibration JSON (path printed by Bazel). If any role's calibrated CC7 is pinned at **`127`**, that GM program is too quiet in the chosen FM bank — try a different `bank`, adjust `volume`, or pick a stronger GM program in the same family.

## 4. Sample Pack Resolution

Run:

```bash
bazel build //styles:samples
```

If any instrument's MIDI range reaches a pack not yet listed in `styles/<id>/BUILD.bazel`, Bazel fails with the exact `@samples//...` labels to copy into `packs = [...]`. Rebuild `//styles:samples` until it passes cleanly.

## 5. Mix Bus (`bus.ts`) and Weight (`weight.ts`)

1. **`src/sound/bus.ts` (`PRESETS`):** Add `PRESETS.<id>` defining `reverb` (`seconds`, `predelay`, `bright`, `send`), `highpass` per role, and optional `delay`, `chorus`, `duck`, and `lofi`.
2. **`src/sound/weight.ts` (`TIERS`):** Assign `HARD`, `MID`, `SOFT`, or a custom `Weight` object:
   - Acoustic / chamber / ambient / jazz → `SOFT` (light saturation, no kick ducking unless specified in `bus.ts`).
   - Pop / folk-rock / retro → `MID` or custom.
   - Dance / synthwave / funk / dnb → `HARD` or custom.

## 6. Auditioning Both Synth and FM Offline

Always listen to **both** engines before finalizing:

```bash
# 1. Build targets
bazel build //styles:styles //src/sound:worker //src/sound //src/engine

# 2. Audition Synth engine (opening + middle + ending cadence)
node skills/compose-style/scripts/audition.mjs --style <id> --seed audit-1 --list
node skills/compose-style/scripts/audition.mjs --style <id> --seed audit-1 --bars 24 --out /tmp/<id>_synth.wav
node skills/compose-style/scripts/audition.mjs --style <id> --seed audit-1 --find ending --bars 16 --out /tmp/<id>_end.wav

# 3. Audition FM (OPL3) engine + export MIDI
bazel run //tools/render -- --styles <id> --seconds 45 --seed audit-1 --out /tmp/<id>_fm.wav --midi /tmp/<id>.mid
```

Check by ear:
- Does the harmony move with genuine musical tension and release (not stagnant loops)?
- Are lead, counter, comp, pad, and bass clearly separated in register and stereo image?
- Does the ending cadence (`ritardando` / `picardy`) land naturally without abrupt cutoffs?
- Do FM and Synth both translate the brief's mood faithfully?

## 7. Pinning Regression Tests Carefully

Adding a style to `STYLES` affects two golden/regression suites. Follow their comments strictly:

1. **`src/engine/golden.test.ts`:**
   - Run `bazel test //src/engine:golden_test` to observe expected hashes for the new style and the pool/seek tests.
   - Add the new style's **6 per-style hashes** to `EXPECTED` and update the shared `pool/*` and `seek/*` hashes (which depend on the total style count).
   - **NEVER alter any existing style's individual hashes!** If an existing style's hash changed, you accidentally changed engine behavior.
2. **`src/sound/worker.test.ts`:**
   - The render worker retains mix/leveller state across runs inside the test file, so run order matters.
   - **Always append** the new style's runs **at the very end** of the test list so existing styles' fingerprints stay untouched!
3. **`src/sound/weight.test.ts`:**
   - Run `bazel test //src/sound:weight_test` to verify weight measurements, mono low end, and headroom across all styles.

## 8. File Wiring Checklist (Mindless Midi)

- [ ] `styles/<id>/brief.md`
- [ ] `styles/<id>/corpus.json`
- [ ] `styles/<id>/BUILD.bazel` (`sample_kit` + `music_style` with `bank`, `color`, `kit`, `packs`)
- [ ] `styles/BUILD.bazel` — add `"<id>"` to `STYLES`
- [ ] `src/sound/bus.ts` — add `PRESETS.<id>`
- [ ] `src/sound/weight.ts` — add `TIERS.<id>`
- [ ] `bazel build //styles/<id>:style --output_groups=+calibration` — no CC7 pinned at 127
- [ ] `bazel build //styles:samples` — all required sample packs declared
- [ ] Auditioned Synth (`scripts/audition.mjs`) and FM (`//tools/render`) renders by ear
- [ ] `src/engine/golden.test.ts` — appended new style hashes + updated `pool/*` & `seek/*`
- [ ] `src/sound/worker.test.ts` — appended new style's worker runs at the end
- [ ] `src/app/index.html` & `README.md` — add the author to the colophon/credits if a new contributor authored the style
- [ ] `bazel test //...` and `bazel build //site` both pass
