---
type: Guide
title: Local development
description: Commands to serve the three pages locally, run every test, and build the static site.
tags: [guide, dev, bazel]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# Local development

Requires [Bazelisk](https://github.com/bazelbuild/bazelisk); Bazel fetches
everything else, including Node.

# Examples

```bash
bazel run //site:serve          # Mindless Midi, http://localhost:8080
bazel run //src/mighty:serve    # Mighty Midi,  http://localhost:8081
bazel run //src/bench:serve     # Bench,        http://localhost:8090
bazel test //...                # all tests
bazel build //site              # static site
```

The same three servers are configured in `.claude/launch.json` (`site`,
`mighty`, `bench`) for the Claude desktop preview.

## Tests

| Target | Covers |
| --- | --- |
| `//src/theory:theory_test` | Theory primitives |
| `//src/corpus:validate_test` | Every checked-in corpus validates |
| `//src/engine:engine_test` | Arranger behaviour, register bounds |
| `//src/audio:events_test`, `:leveler_test` | FM event queue and output stage |
| `//src/sound:sampler_test`, `:weight_test` | Sampler planning; weight metrics on real renders |
| `//tools/render:render_test`, `//tools/generate:generate_test` | Offline render; generator |

Tests use `node:test` via `ts_test` ([Bazel rules](../build/bazel-rules.md)).
