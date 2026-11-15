/**
 * Moves inside a track: changes to the sound that are not notes. They are
 * planned once per track, from the arrangement grid and the style's `moves`
 * rates, on a stream of their own; each bar then gets its slice of them.
 *
 *   - Sweeps: a part entering a section opens up over 8 or 16 bars (a
 *     high-cut rising, or a low-cut falling), and ends open.
 *   - Drift: a patched part's filter cutoff wanders away and back across a
 *     section (the acid line), and ends where the patch has it.
 *   - Builds: across the grid's build, a high-pass rises on everything and a
 *     riser climbs; the drop lands with an impact.
 *   - Stutter: the last beat of a phrase repeats a short slice to the barline.
 *   - Throws: an echo throw on the last beat before a break.
 *
 * A move over several bars is cut into one per bar, each with its own start
 * and end, so a bar is the same however it is reached.
 */
import type { Moves, Role } from "../corpus/schema.js";
import type { Rng } from "../theory/rng.js";
import { type Grid, type GridSection, PHRASE_BARS, SLOT_BARS } from "./grid.js";
import { type Move, type MoveTarget, OPEN_HIGH, OPEN_LOW } from "./types.js";

export interface MovePart {
  id: string;
  role: Role;
  /** The low end and the roll: no sweeps, no drift. */
  fixed?: boolean;
  /** The resting cutoff of the part's patch, Hz, if it has a low-pass to drift. */
  cutoff?: number;
  /** Its patch slides or accents: the acid line, which drifts first. */
  lively?: boolean;
}

/** One move over `bars` bars from `start`; `value(x)` is its target at `x` (0..1) of the way through. */
interface Planned {
  scope: Move["scope"];
  target: MoveTarget;
  param?: string;
  start: number;
  bars: number;
  value: (x: number) => number;
  /** A move inside one bar, as written (stutter, impact, throw). */
  once?: Move;
}

/** Where a build's high-pass ends: higher for a longer build. */
const BUILD_CUT = { 4: 600, 8: 1000 } as Record<number, number>;
const RISER = { from: 200, to: 6000 };
const IMPACT = { from: 90, to: 38 };
/** A sweep's closed end. */
const SWEEP = { highCut: 300, lowCut: 1500 };

/** Between two values in Hz, in octaves; `x` 0..1. */
const octaves = (a: number, b: number, x: number) => a * Math.pow(b / a, x);
const ease = (x: number) => x * x * (3 - 2 * x);

export class MovePlan {
  private readonly planned: Planned[] = [];

