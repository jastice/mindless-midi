---
type: Concept
title: URL sessions
description: The page URL carries the whole listening session (seed, position, styles, engine) so a link reproduces the music from the same spot; localStorage keeps the last session.
tags: [app, url, persistence]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: README
---

# URL sessions

Implemented in `src/app/app.ts`.

| Parameter | Meaning |
| --- | --- |
| `seed` | The session seed (three music words when generated). |
| `at` | Place in the session, e.g. `at=13.4` is piece 13, bar 4; updated every bar. |
| `styles` | The selected style ids; absent means all styles. |
| `sound` | The [engine](./sound-engines.md); absent means Synth. |

Opening the page without a link resumes the last session from localStorage
where it left off (press Play; browsers won't autostart audio). A position is
replayed from the seed ([determinism](./determinism-and-seeds.md)); within a
session, going back replays what actually played.[^readme]

The old GitHub Pages address forwards links, with path and query, to
Cloudflare via `.github/pages-redirect/` ([deployment](../build/deployment.md)).

[^readme]: README
