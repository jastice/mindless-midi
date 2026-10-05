/** Corpus vocabulary that browser code needs at runtime (kept free of zod). */

export const ROLES = ["lead", "counter", "arp", "pad", "comp", "bass", "drums"] as const;
export type Role = (typeof ROLES)[number];

export const DRUM_LANES = [
  "kick", "snare", "rim", "clap", "closedHat", "openHat", "ride", "crash", "tomLow", "tomHigh", "shaker",
] as const;
export type DrumLane = (typeof DRUM_LANES)[number];