  constructor(
    private readonly grid: Grid,
    sections: readonly GridSection[],
    parts: readonly MovePart[],
    rates: Moves,
    rng: Rng,
    private readonly beatsPerBar: number,
    mix: number,
  ) {
    const total = grid.parts.length;
    const outside = (b: number) => b >= mix && !(mix > 0 && b >= total - mix) && b < total;
    const building = (b: number) => grid.build?.[b] !== undefined;
    const plays = (id: string, b: number) => grid.parts[b]?.includes(id) === true;
    const through = (id: string, from: number, n: number) => {
      for (let b = from; b < from + n; b++) if (!plays(id, b) || building(b) || !outside(b)) return false;
      return true;
    };
    const free = parts.filter((p) => !p.fixed);

    sections.forEach((s, si) => {
      const r = rng.fork(`section:${si}`);
      // Every draw is made whether or not it is used, so one choice never moves another.
      const sweep = r.chance(rates.sweep);
      const long = r.chance(0.5);
      const sweepPick = r.next();
      const low = r.chance(0.5);
      const drift = r.chance(rates.drift);
      const driftPick = r.next();
      const depth = r.float(0.6, 1.3) * (r.chance(0.7) ? 1 : -1);

      let swept: string | undefined;
      if (sweep) {
        // A part that comes in here and stays for the whole sweep, from silence, so the filter starts with nothing to cut.
        const options: { p: MovePart; b: number; n: number }[] = [];
        for (let b = s.startBar; b < s.startBar + s.bars; b += SLOT_BARS) {
          for (const p of free) {
            if (!plays(p.id, b) || plays(p.id, b - 1)) continue;
            const n = [long ? 16 : 8, 8].find((k) => through(p.id, b, k));
            if (n !== undefined) options.push({ p, b, n });
          }
        }
        const o = options[Math.floor(sweepPick * options.length)];
        if (o) {
          swept = o.p.id;
          const target = (o.p.role === "pad" || o.p.role === "comp") && low ? "lowCut" : "highCut";
          const open = target === "lowCut" ? OPEN_LOW : OPEN_HIGH;
          this.planned.push({ scope: { part: o.p.id }, target, start: o.b, bars: o.n, value: (x) => octaves(SWEEP[target], open, ease(x)) });
        }
      }

      if (drift) {
        // A patched part that plays most of the section; the acid line first.
        const bars = Array.from({ length: s.bars }, (_, i) => s.startBar + i).filter((b) => outside(b) && !building(b));
        const options = free.filter((p) => p.id !== swept && p.cutoff !== undefined && bars.filter((b) => plays(p.id, b)).length * 2 >= s.bars);
        const weights = options.map((p) => (p.lively ? 4 : 1));
        let pick = driftPick * weights.reduce((a, w) => a + w, 0);
        const p = options.find((_, i) => (pick -= weights[i]!) < 0);
        if (p) {
          const base = p.cutoff!;
          this.planned.push({ scope: { part: p.id }, target: "patch", param: "cutoff", start: s.startBar, bars: s.bars, value: (x) => (x <= 0 || x >= 1 ? base : base * Math.pow(2, depth * Math.sin(Math.PI * x))) });
        }
      }
    });

    // Builds: the grid has placed them. A high-pass on everything and a riser across it, an impact on the drop.
    grid.build?.forEach((at, b) => {
      if (!at || at.bar !== 0) return;
      const n = at.bars;
      const cut = BUILD_CUT[n] ?? BUILD_CUT[4]!;
      this.planned.push({ scope: "master", target: "lowCut", start: b, bars: n, value: (x) => octaves(OPEN_LOW, cut, Math.pow(x, 1.5)) });
      this.planned.push({ scope: { role: "pad" }, target: "riser", start: b, bars: n, value: (x) => octaves(RISER.from, RISER.to, x) });
      this.planned.push({ scope: { role: "drums" }, target: "impact", start: b + n, bars: 1, value: () => 0, once: { scope: { role: "drums" }, target: "impact", from: IMPACT.from, to: IMPACT.to, beats: 0.5 } });
    });

    // Stutters at phrase ends, and throws before breaks: a stream per bar.
    for (let b = PHRASE_BARS - 1; b < total; b++) {
      const end = b % PHRASE_BARS === PHRASE_BARS - 1;
      const brk = grid.turn[b + 1] === "break";
      if (!(end || brk) || !outside(b) || building(b) || building(b + 1)) continue;
      const r = rng.fork(`bar:${b}`);
      if (end && rates.stutter > 0 && r.chance(rates.stutter)) {
        const region = r.chance(0.6) ? 1 : 0.5;
        const slice = region / r.pick([2, 4]);
        const stutter: Move = { scope: "master", target: "stutter", from: slice, to: r.chance(0.25) ? -12 : 0, at: beatsPerBar - region, beats: region };
        if (r.chance(0.3)) stutter.param = "gate";
        this.planned.push({ scope: "master", target: "stutter", start: b, bars: 1, value: () => 0, once: stutter });
      }
      if (brk && rates.throw > 0 && r.chance(rates.throw)) {
        const role = (["comp", "arp"] as const).find((x) => parts.some((p) => p.role === x && plays(p.id, b)));
        if (role) this.planned.push({ scope: { role }, target: "delaySend", start: b, bars: 1, value: () => 0, once: { scope: { role }, target: "delaySend", from: 0.7, to: 0.7, at: beatsPerBar - 1, beats: 1 } });
      }
    }
  }

  /** The moves of bar `b`: each one's slice of the bar, from its own start to its own end. */
  at(b: number): Move[] {
    const out: Move[] = [];
    for (const m of this.planned) {
      if (b < m.start || b >= m.start + m.bars) continue;
      if (m.once) {
        out.push({ ...m.once });
        continue;
      }
      // A part's move only while it plays (a drift spans bars where the part is out).
      if (typeof m.scope === "object" && m.scope.part !== undefined && !this.grid.parts[b]?.includes(m.scope.part)) continue;
      const k = b - m.start;
      const move: Move = { scope: m.scope, target: m.target, from: m.value(k / m.bars), to: m.value((k + 1) / m.bars), beats: this.beatsPerBar, span: { bar: k, of: m.bars } };
      if (m.param !== undefined) move.param = m.param;
      out.push(move);
    }
    return out;
  }
}

/** Targets measured in Hz, which move in octaves. */
export const IN_HZ: ReadonlySet<MoveTarget> = new Set(["lowCut", "highCut", "riser", "impact"]);

/** A move's target at `beat` of its bar. */
export function moveValue(m: Move, beat: number): number {
  const at = m.at ?? 0;
  let x = m.beats > 0 ? (beat - at) / m.beats : 1;
  x = x <= 0 ? 0 : x >= 1 ? 1 : x;
  if (m.curve === "ease") x = ease(x);
  if (x === 0) return m.from;
  if (x === 1) return m.to;
  const hz = IN_HZ.has(m.target) || (m.target === "patch" && m.param === "cutoff");
  return hz && m.from > 0 && m.to > 0 ? octaves(m.from, m.to, x) : m.from + (m.to - m.from) * x;
}

/** Whether a move's scope covers a part or role. "master" covers everything. */
export function covers(m: Move, what: { part?: string | undefined; role: Role }): boolean {
  if (m.scope === "master") return true;
  if (m.scope.part !== undefined) return m.scope.part === what.part;
  return m.scope.role === what.role;
}
