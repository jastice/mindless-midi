# Psychedelic House

Written by hand, not by `//tools/generate`. For DJ Claudia's pack only.

Warmer, rounder and more melodic than the two technos. 118 to 126 bpm, 4/4,
sixteenths with a little swing. Dorian, aeolian and mixolydian keys, three on
each of five scales a fifth apart, so they are near each other and near the
technos' keys.

A soft round kick with no rumble, and a bass that answers it: every bass note
is off the beat. Soft noise hats, an off-beat open hat, a clap on two and
four, a shaker, and congas and a bongo tuned to the track's key.

The signature is the acid line: a square wave through a resonant filter, with
accents that bark and slides that are tied (the synth plays a slid note as
the same note, on a patch with `glide`). Its cutoff travels on its own over
24 bars and drifts across sections. Beside it a small pluck that keeps to the
tonic, fourth, fifth and octave, in loops of two, three and five bars: it is
the cooler of the two running lines, so it is the one the set plays over
another track's low end. A hollow organ stab that holds, an electric piano
chord that rings, a pad through a band that phases over six bars. Echoes come
from the mix preset (`src/sound/bus.ts`) and the `throw` move.

The chords have no third of their own (sus, bare fifths, the flat seven, the
minor five), so one set of progressions serves all three modes; the mode's
colour is in the lines. Sections of 16 and 32 bars: a breakdown without the
low end, an 8-bar build, a peak. At most nine parts at once, three pitched
lines, two percussion parts, two noise layers. Each part is tiny; the
interest is in what enters and leaves and in the slow movement of filters.

Sounds are tuned by measurement (`src/sound/psychedelic_house.test.ts`).
Nobody has listened.
