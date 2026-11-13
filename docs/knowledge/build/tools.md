---
type: Tooling
title: Tools
description: The Node programs in tools/ used at build time or from the command line (generate, stylec, samples, render, serve, social).
resource: ../../../tools
tags: [tools, build, cli]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# Tools

| Tool | Run as | What it does |
| --- | --- | --- |
| `tools/generate` | `bazel run //styles:regen -- styles/<id>` | Regenerates corpora with Claude from `brief.md`, validates, repairs. `--dry-run`, `--model <id>`. See [regenerate a style](../guides/regenerate-style.md). |
| `tools/stylec` | via `music_style` / `style_pack` | Build-time style compiler: `stylec bundle` validates, attaches metadata and calibrates loudness by rendering through the real FM synth. |
| `tools/samples` | via `style_samples` | Build-time sample fetcher; see [samples](./samples.md). |
| `tools/render` | `bazel run //tools/render -- …` | Offline rendering through the same event queue as the worklet, with libADLMIDI's WASM in Node. Also holds `calibrate_lib.ts` (loudness calibration used by `stylec`). See [render offline](../guides/render-offline.md). |
| `tools/serve` | via `//site:serve` etc. | Minimal static file server; `PORT=` overrides, falls forward to the next free port. |
| `tools/social` | `tools/social/render.sh` | Re-renders the link-preview card `src/app/social.png` from `card.html` with headless Chrome. |
| `tools/workspace_status.sh` | `--config=stamp` | Workspace status for build stamping. |

Note: `tools/render` renders the FM path only; the stem engines' bus is a Web
Audio graph and renders only in a browser (see the
[heavier sound plan](../plans/heavier-sound.md)).
