/**
 * Set names for DJ Claudia, in a club register: a German compound of two of
 * these words and a two-digit cloakroom number, e.g. "NACHTHALLE-60" or
 * "FUNKENKELLER-38". The name is the set's seed, as Mindless Midi's three
 * music words are; any string still works as one, so links with older seeds
 * (like "KALT-7731") play as they did.
 */

export const SET_WORDS = [
  "KALT", "NEBEL", "ROST", "BETON", "STAHL", "ASCHE", "NACHT", "DUNST",
  "FROST", "BLEI", "RAUCH", "HALLE", "KELLER", "TUNNEL", "GLUT", "ECHO",
  "PULS", "STROM", "GRAU", "TIEF", "LEER", "STILL", "DUNKEL", "NASS",
  "EISEN", "SCHACHT", "SCHICHT", "FUNKE", "WERK", "HOF", "KAMMER", "LICHT",
] as const;

/** Adjectives: only ever the first half of a compound (GRAUKELLER, not KELLERGRAU). */
const ADJECTIVES: ReadonlySet<string> = new Set(["KALT", "GRAU", "TIEF", "LEER", "STILL", "DUNKEL", "NASS"]);
/** The Fugen-n: these take an -n before a second word (FUNKENKELLER, HALLENECHO, ASCHENDUNST). */
const LINKED: Readonly<Record<string, string>> = { HALLE: "HALLEN", ASCHE: "ASCHEN", FUNKE: "FUNKEN" };

/** Every compound: any word, then a noun other than itself (775 of them). */
export const SET_COMPOUNDS: readonly string[] = SET_WORDS.flatMap((first) =>
  SET_WORDS.filter((second) => second !== first && !ADJECTIVES.has(second)).map((second) => `${LINKED[first] ?? first}${second}`),
);

/** `random` returns floats in [0, 1); defaults to crypto-backed randomness. */
export function setName(random: () => number = cryptoRandom): string {
  const word = SET_COMPOUNDS[Math.floor(random() * SET_COMPOUNDS.length)]!;
  const ticket = 10 + Math.floor(random() * 90);
  return `${word}-${ticket}`;
}

/** Whether `s` has the shape of a set name (an older seed need not). */
export const isSetName = (s: string): boolean => /^[A-Z]+-[1-9]\d$/.test(s);

function cryptoRandom(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (a[0] ?? 0) / 4294967296;
}
