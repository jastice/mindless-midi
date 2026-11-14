---
type: Web App
title: Mindless Midi (main page)
description: The main page in src/app; style picker, transport, scrolling score, and the shared Player that drives every engine.
resource: https://mindless-midi.trurl.systems/
tags: [app, frontend]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: README
---

# Mindless Midi (main page)

Code in `src/app/`, assembled into a static site by `//site`. Run it with
`bazel run //site:serve` (http://localhost:8080).

## Files

| File | Role |
| --- | --- |
| `app.ts` | Page wiring: style picker, transport, now-playing, Media Session, persistence. Each engine is also an "edition" of the page, styled in `styles.css` by `data-engine`. |
| `player.ts` | Main-thread playback. Owns the AudioContext and the engines, asks the [conductor](../modules/engine.md) for bars a few seconds ahead and ships them to the FM worklet or the stem render worker. Shared with [Mighty Midi](./mighty-midi.md) (`//src/app:player`). |
| `roll.ts` | The scrolling score: ink noteheads on two staves, lead in the style's spot colour, drums as crosses. |
| `media_anchor.ts` | Plays a silent looping clip while music plays, so media keys and the OS now-playing widget reach the page. |
| `index.html`, `styles.css`, `fonts/`, `favicon.svg`, `social.png` | Page shell and assets. `index.html` is stamped with the build commit by `stamp_build_info`. |

## Controls

<kbd>Space</kbd> play/pause, <kbd>N</kbd> next piece, <kbd>←</kbd>/<kbd>→</kbd>
step through segments (sections, then the ending). **⤓ MIDI** downloads the
last 10 minutes as `.mid`; **↻ Reseed** starts over with a new seed. The
progress bar can be dragged to pick a segment.[^readme]

The URL is the session (seed, position, styles, engine); see
[URL sessions](../concepts/url-session.md).

## Sound

The engine picker chooses between Synth (default), Samples and FM chip; see
[sound engines](../concepts/sound-engines.md). Playback scheduling is driven
by ticks from the audio thread, not timers, so it keeps going in background
tabs.

## Dev console

`mindlessMidi.player` and `mindlessMidi.styles` are exposed on `window` for tinkering.[^readme]

[^readme]: README
