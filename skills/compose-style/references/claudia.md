# Authoring a DJ Claudia Style

DJ Claudia (`src/claudia/`, `styles/BUILD.bazel` `CLAUDIA_STYLES`) plays endless, beatmatched, harmonically mixed club sets across two decks (`SetConductor` in `src/engine/set.ts`). Every track is built from small toggleable **parts**, custom **synth patches** and a modelled **drum kit**, **arrangement** dynamics, **moves** (sweeps, builds, stutters), and a genre-authentic **track-name generator**.

## 1. Set-Level Compatibility Rules

Check these constraints before writing notes:

- **Meter:** Strictly `beatsPerBar: 4`.
- **Tempo window:** Keep `tempo.min` / `tempo.max` inside the booth-cam clip rate window (`MIN_RATE = 0.9`, `MAX_RATE = 1.16` around 120 BPM clips in `src/claudia/director.ts` → ~108–139 BPM, sweet spot **118–138 BPM**). Adjacent tracks in a set step by at most `MAX_TEMPO_STEP = 0.03` (3%), so your range should overlap or lie within 3% of neighboring Claudia styles.
- **Key compatibility:** Every key in `corpus.keys` should have at least one compatible neighbor (`keysCompatible` in `src/theory/theory.ts`, requiring `>= 6/7` shared pitch classes) in every other style in `CLAUDIA_STYLES`. Pure natural minor (`aeolian`) or dorian keys with diverse tonics connect effortlessly across the roster.
- **Engines:** DJ Claudia ships **Synth** and **Samples** (not FM), though `music_style` still compiles with a valid `bank` (e.g. `68`) and `sample_kit` + `packs`.

## 2. Form & Section Structure

`SetConductor` mixes tracks on 8-bar phrases (`PHRASE_BARS = 8`) with 16- or 32-bar blend zones at both ends:

- **Section lengths:** Every section in every form must be **16 or 32 bars** (`s.bars === 16 || s.bars === 32`).
- **Track length:** At least **128 bars** total per form (`128`–`160` bars gives 4–5 minute tracks).
- **CRITICAL — Do NOT name first/last sections `intro` or `outro`:**
  `FRAME_LABELS` in `src/engine/piece.ts` matches `"intro"` / `"outro"` and disables `holdsTail`. Name your opening and closing 16-bar mix zones `"in"` and `"out"` instead!
- **Mix-in / mix-out intensity:** First (`in`) and last (`out`) sections should be 16 bars at `intensity: 0.3` with a stripped groove (kick + hats/arp, no crowded lead).
- **Hot penultimate body:** Keep the second-to-last section hot (`intensity >= 0.7`) with `drums` and `bass` present so 32-bar blends have full energy into the swap.
- **Breakdowns and peak drops:** Include at least one breakdown without `bass` (and ideally without `drums`) followed by a high-intensity drop (`intensity >= 0.85–1.0`) so Claudia's builds, risers, and booth-cam peak clips fire cleanly.

## 3. Parts, Groups, `enters`, and Overlap Safety

- **Keep parts small and modular:** Aim for ~10–16 parts (`kick`, `snare`/`clap`, `hats`, `ride`, `toms`/`perc`, `roll`, `bass`, `pad`, 2–4 melodic/chord `line` parts, optional `noise` textures).
- **Assign `group` caps in `arrangement.groups`:**
  - Group pitched melodic/chord parts (anything besides `drums`, `bass`, `pad`) under `"line"` with `groups.line <= 3`.
  - Group busy percussion under `"perc"` (`<= 2`) and risers/textures under `"noise"` (`<= 2`).
  - Cap `arrangement.most` (typically `6–9` depending on density) so tracks stay clear and punchy.
- **`enters` ordering & warmup pitfall:**
  - When a drop hits, `src/engine/parts.ts` fills `group` slots in part order / `enters` priority. If 3 other `"line"` parts have lower `enters` than your hero `lead`, the `lead` can get starved out of peak drops!
  - Track 0 of a set also starts with a negative warmup lift (`-0.15`), which hides parts with high `enters`.
  - Fix: Put hero peak parts (whose `role` only appears in peak sections anyway) at a modest `enters` (e.g. `0.30–0.45`) and keep secondary lines well balanced so every signature voice actually shows up in real tracks.
- **Harmonic safety during 16–32 bar blends:**
  - When a deck is **non-dominant** during a transition, the arranger keeps only the coolest running line (typically the untagged `arp` or `comp` with the lowest `enters`) beside the dominant track.
  - Restrict that untagged overlap line to `anchor: "key"` and chord-neutral scale degrees **`{0, 3, 4, 7}`** (tonic, 4th, 5th, octave) so it never clashes with the incoming or outgoing track's chords!
- **Dedicated build roll part:**
  - If `moves.build > 0`, add one drum part with `"roll": true` and a single lane (`["snare"]` or `["clap"]`). It stays silent everywhere except build bars, where the engine automatically doubles its rate into the drop.

## 4. Custom `patches` & `synthKit` DSP Gotchas (`src/sound/synth.ts`)

Read `src/corpus/patch.ts` for every field's range and unit, and watch these real DSP behaviors in `src/sound/synth.ts`:

