/**
 * Set names for DJ Claudia, in a club register: a German word and a
 * cloakroom-style number, e.g. "KALT-7731". The name is the set's seed, as
 * Mindless Midi's three music words are; any string still works as one, so
 * links with older seeds play as they did.
 */

export const SET_WORDS = [
  "KALT", "NEBEL", "ROST", "BETON", "STAHL", "ASCHE", "NACHT", "DUNST",
  "FROST", "BLEI", "RAUCH", "HALLE", "KELLER", "TUNNEL", "GLUT", "ECHO",
  "PULS", "STROM", "GRAU", "TIEF", "LEER", "STILL", "DUNKEL", "NASS",
  "EISEN", "SCHACHT", "SCHICHT", "FUNKE", "WERK", "HOF", "KAMMER", "LICHT",
] as const;

/** `random` returns floats in [0, 1); defaults to crypto-backed randomness. */
export function setName(random: () => number = cryptoRandom): string {
  const word = SET_WORDS[Math.floor(random() * SET_WORDS.length)]!;
  const ticket = String(Math.floor(random() * 10000)).padStart(4, "0");
  return `${word}-${ticket}`;
}

/** Whether `s` has the shape of a set name (an older seed need not). */
export const isSetName = (s: string): boolean => /^[A-Z]+-\d{4}$/.test(s);

function cryptoRandom(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (a[0] ?? 0) / 4294967296;
}
