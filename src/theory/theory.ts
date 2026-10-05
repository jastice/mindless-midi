/**
 * Music theory primitives: pitch classes, modes, roman-numeral chords,
 * chord-scales, scale-degree arithmetic and voice-leading.
 *
 * Conventions:
 * - Pitch classes are integers 0..11 with C = 0.
 * - Intervals are semitones.
 * - MIDI note 60 is C4.
 */

export const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;

export const TONIC_NAMES = [
  "C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B",
] as const;
export type TonicName = (typeof TONIC_NAMES)[number];

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function pitchClass(name: string): number {
  const m = /^([A-Ga-g])([#b]?)$/.exec(name.trim());
  if (!m) throw new Error(`bad note name: ${name}`);
  const base = LETTER_PC[m[1]!.toUpperCase()]!;
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return mod(base + acc, 12);
}

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function noteName(midi: number): string {
  return `${NOTE_NAMES[mod(midi, 12)]}${Math.floor(midi / 12) - 1}`;
}

export const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
} as const satisfies Record<string, readonly number[]>;

export type ModeName = keyof typeof MODES;
export const MODE_NAMES = Object.keys(MODES) as ModeName[];

/** Display names, e.g. "harmonic minor" for harmonicMinor. */
export function modeLabel(mode: ModeName): string {
  return mode.replace(/[A-Z]/g, (c) => " " + c.toLowerCase());
}

/** Display name of a key, e.g. "C harmonic minor". */
export function keyLabel(tonic: number, mode: ModeName): string {
  return `${NOTE_NAMES[mod(tonic, 12)]} ${modeLabel(mode)}`;
}

// ---------------------------------------------------------------------------
// Roman numeral chords
// ---------------------------------------------------------------------------

export interface Chord {
  /** Normalized symbol as written in the corpus. */
  symbol: string;
  /** Root, in semitones above the key tonic (0..11). */
  root: number;
  /** Chord-tone intervals above the root, by function (null = absent). */
  third: number | null;
  fifth: number | null;
  seventh: number | null;
  /** Tensions above the root (mod 12), e.g. 2 for a 9th. */
  tensions: number[];
}

const NUMERALS: Array<[string, number]> = [
  ["VII", 11], ["VI", 9], ["IV", 5], ["V", 7], ["III", 4], ["II", 2], ["I", 0],
];

type Shape = { third: number | null; fifth: number | null; seventh: number | null; tensions: number[] };

/** Suffix → chord shape, given whether the numeral was upper case. */
const SUFFIXES: Record<string, (upper: boolean) => Shape> = {
  "": (u) => s(u ? 4 : 3, 7),
  m: () => s(3, 7),
  "+": () => s(4, 8),
  aug: () => s(4, 8),
  o: () => s(3, 6),
  "°": () => s(3, 6),
  dim: () => s(3, 6),
  o7: () => s(3, 6, 9),
  "°7": () => s(3, 6, 9),
  dim7: () => s(3, 6, 9),
  "ø": () => s(3, 6, 10),
  "ø7": () => s(3, 6, 10),
  m7b5: () => s(3, 6, 10),
  hd7: () => s(3, 6, 10),
  "7": (u) => s(u ? 4 : 3, 7, 10),
  m7: () => s(3, 7, 10),
  dom7: () => s(4, 7, 10),
  maj7: (u) => s(u ? 4 : 3, 7, 11),
  M7: (u) => s(u ? 4 : 3, 7, 11),
  "Δ": (u) => s(u ? 4 : 3, 7, 11),
  "Δ7": (u) => s(u ? 4 : 3, 7, 11),
  mM7: () => s(3, 7, 11),
  "6": (u) => s(u ? 4 : 3, 7, 9),
  m6: () => s(3, 7, 9),
  "69": (u) => s(u ? 4 : 3, 7, 9, [2]),
  "6/9": (u) => s(u ? 4 : 3, 7, 9, [2]),
  "9": (u) => s(u ? 4 : 3, 7, 10, [2]),
  m9: () => s(3, 7, 10, [2]),
  maj9: (u) => s(u ? 4 : 3, 7, 11, [2]),
  M9: (u) => s(u ? 4 : 3, 7, 11, [2]),
  "11": (u) => (u ? s(5, 7, 10, [2]) : s(3, 7, 10, [2, 5])),
  m11: () => s(3, 7, 10, [2, 5]),
  "13": (u) => s(u ? 4 : 3, 7, 10, [2, 9]),
  m13: () => s(3, 7, 10, [2, 9]),
  sus2: () => s(2, 7),
  sus4: () => s(5, 7),
  sus: () => s(5, 7),
  "7sus4": () => s(5, 7, 10),
  "7sus": () => s(5, 7, 10),
  "9sus4": () => s(5, 7, 10, [2]),
  "9sus": () => s(5, 7, 10, [2]),
  add9: (u) => s(u ? 4 : 3, 7, null, [2]),
  madd9: () => s(3, 7, null, [2]),
  add11: (u) => s(u ? 4 : 3, 7, null, [5]),
  "5": () => s(null, 7),
  "7b9": () => s(4, 7, 10, [1]),
  "7#9": () => s(4, 7, 10, [3]),
  "7#11": () => s(4, 7, 10, [6]),
  "7b13": () => s(4, 7, 10, [8]),
  "7#5": () => s(4, 8, 10),
  "7b5": () => s(4, 6, 10),
  "maj7#11": () => s(4, 7, 11, [6]),
  "Δ#11": () => s(4, 7, 11, [6]),
  "m7b9": () => s(3, 7, 10, [1]),
};

function s(third: number | null, fifth: number | null, seventh: number | null = null, tensions: number[] = []): Shape {
  return { third, fifth, seventh, tensions };
}

export const CHORD_SUFFIXES = Object.keys(SUFFIXES);

const chordCache = new Map<string, Chord>();

/**
 * Parse a roman numeral relative to the MAJOR scale of the key: "I" is the
 * tonic, "bVI" is 8 semitones up, "#iv" is 6 semitones up. Case selects a
 * major/minor triad; the suffix selects the chord quality.
 */
export function parseRoman(symbol: string): Chord {
  const cached = chordCache.get(symbol);
  if (cached) return cached;
  const raw = symbol.trim().replace(/♭/g, "b").replace(/♯/g, "#");
  const m = /^([b#]?)([IViv]+)(.*)$/.exec(raw);
  if (!m) throw new Error(`unparseable chord symbol "${symbol}"`);
  const acc = m[1] === "b" ? -1 : m[1] === "#" ? 1 : 0;
  const numeral = m[2]!;
  const upper = numeral === numeral.toUpperCase();
  if (!upper && numeral !== numeral.toLowerCase()) {
    throw new Error(`mixed-case numeral in "${symbol}"`);
  }
  const entry = NUMERALS.find(([n]) => n === numeral.toUpperCase());
  if (!entry) throw new Error(`unknown numeral "${numeral}" in "${symbol}"`);
  const shapeFn = SUFFIXES[m[3]!];
  if (!shapeFn) {
    throw new Error(`unknown chord quality "${m[3]}" in "${symbol}" (known: ${CHORD_SUFFIXES.filter(Boolean).join(" ")})`);
  }
  const shape = shapeFn(upper);
  const chord: Chord = { symbol, root: mod(entry[1] + acc, 12), ...shape };
  chordCache.set(symbol, chord);
  return chord;
}

/** Chord tones as intervals above the root: root, 3rd, 5th, 7th, then tensions. */
export function chordIntervals(c: Chord, withTensions = true): number[] {
  const out = [0];
  if (c.third !== null) out.push(c.third);
  if (c.fifth !== null) out.push(c.fifth);
  if (c.seventh !== null) out.push(c.seventh);
  if (withTensions) for (const t of c.tensions) if (!out.includes(t)) out.push(t);
  return out;
}

/** Absolute pitch classes of a chord in a key. */
export function chordPitchClasses(tonic: number, c: Chord, withTensions = true): number[] {
  return chordIntervals(c, withTensions).map((i) => mod(tonic + c.root + i, 12));
}

/**
 * Pitch classes a sustained melody note can rest on without a half-step
 * clash: chord tones, minus any that sit a semitone above another voiced
 * tone (e.g. the root of a maj7 chord, the 3rd of a minor-9th).
 */
export function stableMelodyPitchClasses(tonic: number, c: Chord): number[] {
  const voiced = voicedIntervals(c);
  const stable = chordIntervals(c, false).filter((i) => !voiced.includes(mod(i - 1, 12)));
  return (stable.length ? stable : [c.third ?? c.fifth ?? 0]).map((i) => mod(tonic + c.root + i, 12));
}

/**
 * Chord-scale pitch classes that don't rub a half step above a voiced chord
 * tone: what a melody note longer than a passing tone may use.
 */
export function clashFreeScalePitchClasses(tonic: number, mode: ModeName, c: Chord): number[] {
  const voiced = voicedIntervals(c);
  const ok = chordScale(mode, c).filter((i) => voiced.includes(i) || !voiced.includes(mod(i - 1, 12)));
  return ok.map((i) => mod(tonic + c.root + i, 12));
}

/** Chord tones plus the first tension: what comping voicings may contain. */
function voicedIntervals(c: Chord): number[] {
  const voiced = chordIntervals(c, false);
  if (c.tensions[0] !== undefined) voiced.push(c.tensions[0]);
  return voiced;
}

/**
 * Seven-note chord-scale starting on the chord root, as intervals above the
 * root, ordered by slot: [root, 9th, 3rd, 11th, 5th, 13th, 7th]. Chord tones
 * occupy their slots; empty slots are filled from the mode so melodies stay
 * in key (the melody writer puts chord tones on strong beats), falling back to
 * the least clashing tension when the chord is foreign to the mode.
 */
export function chordScale(mode: ModeName, c: Chord): number[] {
  const modeRel = new Set(MODES[mode].map((pc) => mod(pc - c.root, 12)));
  const tones = new Set(chordIntervals(c));
  const fill = (region: number[], fallback: number[]): number => {
    for (const r of region) if (tones.has(r)) return r;
    for (const r of region) if (modeRel.has(r)) return r;
    for (const r of fallback) if (!clashes(r)) return r;
    return fallback[0]!;
  };
  const clashes = (r: number): boolean => {
    for (const t of tones) {
      const d = Math.abs(t - r);
      if (d === 1 || d === 11) return true;
    }
    return false;
  };
  const slots = [
    0,
    fill([2, 1], [2, 1]),
    c.third ?? fill([3, 4], [4, 3]),
    fill([5, 6], [5, 6]),
    c.fifth ?? fill([7, 6, 8], [7]),
    fill([9, 8], [9, 8]),
    c.seventh ?? fill([10, 11], [10, 11]),
  ];
  for (let i = 1; i < slots.length; i++) {
    if (slots[i]! < slots[i - 1]!) slots[i] = slots[i - 1]!;
  }
  return slots;
}

/** Mode scale as intervals above the tonic. */
export function modeScale(mode: ModeName): number[] {
  return [...MODES[mode]];
}

/**
 * Map a scale degree to MIDI. `scale` holds 7 non-decreasing intervals above
 * the anchor; `anchorMidi` is the MIDI note of degree 0.
 */
export function degreeToMidi(scale: readonly number[], deg: number, anchorMidi: number): number {
  const n = scale.length;
  const oct = Math.floor(deg / n);
  const idx = mod(deg, n);
  return anchorMidi + 12 * oct + scale[idx]!;
}

/** Nearest MIDI note whose pitch class is in `pcs` (ties resolve downward). */
export function snapToPitchClasses(midi: number, pcs: readonly number[]): number {
  if (pcs.length === 0) return midi;
  for (let d = 0; d <= 6; d++) {
    if (pcs.includes(mod(midi - d, 12))) return midi - d;
    if (pcs.includes(mod(midi + d, 12))) return midi + d;
  }
  return midi;
}

/** Place a pitch class in the octave closest to `near`. */
export function nearestWithPitchClass(pc: number, near: number): number {
  const base = near - mod(near - pc, 12);
  return near - base <= 6 ? base : base + 12;
}

/** Fold a MIDI note into [low, high] by octaves. */
export function foldIntoRange(midi: number, low: number, high: number): number {
  let n = midi;
  while (n < low) n += 12;
  while (n > high) n -= 12;
  if (n < low) n += 12; // range narrower than an octave: prefer staying above low
  return n;
}

// ---------------------------------------------------------------------------
// Voicing
// ---------------------------------------------------------------------------

export const VOICINGS = ["close", "open", "shell", "spread", "power", "rootless", "triad"] as const;
export type Voicing = (typeof VOICINGS)[number];

/** Which chord members a voicing uses, as intervals above the root. */
export function voicingIntervals(c: Chord, v: Voicing): number[] {
  const third = c.third ?? c.fifth ?? 7;
  const fifth = c.fifth ?? 7;
  switch (v) {
    case "power":
      return [0, fifth];
    case "triad":
      return [0, third, fifth];
    case "shell":
      return [0, third, c.seventh ?? fifth];
    case "rootless": {
      const top = c.tensions[0] ?? fifth;
      return [third, fifth, c.seventh ?? 0, top].filter((x, i, a) => a.indexOf(x) === i);
    }
    case "close":
    case "open":
    case "spread":
    default: {
      const out = [0, third, fifth];
      if (c.seventh !== null) out.push(c.seventh);
      if (c.tensions[0] !== undefined && out.length < 5) out.push(c.tensions[0]);
      return out.filter((x, i, a) => a.indexOf(x) === i);
    }
  }
}

/**
 * Choose concrete MIDI notes for a chord, near `center`, moving as little as
 * possible from the previous voicing.
 */
export function voiceChord(
  tonic: number,
  c: Chord,
  v: Voicing,
  center: number,
  prev: readonly number[] | null,
): number[] {
  const rootPc = mod(tonic + c.root, 12);
  const pcs = voicingIntervals(c, v).map((i) => mod(rootPc + i, 12));

  const candidates: number[][] = [];
  if (v === "power") {
    const r = nearestWithPitchClass(rootPc, center - 4);
    candidates.push([r, r + mod(pcs[1]! - rootPc, 12), r + 12]);
  } else if (v === "spread") {
    // Root low, the rest as a close upper structure an octave+ above.
    const bass = nearestWithPitchClass(rootPc, center - 12);
    for (const upper of closeInversions(pcs.slice(1), center + 2)) {
      candidates.push([bass, ...upper]);
    }
  } else {
    for (const inv of closeInversions(pcs, center)) {
      if (v === "open" && inv.length >= 3) {
        // drop-2: second voice from the top drops an octave
        const d = inv.slice();
        const i = d.length - 2;
        d[i] = d[i]! - 12;
        candidates.push(d.sort((a, b) => a - b));
      } else {
        candidates.push(inv);
      }
    }
  }

  let best = candidates[0]!;
  let bestCost = Infinity;
  for (const cand of candidates) {
    const mid = (cand[0]! + cand[cand.length - 1]!) / 2;
    let cost = Math.abs(mid - center) * 0.6;
    if (prev && prev.length) cost += movement(prev, cand);
    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }
  return best;
}

function closeInversions(pcs: readonly number[], center: number): number[][] {
  const out: number[][] = [];
  for (let rot = 0; rot < pcs.length; rot++) {
    const order = [...pcs.slice(rot), ...pcs.slice(0, rot)];
    for (const shift of [-12, 0, 12]) {
      const notes: number[] = [];
      let cur = nearestWithPitchClass(order[0]!, center - 5 + shift);
      notes.push(cur);
      for (let i = 1; i < order.length; i++) {
        cur = cur + (mod(order[i]! - cur, 12) || 12);
        notes.push(cur);
      }
      out.push(notes);
    }
  }
  return out;
}

/** Total semitone movement between two voicings (greedy nearest matching). */
function movement(a: readonly number[], b: readonly number[]): number {
  let cost = 0;
  for (const n of b) {
    let best = Infinity;
    for (const p of a) best = Math.min(best, Math.abs(n - p));
    cost += best;
  }
  return cost / Math.max(1, b.length) * 2;
}

/** Lead-sheet name for a roman-numeral chord in a key, e.g. ii7 in C -> "Dm7". */
export function chordName(tonic: number, symbol: string): string {
  const c = parseRoman(symbol);
  const m = /^[b#]?([IViv]+)(.*)$/.exec(symbol.trim().replace(/♭/g, "b").replace(/♯/g, "#"));
  const lower = m ? m[1] === m[1]!.toLowerCase() : false;
  let suffix = m?.[2] ?? "";
  if (lower && !/^(m|o|°|dim|ø|hd|\+|aug|sus|5)/.test(suffix)) suffix = "m" + (suffix === "maj7" ? "Maj7" : suffix);
  return NOTE_NAMES[mod(tonic + c.root, 12)] + suffix;
}
