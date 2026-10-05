/**
 * The bench's common input: the engine's bars for one style and seed,
 * flattened into absolute-time notes so every backend renders exactly the
 * same performance.
 */
import type { Role } from "../corpus/constants.js";
import type { Instrument, StyleBundle } from "../corpus/schema.js";
import { Conductor } from "../engine/conductor.js";
import { type Bar, barSeconds } from "../engine/types.js";

export interface ScoreNote {
  /** Onset and duration, seconds. */
  t: number;
  dur: number;
  key: number;
  vel: number;
  ch: number;
  role: Role;
  /** GM program sounding on this channel at the onset. */
  program: number;
  /** The next note of a monophonic line starts right where this one ends. */
  legato?: boolean;
}

/** Monophonic lead instruments the neural models (and the other backends) can swap in. */
export const LEADS = {
  violin: { label: "Violin", program: 40, range: [55, 96] },
  flute: { label: "Flute", program: 73, range: [62, 93] },
  tenor_saxophone: { label: "Tenor sax", program: 66, range: [46, 75] },
  trumpet: { label: "Trumpet", program: 56, range: [55, 82] },
} as const;
export type LeadId = keyof typeof LEADS;

export interface Score {
  style: StyleBundle;
  seconds: number;
  notes: ScoreNote[];
  /** The raw bars, for the OPL backend (which plays the engine's own events). */
  bars: Bar[];
  /** Kick drum onsets, for score-driven sidechain ducking. */
  kicks: number[];
  /** Tempo of the first bar. */
  bpm: number;
  /** Mix intent per role, from the corpus (lead may be overridden). */
  instruments: Map<Role, Instrument>;
  lead: LeadId | null;
  summary: string;
}

/**
 * `fromFullBand` skips the intro to the first bar where every role of the
 * piece is playing, so a short clip exercises all instruments.
 */
export function buildScore(style: StyleBundle, seed: string, seconds: number, lead: LeadId | null, fromFullBand = true): Score {
  const conductor = new Conductor([style], seed);
  const lookahead: Bar[] = [];
  for (let t = 0; t < 240 && (!lookahead.length || lookahead[lookahead.length - 1]!.info.pieceIndex === 0); ) {
    const bar = conductor.nextBar();
    lookahead.push(bar);
    t += barSeconds(bar);
  }
  const rolesIn = (b: Bar) => new Set(b.notes.map((n) => n.role)).size;
  const most = Math.max(...lookahead.map(rolesIn));
  const first = fromFullBand ? Math.max(0, lookahead.findIndex((b) => rolesIn(b) === most)) : 0;
  // Carry the skipped bars' setup (bank, programs, levels, gain) into the first kept bar.
  const setup = lookahead.slice(0, first).flatMap((b) => b.controls.map((c) => ({ ...c, beat: 0 })));
  const source = lookahead.slice(first);
  if (source[0]) source[0] = { ...source[0], controls: [...setup, ...source[0].controls] };
  const bars: Bar[] = [];
  const notes: ScoreNote[] = [];
  const program = new Map<number, number>();
  let t = 0;
  while (t < seconds) {
    const bar = source.shift() ?? conductor.nextBar();
    const spb = 60 / bar.bpm;
    for (const c of bar.controls) if (c.kind === "program") program.set(c.ch, c.value);
    for (const n of bar.notes) {
      const on = t + n.beat * spb;
      if (on >= seconds) continue;
      notes.push({ t: on, dur: Math.max(0.01, n.dur * spb), key: n.key, vel: n.vel, ch: n.ch, role: n.role, program: program.get(n.ch) ?? 0 });
    }
    bars.push(bar);
    t += barSeconds(bar);
  }
  notes.sort((a, b) => a.t - b.t || a.key - b.key);

  const instruments = new Map(style.corpus.instruments.map((i) => [i.role, i]));
  let out = notes;
  if (lead) {
    const spec = LEADS[lead];
    const lines = monophonic(notes.filter((n) => n.role === "lead"));
    const shift = octaveShift(lines, spec.range);
    for (const n of lines) {
      n.key += shift;
      n.program = spec.program;
    }
    out = [...notes.filter((n) => n.role !== "lead"), ...lines].sort((a, b) => a.t - b.t || a.key - b.key);
    const inst = instruments.get("lead");
    if (inst) instruments.set("lead", { ...inst, name: spec.label, program: spec.program });
    // The same edit for the OPL backend, which plays the bars themselves.
    patchLeadInBars(bars, lines, spec.program);
  }

  const head = bars[0]!;
  const info = head.info;
  const kicks = out.filter((n) => n.role === "drums" && (n.key === 35 || n.key === 36)).map((n) => n.t);
  const summary = `${info.styleTitle} · ${info.keyName} · ${Math.round(head.bpm)} bpm · from bar ${first + 1} (${info.section}) · ${out.length} notes`;
  return { style, seconds, notes: out, bars, kicks, bpm: head.bpm, instruments, lead, summary };
}

/**
 * Make a line playable by one voice: keep the top note of simultaneous
 * onsets, cut overlaps, and mark notes that run straight into the next.
 */
function monophonic(line: ScoreNote[]): ScoreNote[] {
  const byOnset: ScoreNote[] = [];
  for (const n of line) {
    const prev = byOnset[byOnset.length - 1];
    if (prev && Math.abs(prev.t - n.t) < 0.02) {
      if (n.key > prev.key) byOnset[byOnset.length - 1] = { ...n };
    } else byOnset.push({ ...n });
  }
  for (let i = 0; i + 1 < byOnset.length; i++) {
    const a = byOnset[i]!;
    const b = byOnset[i + 1]!;
    const gap = b.t - (a.t + a.dur);
    if (gap < 0) a.dur = Math.max(0.03, b.t - a.t);
    a.legato = gap < 0.03;
  }
  return byOnset;
}

function octaveShift(line: ScoreNote[], [lo, hi]: readonly [number, number]): number {
  if (!line.length) return 0;
  const keys = line.map((n) => n.key).sort((a, b) => a - b);
  const median = keys[Math.floor(keys.length / 2)]!;
  return Math.round(((lo + hi) / 2 - median) / 12) * 12;
}

function patchLeadInBars(bars: Bar[], line: ScoreNote[], program: number): void {
  let t = 0;
  let li = 0;
  const sorted = [...line].sort((a, b) => a.t - b.t);
  for (const bar of bars) {
    const spb = 60 / bar.bpm;
    const len = barSeconds(bar);
    const mine: ScoreNote[] = [];
    while (li < sorted.length && sorted[li]!.t < t + len - 1e-9) mine.push(sorted[li++]!);
    const leadCh = bar.notes.find((n) => n.role === "lead")?.ch ?? 0;
    bar.notes = [
      ...bar.notes.filter((n) => n.role !== "lead"),
      ...mine.map((n) => ({ beat: (n.t - t) / spb, dur: n.dur / spb, ch: leadCh, key: n.key, vel: n.vel, role: "lead" as const })),
    ];
    bar.controls = bar.controls.map((c) => (c.kind === "program" && c.ch === leadCh ? { ...c, value: program } : c));
    t += len;
  }
}
