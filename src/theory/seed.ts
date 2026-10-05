/**
 * Human-friendly session seeds: three music words, e.g. "mellow-tritone-waltz".
 * Seeds are opaque to the arranger (any string works); this only makes the
 * ones we generate easier to read, remember and share.
 */

const MOODS = [
  "amber", "bright", "breezy", "dreamy", "dusky", "eerie", "gentle", "glassy",
  "golden", "hazy", "hollow", "jaunty", "lazy", "lilting", "lush", "mellow",
  "misty", "moody", "muted", "neon", "nimble", "plucky", "quiet", "restless",
  "rosy", "silken", "sleepy", "smoky", "soft", "sunny", "velvet", "wistful",
];

const THEORY = [
  "arpeggio", "augmented", "cadence", "canon", "chord", "chorale", "coda", "diminished",
  "dorian", "drone", "fermata", "fugue", "glissando", "harmonic", "interval", "lydian",
  "major", "minor", "modal", "mixolydian", "octave", "ostinato", "pedal", "phrygian",
  "refrain", "riff", "sequence", "staccato", "suspension", "syncopation", "tritone", "unison",
];

const FORMS = [
  "ballad", "bossa", "bolero", "calypso", "capriccio", "carol", "chanson", "etude",
  "fandango", "gavotte", "gigue", "groove", "jingle", "lullaby", "mambo", "mazurka",
  "minuet", "nocturne", "overture", "polka", "prelude", "rhapsody", "rondo", "samba",
  "serenade", "shuffle", "sonata", "swing", "tango", "tune", "waltz", "zydeco",
];

function pick<T>(list: readonly T[], r: number): T {
  return list[Math.floor(r * list.length)] as T;
}

/** `random` returns floats in [0, 1); defaults to crypto-backed randomness. */
export function randomSeed(random: () => number = cryptoRandom): string {
  return [pick(MOODS, random()), pick(THEORY, random()), pick(FORMS, random())].join("-");
}

function cryptoRandom(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (a[0] ?? 0) / 4294967296;
}