1. **`hp` runs BEFORE `drive`:** Overdrive regenerates low-frequency distortion products below your high-pass cutoff. On driven non-bass parts (`acid`, `lead`, `stab`), raise `hp` (`300–550 Hz`) and verify `< 4%` energy below 180 Hz.
2. **`formants` sum into mono before `hp`:** Each formant filter (`Svf.tick`) adds a mono resonant peak. If you build a vocoder/choir patch, keep the main filter `"low"` with unison `voices >= 3` and wide `spread` (`0.75–0.90`), add `hp` (`450–650 Hz`), and lower `level` (`0.09–0.14`) so 4-note chords stay stereo and never clip.
3. **Polyphonic chord headroom:** 3- to 4-note `pad` / `comp` chords sum linearly before the worker mix. Keep chord patch `level` around `0.10–0.22` and verify 4-note `peak < 1.0`.
4. **Tight club kicks:** `kick.sub.decay` scales up at high velocity (`~1.1x`). For crisp 4-on-the-floor punch without muddy overlap at 120–130 BPM, keep `kick.decay` around `0.12–0.18` and `kick.sub.decay` around `0.09–0.16` (verify 30 dB `ringTime < 0.55 s`). Use `rumble` only when you intentionally want a Berlin-techno sub wash.
5. **Clap rolls:** If your `roll` part uses `clap`, keep `clap.bursts <= 3` and `clap.decay <= 0.085`; longer tails smear into static on 32nd-note build-ups.
6. **Written gestures (`slide`, `accent`, `swell`):**
   - `src/engine/piece.ts` drops written gestures on notes shorter than **`d < 0.2` beats** (a 16th note is `0.25`, which works; a 32nd note `0.125` does not).
   - For tied portamento (`g: "slide"` on a patch with `glide`), the previous note must touch exactly (`prev.t + prev.d === n.t`, within 30 ms).
   - Give acid/slap bass instruments GM program `38` or `39` so the arranger knows it can write slides and accents.
7. **Lead register & `scoop`:** Combining negative `scoop` with high MIDI notes (`melody.high > 82`) can sound squawky or chipmunk-like. Always audition peak drops by ear!
8. **Unique sounds:** Do not copy another style's `patches` or `synthKit` verbatim — each Claudia style should have its own sonic signature.

## 5. Low-End Continuity & Two-Deck Blend Rules (`decks_test`)

`bazel test //src/sound:decks_test` automatically runs two-deck sets across all styles in `CLAUDIA_STYLES` and enforces:

- **Continuous low end in bass motifs:** Every beat of a bass pattern should have bass presence (no empty beats that cause holes across a swap).
- **Mono lows:** Leave `spread` unset on `bass` and kick-range sounds (`lowCorrelation > 0.95`).
- **Matched track loudness:** Keep whole-track body RMS within `~±2.5 dB` of existing Claudia styles (around `-24` to `-26 dB` in the weighted worker at 24 kHz) so bass swaps and filter transitions stay under the `3.5 dB` bar-to-bar step and `0.5` peak ceiling.
- Tune overall punch and glue in `src/sound/bus.ts` (`PRESETS.<id>`) and `src/sound/weight.ts` (`TIERS.<id>`).

## 6. Track Names (`names: NameTheme`)

- Provide at least **100 unique combinations** (`patterns` + `lists`), every title **`<= 22` characters**, fitting the genre's record-sleeve aesthetic.
- Titles must be **completely disjoint** from all other Claudia styles.
- Wire your style's corpus into `src/corpus/names.test.ts` and `src/corpus/BUILD.bazel` (`data = [...]`), then run `bazel test //src/corpus:names_test`.

## 7. Dedicated Verification Test (`src/sound/<id>.test.ts`)

Follow the pattern in `src/sound/french_electro.test.ts` (and the other Claudia tests under `src/sound/`):

1. Validate `corpus.json` with **zero warnings**, checking forms, parts, groups, and patch/kit uniqueness.
2. Check key compatibility against every other style in `CLAUDIA_STYLES` and mode/scale purity of progressions.
3. Measure isolated kit hits and every custom patch via `renderSynthNote` + `bandShare` / `lowCorrelation` / `peak` / brightness / tied-slide join.
4. Run multi-seed `SetConductor` travel across the full `CLAUDIA_STYLES` pack (verify every style is visited, tempo steps `<= MAX_TEMPO_STEP`, keys compatible, overlap uses safe cool line).
5. Run a full track through `src/sound/worker.js` and compare `measureWeight` against peer styles (RMS within 3 dB, mono lows `> 0.95`, even bar-to-bar low end, peak `< 0.85`, fast render `< 1/4` real-time).

Register the test in `src/sound/BUILD.bazel` (`ts_test`).

## 8. File Wiring Checklist (DJ Claudia)

- [ ] `styles/<id>/brief.md`
- [ ] `styles/<id>/corpus.json`
- [ ] `styles/<id>/BUILD.bazel` (`sample_kit` + `music_style` with `packs`)
- [ ] `styles/BUILD.bazel` — add `"<id>"` to `CLAUDIA_STYLES`
- [ ] `src/sound/bus.ts` — add `PRESETS.<id>`
- [ ] `src/sound/weight.ts` — add `TIERS.<id>`
- [ ] `src/corpus/names.test.ts` & `src/corpus/BUILD.bazel` — register track-name coverage
- [ ] `src/sound/<id>.test.ts` & `src/sound/BUILD.bazel` — dedicated acoustic + set + worker test
- [ ] `docs/dj-set-plan.md` — add the style to the roster table/notes
- [ ] Auditioned drop, breakdown, and signature part combinations via `scripts/audition.mjs`
- [ ] `bazel test //...` and `bazel build //src/claudia:site` both pass
