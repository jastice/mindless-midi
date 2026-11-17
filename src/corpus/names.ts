/**
 * Track titles from a style's name theme (`names` in its corpus): word lists
 * and patterns, as records of that genre are titled. A set picks one per
 * track from the set seed, so a link shows the same titles.
 *
 * The titles a theme can make are numbered 0..size-1, every combination of
 * every pattern in turn. Track `i` takes number (a * i + b) mod size, with a
 * and b drawn from the seed and the style (a coprime to size): a permutation,
 * so no title comes back until every one has been used, and two tracks of a
 * style a few apart get titles far apart in the lists.
 */
import { Rng } from "../theory/rng.js";
import type { NameTheme } from "./schema.js";

const SLOT = /\{([a-z]+)\}/g;

/** A pattern split into its text and its slots: ["", "word", " ", "num", ""] for "{word} {num}". */
function parts(pattern: string): string[] {
  return pattern.split(SLOT);
}

/** How many titles a pattern makes, or 0 if it names a list the theme lacks. */
function patternSize(theme: NameTheme, pattern: string): number {
  let n = 1;
  parts(pattern).forEach((p, i) => {
    if (i % 2) n *= theme.lists[p]?.length ?? 0;
  });
  return n;
}

/** How many titles the theme makes. */
export function nameCount(theme: NameTheme): number {
  return theme.patterns.reduce((sum, p) => sum + patternSize(theme, p), 0);
}

/** Title number `k` (0 <= k < nameCount) of the theme. */
export function nameAt(theme: NameTheme, k: number): string {
  for (const pattern of theme.patterns) {
    const size = patternSize(theme, pattern);
    if (k >= size) {
      k -= size;
      continue;
    }
    // The last slot varies fastest.
    const ps = parts(pattern);
    for (let i = ps.length - 2; i >= 1; i -= 2) {
      const list = theme.lists[ps[i]!]!;
      ps[i] = list[k % list.length]!;
      k = Math.floor(k / list.length);
    }
    return ps.join("");
  }
  throw new RangeError(`title ${k} is past the theme's ${nameCount(theme)}`);
}

/** Every title the theme makes, in number order (for validation). */
export function* allNames(theme: NameTheme): Generator<string> {
  const n = nameCount(theme);
  for (let k = 0; k < n; k++) yield nameAt(theme, k);
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** A style as far as titling goes. */
export interface Titled {
  id: string;
  corpus: { title: string; names?: NameTheme | undefined };
}

/**
 * The title of track `track` (0-based) of the set `seed`, of `style`: from its
 * theme, or without one the style's title and the track's number.
 */
export function trackName(style: Titled, seed: string, track: number): string {
  const theme = style.corpus.names;
  const size = theme ? nameCount(theme) : 0;
  if (!theme || !size) return `${style.corpus.title} ${track + 1}`;
  const rng = new Rng(`${seed}/names/${style.id}`);
  const b = rng.int(0, size - 1);
  let a = size > 1 ? rng.int(1, size - 1) : 1;
  while (gcd(a, size) !== 1) a = (a % (size - 1)) + 1;
  return nameAt(theme, (((a * track) % size) + b) % size);
}
