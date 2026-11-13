/** Corpus vocabulary that browser code needs at runtime (kept free of zod). */

export const ROLES = ["lead", "counter", "arp", "pad", "comp", "bass", "drums"] as const;
export type Role = (typeof ROLES)[number];

export const DRUM_LANES = [
  "kick", "snare", "rim", "clap", "closedHat", "openHat", "ride", "crash", "tomLow", "tomHigh", "shaker",
] as const;
export type DrumLane = (typeof DRUM_LANES)[number];

/**
 * How a note is played beyond its pitch, length and velocity. Each one stays
 * inside one MIDI channel: a slide is pitch bend, a swell is expression (CC11),
 * an accent is velocity, a choke is where the note stops.
 */
export const GESTURES = ["swell", "slide", "accent", "choke"] as const;
export type Gesture = (typeof GESTURES)[number];

/** General MIDI percussion key for each drum lane. */
export const GM_DRUMS: Record<DrumLane, number> = {
  kick: 36,
  snare: 38,
  rim: 37,
  clap: 39,
  closedHat: 42,
  openHat: 46,
  ride: 51,
  crash: 49,
  tomLow: 45,
  tomHigh: 50,
  shaker: 70,
};
