/**
 * Part writers. Each turns corpus material + harmonic context into notes for
 * one bar. Times are bar-relative beats; swing and humanization are applied
 * afterwards by the piece.
 */
import type { CompPattern, DrumLane, DrumPattern, Instrument, MelodyRules, Motif, PatternNote, Role } from "../corpus/schema.js";
import { DRUM_LANES } from "../corpus/constants.js";
import { Rng } from "../theory/rng.js";
import {
  chordScale,
  clashFreeScalePitchClasses,
  degreeToMidi,
  foldIntoRange,
  type ModeName,
  modeScale,
  mod,
  nearestWithPitchClass,
  snapToPitchClasses,
  stableMelodyPitchClasses,
  voiceChord,
} from "../theory/theory.js";
import type { ChordSpan, Harmony } from "./harmony.js";
import { CHANNELS, type NoteEvent } from "./types.js";

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

/** Everything a part writer needs to know about the current bar. */
export interface BarContext {
  rng: Rng;
  tonic: number;
  mode: ModeName;
  harmony: Harmony;
  beatsPerBar: number;
  /** Section-relative beat at which this bar starts. */
  barStart: number;
  barInSection: number;
  sectionBars: number;
  intensity: number;
  instrument: Instrument;
}

/** Mutable state that persists across bars within a piece. */
export interface PartMemory {
  voicing: Map<Role, number[]>;
  lastNote: Map<Role, number>;
  phrases: Map<string, PhraseNote[]>;
}

export function newMemory(): PartMemory {
  return { voicing: new Map(), lastNote: new Map(), phrases: new Map() };
}

function vel(v: number, intensity: number, accent = 1): number {
  const scaled = v * (0.62 + 0.38 * intensity) * accent;
  return Math.max(1, Math.min(127, Math.round(scaled * 127)));
}

function registerCenter(inst: Instrument): number {
  return 12 * (inst.octave + 1);
}

// ---------------------------------------------------------------------------
// Drums
// ---------------------------------------------------------------------------

const DRUM_VEL: Record<string, number> = { X: 1, x: 0.78, o: 0.42 };

/** Whether a pattern plays a kit with cymbals (not, say, a bodhrán or congas). */
export function hasCymbals(pattern: DrumPattern): boolean {
  return (["closedHat", "openHat", "ride", "crash"] as const).some((l) => pattern.lanes[l].length > 0);
}

