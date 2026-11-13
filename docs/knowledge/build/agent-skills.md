---
type: Tooling
title: Agent skills
description: Repo-local skills for coding agents (Claude Code, Codex, pi), declared in Bazel with rules_agents and installed by running a runner target.
tags: [agents, bazel, tooling]
status: draft
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# Agent skills

`MODULE.bazel` depends on [rules_agents](https://github.com/jastice/rules_agents)
and pulls remote skills through its `skill_deps` extension (currently the
Open Knowledge Format skill, as `@okf_skill`, which was used to write this
knowledge base).

The root `BUILD.bazel` declares an `agent_profile` named `dev_profile` with
the skills, and one `agent_runner` per agent:

| Target | Installs into |
| --- | --- |
| `bazel run //:claude_dev` | `.claude/skills/` |
| `bazel run //:codex_dev` | `.agents/skills/` |
| `bazel run //:pi_dev` | `.pi/skills/` |

The installed directories are generated and git-ignored.

Status `draft`: this setup was uncommitted when this page was written.
