---
type: Repository Map
title: Repository map
description: Every top-level directory of the repository and what it holds.
tags: [navigation, start-here]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# Repository map

| Path | What it is | Read more |
| --- | --- | --- |
| `src/theory/` | Seeded RNG, session seed words, modes, roman-numeral chords, voice-leading | [theory](./modules/theory.md) |
| `src/corpus/` | Corpus schema (zod), validator, per-style sound declaration | [corpus](./modules/corpus.md) |
| `src/engine/` | The arranger: conductor, piece, part writers, gestures, MIDI file writer | [engine](./modules/engine.md) |
| `src/audio/` | FM path: event queue, output leveler, OPL3 AudioWorklet | [audio](./modules/audio.md) |
| `src/sound/` | Stem engines: DSP synths, sampler, mix bus, weight, render worker, stem worklet | [sound](./modules/sound.md) |
| `src/app/` | The Mindless Midi page and the shared `Player` | [Mindless Midi](./apps/mindless-midi.md) |
| `src/mighty/` | Mighty Midi, a second front end tuned for weight | [Mighty Midi](./apps/mighty-midi.md) |
| `src/bench/` | Synthesis bench for A/B listening between engines | [bench](./apps/bench.md) |
| `styles/` | One directory per style (`brief.md`, `corpus.json`, `BUILD.bazel`), the style list and the samples lock | [styles and corpora](./concepts/styles-and-corpora.md) |
| `tools/` | Build-time and CLI tools: `generate`, `stylec`, `samples`, `render`, `serve`, `social` | [tools](./build/tools.md) |
| `bazel/` | Custom Starlark rules and macros | [Bazel rules](./build/bazel-rules.md) |
| `site/` | Assembles the Mindless Midi static site; `serve` and `deploy` targets | [deployment](./build/deployment.md) |
| `docs/` | Architecture diagram, plans, and this knowledge base | [plans](./plans/index.md) |
| `.github/` | CI workflows (`pages.yml`, `cloudflare.yml`) and the GitHub Pages redirect | [deployment](./build/deployment.md) |
| `.claude/launch.json` | Dev-server configs for the desktop preview: `site` (8080), `mighty` (8081), `bench` (8090) | [local development](./guides/local-development.md) |
| `.claude/skills/`, `.agents/`, `.pi/` | Agent skills installed by `rules_agents` (generated, git-ignored) | [agent skills](./build/agent-skills.md) |

Root files: `MODULE.bazel` (Bazel deps), `.bazelversion` (Bazel 9.2),
`.bazelrc` (including `--config=stamp`), `package.json` / `pnpm-lock.yaml`
(npm deps fetched by Bazel), `tsconfig.json` (browser) and
`tsconfig.node.json` (Node tools and tests).
