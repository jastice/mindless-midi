---
type: Catalogue
title: Sample sources
description: Where recordings can come from, what each source holds, and what its licence says. Used now are the sources the Samples engine already fetches; the rest are candidates.
resource: ../../../styles/samples.lock.json
tags: [samples, licensing, catalogue]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T00:00:00Z }
sources:
  - id: samples-page
    resource: ./samples.md
    title: Samples
---

# Sample sources

A list of places to get recordings, kept apart from the build mechanics in
[Samples](./samples.md). It says where a sound came from and on what terms,
which is what the page's credits and any future release need.

How sources are judged for this project: a source counts when it states a free
licence or free use itself. Where the stated terms are loose ("free",
"royalty free") the entry says so, and the project accepts that for now.
Nothing here is content-addressed or mirrored yet; that is a later step.

Checked 2026-11-13 and 2026-11-14 against the sources' own pages. "Not
checked" means the claim comes from a search summary only.

## In use

| Source | Holds | Licence | Notes |
|---|---|---|---|
| [danigb/samples](https://github.com/danigb/samples) | Compilation, converted to ogg and m4a: drum machines (808-mini, Casio-RZ1, Casio-SK1, LM-2, MFB-512, Micro-Rhythmer-12, Roland-CR-8000, Drumtraks, TR-808, Yamaha-MR10), Sample Pi, Splendid Grand Piano, VCSL, Smolken bass, jlearman Rhodes, Old Piano, Mellotron, Wurlitzer | "Permissive licensed", per folder. Piano, VCSL, Smolken, Rhodes, Old Piano and Sample Pi are CC0 or public domain; Wurlitzer is CC BY 3.0 | The drum-machine folders carry no licence text in `dm.json`. Only `TR-808` has a note, which calls the set "ABSOLUTELY FREE" |
| [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) | General MIDI sets as per-note files: FluidR3_GM, MusyngKite, FatBoy, a tabla set | FluidR3_GM CC BY 3.0; MusyngKite and FatBoy CC BY-SA 3.0; tabla not stated | The share-alike on MusyngKite is the one to watch |
| [VCSL](https://github.com/sgossner/VCSL) | Versilian Community Sample Library: orchestral, world and unusual instruments | CC0 | Reached through danigb/samples |

## 909 and other drum machines

| Source | Holds | Licence | Notes |
|---|---|---|---|
| [danigb/sampled](https://github.com/danigb/sampled), `DM/` | CR-78, LM-2, MRK-2, TR-505, **TR-909 Detroit** (14 wav), **TR-909 SP** (16 wav, through an SP-1200) | "Public domain or similar"; each set names its source | Different repo from danigb/samples, wav only. The 909 sets credit [a free-kit post](http://www.flstudiomusic.com/2016/09/download-free-909-kits-stems-f9-audio.html) that no longer loads. Accepted for this project on the repo's own claim |
| [fluid-music/open-drums](https://github.com/fluid-music/open-drums) | TR-707, TR-808, TR-909 as npm packages; the 909 is Jason Baker's set with many tuning and decay variants | Original text: free to copy and distribute, no modification, not for profit | Taken from machines.hyperreal.org. Stricter than the entry above, so prefer danigb/sampled |
| [BVKER](https://bvker.com/?p=4640) | 200+ TR-909 one-shots, 100 loops | States "100% royalty free" | Accepted for this project. The statement sits next to site boilerplate, so confirm it covers this pack before shipping |
| [Trashy Techno Drums](https://rekkerd.org/?p=40132) | 202 909 one-shots | Royalty free | Custom terms, not CC0 |
| [Cassette 909](https://www.kvraudio.com/news/25795) | 71 clean 909 hits plus tape-processed ones, 24-bit wav | Not stated | |
| [geikha/tidal-drum-machines](https://github.com/geikha/tidal-drum-machines) | 72 machines laid out for Tidal and SuperDirt | None stated, no LICENSE file, no source credit | A large catalogue worth browsing, but unusable until its provenance is known |

## Instrument libraries

| Source | Holds | Licence | Notes |
|---|---|---|---|
| [sfzinstruments](https://github.com/sfzinstruments) | About 76 SFZ instruments, one repo each: Osiris Piano, Virtuosity Drums, Karoryfer basses, Weresax, steel drum, Rhodes | Mostly CC0-1.0; the steel drum is Unlicense. Per repo | The upstream for several danigb/samples folders. Only ten repos were read |
| Karoryfer Samples | Free packs, including basses, sax and drums | Reported as CC0 | Not checked: its own site did not list the packs. The same libraries appear in sfzinstruments |
| [FreePats](https://freepats.zenvoid.org/) | Sound banks: acoustic and electric percussion, synth bass, pads and leads, strings, piano, organ, guitar, ethnic | Not on the front page; read each bank's page | Not checked beyond the category list. Old Piano in danigb/samples comes from here as CC0 |
| [Meadowlark factory library](https://github.com/BillyDM/meadowlark-factory-library) | One-shots by category (kicks so far) | CC0-1.0, and it accepts no contribution that is not | Small today, strict licence policy |
| [University of Iowa MIS](https://theremin.music.uiowa.edu/MIS.html) | Woodwinds, brass, strings, marimba, vibraphone, bells, cymbals, hand percussion, piano, guitar | "Any project, no stated restrictions"; donations optional | Recordings since 1997, long single-note files that need cutting |
| [Signature Sounds](https://www.signaturesounds.org/) | Orchestral and 8-bit CC0 downloads | CC0 | Not checked |

## Search by licence

| Source | How to use it | Notes |
|---|---|---|
| [Freesound](https://freesound.org/) | Filter by licence CC0, then search the instrument | Per-sound licences differ; an upload tagged TR909 was CC BY 3.0. Record uploader and URL for each file used |

## Not suitable

- Loopmasters, ADSR, Gumroad and other paid packs.
- Samples without a stated source or licence, like the geikha set above.
- Mirrors whose upstream licence cannot be traced.

## When adding a source

1. Record its licence text or link and the date you read it.
2. Check the licence of each folder, not only the repo.
3. Note what the licence needs on the page (attribution for CC BY, share-alike
   for CC BY-SA).
4. Add its files to a style's sound declaration; the
   [loader](./samples.md) and lock file take it from there.
