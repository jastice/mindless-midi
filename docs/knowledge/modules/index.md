# Modules

TypeScript packages under `src/`, each a Bazel `ts_lib`. Dependencies run top
to bottom: theory ← corpus ← engine ← audio / sound ← apps.

- [theory](./theory.md) - Seeded RNG, seed words, modes, chords, chord-scales, voice-leading
- [corpus](./corpus.md) - The style corpus schema, its validator, and each style's sound declaration
- [engine](./engine.md) - The deterministic arranger: conductor, piece, part writers, gestures, MIDI writer
- [audio](./audio.md) - The FM path: sample-accurate event queue, output leveler, OPL3 AudioWorklet
- [sound](./sound.md) - Stem engines: DSP synths, sampler, mix bus, weight, levelers, render worker
