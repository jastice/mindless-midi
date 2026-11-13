---
type: Concept
title: Determinism and seeds
description: All music derives from one seed through forked PRNG streams, so a seed plus a style selection reproduces the same music, which powers shareable links, seeking and tests.
tags: [determinism, rng, architecture]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# Determinism and seeds

Every musical decision comes from the sfc32 PRNG in
[theory/rng.ts](../modules/theory.md). The [conductor](../modules/engine.md)
is a pure bar generator: the same seed and style selection always yield the
same notes.

`rng.fork(label)` derives independent streams per decision area, so adding a
new decision in one part of the arranger doesn't reshuffle the others. When
changing the arranger, prefer a new fork over drawing more numbers from an
existing stream if you want existing seeds to keep sounding the same.

## What depends on it

- [URL sessions](./url-session.md): a link with seed, position and styles
  replays to the same spot. Seeking replays from the seed (capped in
  `conductor.ts`), so it lands on the same piece as long as the selection
  hasn't changed along the way.
- Offline rendering (`tools/render`) and the [bench](../apps/bench.md) produce
  the same performance as the browser.
- Tests render real pieces and assert on them (`engine.test.ts`,
  `weight.test.ts`).

Generated seeds are three music words (`theory/seed.ts`), but any string works.