export function writeDrums(ctx: BarContext, pattern: DrumPattern, opts: { crash: boolean }): NoteEvent[] {
  const out: NoteEvent[] = [];
  const step = 1 / pattern.stepsPerBeat;
  for (const lane of DRUM_LANES) {
    const s = pattern.lanes[lane];
    for (let i = 0; i < s.length; i++) {
      const v = DRUM_VEL[s[i]!];
      if (v === undefined) continue;
      out.push({
        beat: i * step,
        dur: Math.min(step, 0.25),
        ch: CHANNELS.drums,
        key: GM_DRUMS[lane],
        vel: vel(v, ctx.intensity),
        role: "drums",
      });
    }
  }
  if (opts.crash && !out.some((n) => n.beat === 0 && n.key === GM_DRUMS.crash)) {
    out.push({ beat: 0, dur: 0.25, ch: CHANNELS.drums, key: GM_DRUMS.crash, vel: vel(0.85, ctx.intensity), role: "drums" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Motif-driven parts (bass, arp): an ostinato that follows the chords
// ---------------------------------------------------------------------------

/** Resolve a pattern note to MIDI under the chord sounding at its onset. */
export function resolveDegree(
  ctx: Pick<BarContext, "tonic" | "mode" | "harmony">,
  anchor: Motif["anchor"],
  note: Pick<PatternNote, "deg" | "approach">,
  sectionBeat: number,
  center: number,
): number {
  const span = ctx.harmony.at(sectionBeat);
  const rootPc = mod(ctx.tonic + span.chord.root, 12);
  if (note.approach) {
    // Lead into whatever chord sounds on the next beat (often the same one).
    const next = ctx.harmony.at(Math.floor(sectionBeat + 1e-9) + 1);
    const target = nearestWithPitchClass(mod(ctx.tonic + next.chord.root, 12), center);
    // Approach from below, unless that would sink under the register.
    return target + (target - 1 < center - 7 ? 1 : -1);
  }
  if (anchor === "chord") {
    const anchorMidi = nearestWithPitchClass(rootPc, center);
    return degreeToMidi(chordScale(ctx.mode, span.chord), note.deg, anchorMidi);
  }
  const tonicMidi = nearestWithPitchClass(mod(ctx.tonic, 12), center);
  const raw = degreeToMidi(modeScale(ctx.mode), note.deg, tonicMidi);
  // Keep key-anchored contours, but make them agree with the current chord.
  const scalePcs = chordScale(ctx.mode, span.chord).map((i) => mod(rootPc + i, 12));
  return snapToPitchClasses(raw, scalePcs);
}

export function writeOstinato(ctx: BarContext, motif: Motif, range: [number, number]): NoteEvent[] {
  const out: NoteEvent[] = [];
  const role = motif.role === "bass" ? "bass" : "arp";
  const center = registerCenter(ctx.instrument) + (role === "bass" ? 4 : 0);
  const barEnd = ctx.barStart + ctx.beatsPerBar;
  // Motif repetitions overlapping this bar.
  const firstRep = Math.floor(ctx.barStart / motif.lengthBeats);
  for (let rep = firstRep; rep * motif.lengthBeats < barEnd; rep++) {
    const repStart = rep * motif.lengthBeats;
    for (const n of motif.notes) {
      const t = repStart + n.t;
      if (t < ctx.barStart - 1e-9 || t >= barEnd - 1e-9) continue;
      let key = resolveDegree(ctx, motif.anchor, n, t, center);
      key = foldIntoRange(key, range[0], range[1]);
      // Don't let held notes ring through a chord change.
      const span = ctx.harmony.at(t);
      const dur = Math.max(0.05, Math.min(n.d, span.end - t + (n.approach ? 0 : 0.02)));
      out.push({ beat: t - ctx.barStart, dur, ch: CHANNELS[role], key, vel: vel(n.v, ctx.intensity), role });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chords (pad, comp)
// ---------------------------------------------------------------------------

export function writeChords(ctx: BarContext, pattern: CompPattern, memory: PartMemory): NoteEvent[] {
  const out: NoteEvent[] = [];
  const role = pattern.role;
  const center = registerCenter(ctx.instrument) + 4;
  const barEnd = ctx.barStart + ctx.beatsPerBar;
  // Hits from earlier bars can still be sounding (an 8-beat pad, say).
  const reach = Math.max(...pattern.hits.map((h) => h.t + h.d));
  const firstRep = Math.max(0, Math.floor((ctx.barStart - reach) / pattern.lengthBeats));
  for (let rep = firstRep; rep * pattern.lengthBeats < barEnd; rep++) {
    const repStart = rep * pattern.lengthBeats;
    for (const hit of pattern.hits) {
      const t0 = repStart + hit.t;
      const end = t0 + hit.d;
      if (t0 >= barEnd - 1e-9 || end <= ctx.barStart + 1e-9) continue;
      // A hit that crosses a chord change is split and re-voiced. Each piece
      // is written by the bar it starts in and rings for its full length.
      for (const span of ctx.harmony.between(t0, end)) {
        const segStart = Math.max(t0, span.start);
        const segEnd = Math.min(end, span.end);
        if (segStart < ctx.barStart - 1e-9 || segStart >= barEnd - 1e-9) continue;
        if (segEnd - segStart < 0.1) continue;
        const prev = memory.voicing.get(role) ?? null;
        const notes = voiceChord(ctx.tonic, span.chord, pattern.voicing, center, prev);
        memory.voicing.set(role, notes);
        notes.forEach((key, i) => {
          const offset = i * pattern.strum;
          if (segStart + offset >= segEnd) return;
          out.push({
            beat: segStart + offset - ctx.barStart,
            dur: Math.max(0.05, segEnd - segStart - offset - 0.02),
            ch: CHANNELS[role],
            key,
            vel: vel(hit.v * (i === 0 ? 1 : 0.92), ctx.intensity),
            role,
          });
        });
      }
    }
  }
  return out;
}

/** Pad that ignores rhythm and just holds each chord (used for endings). */
export function holdChord(ctx: BarContext, span: ChordSpan, role: Role, dur: number, memory: PartMemory, v = 0.6): NoteEvent[] {
  const center = registerCenter(ctx.instrument) + 4;
  const notes = voiceChord(ctx.tonic, span.chord, role === "bass" ? "power" : "spread", center, memory.voicing.get(role) ?? null);
  return notes.map((key) => ({ beat: 0, dur, ch: CHANNELS[role], key, vel: vel(v, ctx.intensity), role }));
}

// ---------------------------------------------------------------------------
// Melody (lead, counter): phrases built from motif development
// ---------------------------------------------------------------------------

export interface PhraseNote {
  /** Section-relative beat. */
  t: number;
  d: number;
  deg: number;
  v: number;
  anchor: Motif["anchor"];
  cadence?: boolean;
  grace?: boolean;
}

interface Cell {
  notes: PatternNote[];
  length: number;
  anchor: Motif["anchor"];
}

function cellOf(m: Motif): Cell {
  return { notes: m.notes.map((n) => ({ ...n })), length: m.lengthBeats, anchor: m.anchor };
}

/** One developmental transformation of a cell. */
function develop(cell: Cell, rng: Rng, rules: MelodyRules): Cell {
  let notes = cell.notes.map((n) => ({ ...n }));
  const op = rng.weighted(
    ["sequence", "mutate", "split", "merge", "invert", "retrograde", "same"] as const,
    (o) =>
      ({
        sequence: 3,
        mutate: 3,
        split: 1 + 3 * rules.density,
        merge: 1 + 3 * (1 - rules.density),
        invert: 0.8,
        retrograde: 0.5,
        same: 1.5,
      })[o],
  );
  switch (op) {
    case "sequence": {
      const shift = rng.pick(cell.anchor === "key" ? [-2, -1, 1, 2, 3] : [-1, 1, 2]);
      notes.forEach((n) => (n.deg += shift));
      break;
    }
    case "mutate": {
      for (const n of notes) {
        if (rng.chance(0.3)) {
          const mag = rng.chance(rules.stepwise) ? 1 : rng.int(2, 3);
          n.deg += rng.chance(0.5) ? mag : -mag;
        }
      }
      break;
    }
    case "split": {
      const longs = notes.filter((n) => n.d >= 1);
      if (longs.length) {
        const n = rng.pick(longs);
        const half = n.d / 2;
        n.d = half;
        notes.push({ ...n, t: n.t + half, deg: n.deg + (rng.chance(0.5) ? 1 : -1), v: n.v * 0.85 });
      }
      break;
    }
    case "merge": {
      notes.sort((a, b) => a.t - b.t);
      if (notes.length > 2) {
        const i = rng.int(0, notes.length - 2);
        const a = notes[i]!;
        const b = notes[i + 1]!;
        a.d = b.t + b.d - a.t;
        notes.splice(i + 1, 1);
      }
      break;
    }
    case "invert": {
      const pivot = notes[0]?.deg ?? 0;
      notes.forEach((n) => (n.deg = pivot - (n.deg - pivot)));
      break;
    }
    case "retrograde": {
      const degs = notes.map((n) => n.deg).reverse();
      notes.forEach((n, i) => (n.deg = degs[i]!));
      break;
    }
    case "same":
      break;
  }
  notes = notes.sort((a, b) => a.t - b.t);
  return { ...cell, notes };
}

/** Make the last note of a phrase land on a stable tone and breathe. */
function cadence(cell: Cell, rng: Rng): Cell {
  const notes = cell.notes.map((n) => ({ ...n })).sort((a, b) => a.t - b.t);
  const last = notes[notes.length - 1];
  if (last) {
    const stable = cell.anchor === "chord" ? [0, 2, 4, 7] : [0, 2, 4, 7, -3];
    let best = stable[0]!;
    for (const s of stable) if (Math.abs(s - last.deg) < Math.abs(best - last.deg)) best = s;
    last.deg = best;
    last.d = Math.max(last.d, Math.min(cell.length - last.t, last.d + rng.pick([1, 1.5, 2])));
  }
  return { ...cell, notes };
}

/**
 * Compose a phrase of `bars` bars starting at section beat `start`, using an
 * a-a'-a-b style plan over the given motifs.
 */
export function composePhrase(
  motifs: Motif[],
  rules: MelodyRules,
  rng: Rng,
  start: number,
  beats: number,
  thin: number,
): PhraseNote[] {
  if (!motifs.length) return [];
  const primary = cellOf(motifs[0]!);
  const secondary = motifs[1] ? cellOf(motifs[1]) : develop(primary, rng, rules);
  const out: PhraseNote[] = [];
  let t = 0;
  let k = 0;
  let current = primary;
  while (t < beats - 1e-9) {
    const remaining = beats - t;
    let cell: Cell;
    if (k === 0) cell = current;
    else if (k % 4 === 3) cell = rng.chance(0.6) ? secondary : develop(current, rng, rules);
    else if (k % 2 === 1) cell = develop(current, rng, rules);
    else cell = rng.chance(0.7) ? primary : develop(primary, rng, rules);
    const isLast = remaining <= cell.length + 1e-9;
    if (isLast) cell = cadence(cell, rng);
    for (const n of cell.notes) {
      if (n.t >= remaining - 1e-9) continue;
      if (thin > 0 && n.t % 1 !== 0 && rng.chance(thin)) continue;
      const note: PhraseNote = {
        t: start + t + n.t,
        d: Math.min(n.d, remaining - n.t),
        deg: n.deg,
        v: n.v,
        anchor: cell.anchor,
      };
      if (rng.chance(rules.ornament * 0.5) && n.d >= 0.5 && n.t >= 0.125) {
        out.push({ ...note, t: note.t - 0.0833, d: 0.0833, deg: note.deg + 1, v: note.v * 0.7, grace: true });
      }
      out.push(note);
    }
    if (isLast) {
      const lastNote = out[out.length - 1];
      if (lastNote) lastNote.cadence = true;
    }
    t += cell.length;
    k++;
    current = cell;
  }
  return out;
}

export function writeMelody(
  ctx: BarContext,
  phrase: PhraseNote[],
  role: "lead" | "counter",
  range: [number, number],
  memory: PartMemory,
): NoteEvent[] {
  const out: NoteEvent[] = [];
  const barEnd = ctx.barStart + ctx.beatsPerBar;
  const center = Math.round((range[0] + range[1]) / 2);
  for (const n of phrase) {
    if (n.t < ctx.barStart - 1e-9 || n.t >= barEnd - 1e-9) continue;
    const raw = resolveDegree(ctx, n.anchor, n, n.t, center);
    const span = ctx.harmony.at(n.t);
    const strong = n.t % 2 === 0 || n.cadence;
    const prev = memory.lastNote.get(role);
    let allowed: number[] | null = null;
    if (!n.grace && ((strong && n.d >= 0.5) || n.d >= 1)) allowed = stableMelodyPitchClasses(ctx.tonic, span.chord);
    else if (!n.grace && n.d >= 0.5) allowed = clashFreeScalePitchClasses(ctx.tonic, ctx.mode, span.chord);
    let key = raw;
    if (allowed) {
      key = snapToPitchClasses(raw, allowed);
      // Don't let snapping flatten a moving line into repeated notes.
      if (prev !== undefined && key === prev && raw !== prev) {
        const other = allowed.filter((pc) => pc !== mod(prev, 12));
        if (other.length) key = snapToPitchClasses(raw + (raw > prev ? 1 : -1), other);
      }
    }
    key = foldIntoRange(key, range[0], range[1]);
    if (prev !== undefined && Math.abs(key - prev) > 9) {
      const alt = key + (key > prev ? -12 : 12);
      if (alt >= range[0] && alt <= range[1]) key = alt;
    }
    memory.lastNote.set(role, key);
    // Phrase arch: a little louder towards the middle of the bar group.
    const arch = 0.9 + 0.1 * Math.sin(Math.PI * ((n.t % (ctx.beatsPerBar * 2)) / (ctx.beatsPerBar * 2)));
    out.push({
      beat: n.t - ctx.barStart,
      dur: Math.max(0.05, Math.min(n.d, span.end - n.t + 1) - 0.03),
      ch: CHANNELS[role],
      key,
      vel: vel(n.v * arch, ctx.intensity),
      role,
    });
  }
  return out;
}
