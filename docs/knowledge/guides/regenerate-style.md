---
type: Guide
title: Regenerate a style
description: Rewrite one or more style corpora with Claude from their briefs, then review, recalibrate and listen.
tags: [guide, styles, llm]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: README
---

# Regenerate a style

```bash
bazel run //styles:regen -- styles/metroid
```

This sends `styles/metroid/brief.md` to Claude (`claude-opus-5-5`, adaptive
thinking, structured JSON output against the [corpus schema](../modules/corpus.md)),
runs the build's validator, feeds errors back for up to two repair rounds, and
overwrites `corpus.json`. Several directories can be passed at once.[^readme]

- Credentials: `ANTHROPIC_API_KEY` or an `ant auth login` profile.
- `--dry-run` prints the prompts without calling the API.
- `--model <id>` picks another model.

Afterwards: review the diff, rebuild (which recalibrates loudness), listen,
commit. Regenerating replaces a hand- or agent-authored corpus wholesale.

Code: `tools/generate/` ([tools](../build/tools.md)).

[^readme]: README
