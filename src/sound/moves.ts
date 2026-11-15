/**
 * Moves on the stems, in the render worker: gain, filters, the lows and
 * stutter on a part's or a role's audio for the bar, sample by sample; risers
 * and impacts synthesised into a role's stem. (Send throws are the bus's.)
 *
 * Nothing here outlives the bar's moves. A filter keeps its state only while
 * the next bar has a move on the same target; a bar without one is the sound
 * as it is. A cut at its open end is the dry signal exactly, so a sweep that
 * ends open hands over to no filter without a step.
 */
import { covers, moveValue } from "../engine/moves.js";
import { type Bar, type Move, OPEN_HIGH, OPEN_LOW } from "../engine/types.js";
import type { Role } from "../corpus/constants.js";
import { Noise, OnePole, type Stereo, Svf } from "./dsp.js";

/** Moves as the worker takes them: the bar's length in beats, and every move but the sends. */
export interface StemMoves {
  beats: number;
  list: Move[];
}

/** The part of a bar's moves the worker runs. Undefined for a bar without (every bar of a style without `moves`). */
export function stemMoves(bar: Pick<Bar, "beats" | "moves">): StemMoves | undefined {
  const list = bar.moves?.filter((m) => m.target !== "reverbSend" && m.target !== "delaySend");
  return list?.length ? { beats: bar.beats, list } : undefined;
}

/** Samples between filter coefficient updates. */
const BLOCK = 16;
/** A filter that starts with no state fades in over this long, and a stutter's repeats meet over this long, seconds. */
const FADE = 0.004;
const STUTTER_FADE = 0.001;
/** Below about this the "lows" target cuts or lifts. */
const LOWS_HZ = 150;
/** A high-cut opens fully over its top octave, a low-cut over its bottom one: there it fades to the dry sound. */
const HIGH_FULL = OPEN_HIGH / 2;
const LOW_FULL = OPEN_LOW * 2;

/** Riser: peak level (about the RMS of a stem at full level) and its band's resonance. */
export const RISER = { level: 0.06, q: 2.5, low: 150, high: 8000 };
/** Impact: a thump falling from `from` to `to` Hz and a noise tail; seconds. */
export const IMPACT = { level: 0.2, decay: 0.2, thump: 0.9, tail: 2.6, noise: 0.08 };

/** A cut: two state-variable stages per channel, 24 dB an octave (Butterworth). */
interface Filter {
  l: [Svf, Svf];
  r: [Svf, Svf];
  fresh: boolean;
}
const STAGES_Q = [0.541, 1.307] as const;
/** A low shelf (RBJ), one per channel. */
class Shelf {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  constructor(private readonly sr: number) {}
  set(db: number): void {
    const a = Math.pow(10, db / 40);
    const w = (2 * Math.PI * LOWS_HZ) / this.sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / Math.SQRT2;
    const r = 2 * Math.sqrt(a) * alpha;
    const a0 = a + 1 + (a - 1) * cos + r;
    this.b0 = (a * (a + 1 - (a - 1) * cos + r)) / a0;
    this.b1 = (2 * a * (a - 1 - (a + 1) * cos)) / a0;
    this.b2 = (a * (a + 1 - (a - 1) * cos - r)) / a0;
    this.a1 = (-2 * (a - 1 + (a + 1) * cos)) / a0;
    this.a2 = (a + 1 + (a - 1) * cos - r) / a0;
  }
  tick(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}
interface Lows {
  l: Shelf;
  r: Shelf;
}
interface Riser {
  l: Svf;
  r: Svf;
  nl: Noise;
  nr: Noise;
  phase: number;
}

export class MoveRunner {
  private readonly filters = new Map<string, Filter>();
  private readonly lows = new Map<string, Lows>();
  private readonly risers = new Map<string, Riser>();
  private readonly used = new Set<string>();

  constructor(private readonly sr: number) {}

  /** Whether anything is kept from the last bar's moves. */
  get holding(): boolean {
    return this.filters.size + this.lows.size + this.risers.size > 0;
  }

  /** Forget everything: a bar without moves, a seek, an engine switch. */
  clear(): void {
    this.filters.clear();
    this.lows.clear();
    this.risers.clear();
    this.used.clear();
  }

  /** Call once per bar with moves, before `apply`; `end` after. */
  begin(): void {
    this.used.clear();
  }

  /** Drop the state of every target this bar did not move: the next move on it starts afresh. */
  end(): void {
    for (const map of [this.filters, this.lows, this.risers] as Map<string, unknown>[]) for (const k of map.keys()) if (!this.used.has(k)) map.delete(k);
  }

  /**
   * Run the stem moves in `list` on `s` in place: stutter, then the lows, the
   * cuts and the gain. `key` names the stem and scope (its state is kept under it);
   * `fpb` is frames per beat.
   */
  apply(s: Stereo, key: string, list: readonly Move[], fpb: number): void {
    for (const m of list) if (m.target === "stutter") stutter(s, m, fpb, this.sr);
    for (const m of list) if (m.target === "lows") this.shelf(s, `${key}:lows`, m, fpb);
    for (const m of list) if (m.target === "lowCut" || m.target === "highCut") this.cut(s, `${key}:${m.target}`, m, fpb);
    for (const m of list) if (m.target === "gain") gain(s, m, fpb);
  }

  private cut(s: Stereo, key: string, m: Move, fpb: number): void {
    this.used.add(key);
    let f = this.filters.get(key);
    if (!f || m.span === undefined || m.span.bar === 0) this.filters.set(key, (f = { l: [new Svf(this.sr), new Svf(this.sr)], r: [new Svf(this.sr), new Svf(this.sr)], fresh: true }));
    const high = m.target === "highCut";
    const [l1, l2] = f.l;
    const [r1, r2] = f.r;
    const n = s.l.length;
    const fade = Math.max(1, Math.round(FADE * this.sr));
    let wet = 0;
    for (let i = 0; i < n; i++) {
      if (i % BLOCK === 0) {
        // The value at the end of the block, so the last block of a move is at its end value.
        const hz = moveValue(m, Math.min(n, i + BLOCK) / fpb);
        wet = high ? (hz >= OPEN_HIGH ? 0 : hz <= HIGH_FULL ? 1 : Math.log2(OPEN_HIGH / hz)) : hz <= OPEN_LOW ? 0 : hz >= LOW_FULL ? 1 : Math.log2(hz / OPEN_LOW);
        const at = Math.min(Math.max(hz, OPEN_LOW), this.sr * 0.45);
        for (const [k, q] of STAGES_Q.entries()) {
          f.l[k]!.set(at, q);
          f.r[k]!.set(at, q);
        }
      }
      const xl = s.l[i]!;
      const xr = s.r[i]!;
      l1.tick(xl);
      r1.tick(xr);
      l2.tick(high ? l1.lp : l1.hp);
      r2.tick(high ? r1.lp : r1.hp);
      if (wet === 0) continue;
      const w = f.fresh && i < fade ? (wet * i) / fade : wet;
      const yl = high ? l2.lp : l2.hp;
      const yr = high ? r2.lp : r2.hp;
      s.l[i] = xl + w * (yl - xl);
      s.r[i] = xr + w * (yr - xr);
    }
    f.fresh = false;
  }

  private shelf(s: Stereo, key: string, m: Move, fpb: number): void {
    this.used.add(key);
    let f = this.lows.get(key);
    if (!f || m.span === undefined || m.span.bar === 0) this.lows.set(key, (f = { l: new Shelf(this.sr), r: new Shelf(this.sr) }));
    const n = s.l.length;
    let flat = true;
    for (let i = 0; i < n; i++) {
      if (i % BLOCK === 0) {
        const db = moveValue(m, Math.min(n, i + BLOCK) / fpb);
        // At 0 dB the shelf is the sound as it is: kept running, not heard.
        flat = db === 0;
        f.l.set(db);
        f.r.set(db);
      }
      const yl = f.l.tick(s.l[i]!);
      const yr = f.r.tick(s.r[i]!);
      if (flat) continue;
      s.l[i] = yl;
      s.r[i] = yr;
    }
  }

  /**
   * A riser's stretch of this bar into `out` (a window whose index 0 is frame
   * `out.base`), from frame `start` of the bar at `barFrame`: noise in a band
   * that climbs, and a tone an octave under it, both louder as they rise.
   * The last bar of it fades to silence at its end.
   */
  riser(out: Stereo, key: string, m: Move, barFrame: number, fpb: number): number {
    const k = `riser:${key}`;
    this.used.add(k);
    let r = this.risers.get(k);
    const first = m.span === undefined || m.span.bar === 0;
    if (!r || first) this.risers.set(k, (r = { l: new Svf(this.sr), r: new Svf(this.sr), nl: new Noise(0x5eed1), nr: new Noise(0x5eed2), phase: 0 }));
    const from = Math.round((m.at ?? 0) * fpb);
    const to = Math.round(((m.at ?? 0) + m.beats) * fpb);
    const last = m.span === undefined || m.span.bar === m.span.of - 1;
    const fade = Math.round(0.01 * this.sr);
    const norm = 1 / RISER.q;
    const span = Math.log(RISER.high / RISER.low);
    const offset = barFrame - (out.base ?? 0);
    let amp = 0;
    let hz = 0;
    for (let i = from; i < to; i++) {
      if ((i - from) % BLOCK === 0) {
        hz = moveValue(m, i / fpb);
        r.l.set(hz, RISER.q);
        r.r.set(hz, RISER.q);
        const p = Math.min(1, Math.max(0, Math.log(hz / RISER.low) / span));
        amp = RISER.level * (0.04 + 0.96 * p * p);
      }
      let env = amp;
      if (first && i - from < fade) env *= (i - from) / fade;
      if (last && to - i <= fade) env *= (to - i - 1) / fade;
      r.phase += (0.5 * hz) / this.sr;
      if (r.phase >= 1) r.phase -= 1;
      const tone = 0.35 * Math.sin(2 * Math.PI * r.phase);
      r.l.tick(r.nl.next());
      r.r.tick(r.nr.next());
      const j = offset + i;
      if (j < 0 || j >= out.l.length) continue;
      out.l[j]! += env * (2.2 * r.l.bp * norm + tone);
      out.r[j]! += env * (2.2 * r.r.bp * norm + tone);
    }
    return barFrame + to;
  }
}

/**
 * An impact at beat `m.at` of the bar at `barFrame`, into `out`: a sine thump
 * falling from `m.from` to `m.to` Hz and a darkening noise tail, ending in
 * silence after `IMPACT.tail` seconds. Returns the frame after its last sample.
 */
export function impact(out: Stereo, m: Move, barFrame: number, fpb: number, sr: number): number {
  const start = barFrame + Math.round((m.at ?? 0) * fpb) - (out.base ?? 0);
  const fall = Math.max(0.02, (m.beats * fpb) / sr / 4);
  const thump = Math.round(IMPACT.thump * sr);
  const tail = Math.round(IMPACT.tail * sr);
  const end = Math.max(thump, tail);
  const noise = new Noise(0x1a9ac7);
  const lp = new OnePole(sr, 3000);
  const fadeOut = Math.round(0.1 * sr);
  let phase = 0;
  for (let i = 0; i < end; i++) {
    const t = i / sr;
    const hz = m.to + (m.from - m.to) * Math.exp(-t / fall);
    phase += hz / sr;
    if (phase >= 1) phase -= 1;
    let body = i < thump ? Math.sin(2 * Math.PI * phase) * (1 - Math.exp(-t / 0.002)) * Math.exp(-t / IMPACT.decay) : 0;
    if (i < thump && thump - i <= fadeOut) body *= (thump - i - 1) / fadeOut;
    if (i % BLOCK === 0) lp.set(300 + 2700 * Math.exp(-t / 0.4));
    let hiss = lp.tick(noise.next()) * Math.min(1, t / 0.02) * Math.exp(-t / 0.9);
    if (tail - i <= fadeOut) hiss *= Math.max(0, tail - i - 1) / fadeOut;
    const v = IMPACT.level * body + IMPACT.noise * hiss;
    const j = start + i;
    if (j < 0 || j >= out.l.length) continue;
    out.l[j]! += v;
    out.r[j]! += v;
  }
  return barFrame + Math.round((m.at ?? 0) * fpb) + end;
}

function gain(s: Stereo, m: Move, fpb: number): void {
  for (let i = 0; i < s.l.length; i++) {
    const g = moveValue(m, i / fpb);
    s.l[i]! *= g;
    s.r[i]! *= g;
  }
}

/**
 * The slice of `m.from` beats at `m.at` repeated to `m.at + m.beats`, each
 * repeat meeting the next over a millisecond. `m.to` semitones pitch the last
 * repeat (the ones between step there evenly); "gate" plays the first half of each.
 */
export function stutter(s: Stereo, m: Move, fpb: number, sr: number): void {
  const n = s.l.length;
  const at = Math.round((m.at ?? 0) * fpb);
  const end = Math.min(n, Math.round(((m.at ?? 0) + m.beats) * fpb));
  const len = Math.max(32, Math.round(m.from * fpb));
  if (at + len > n || end <= at) return;
  const src = { l: s.l.slice(at, at + len), r: s.r.slice(at, at + len) };
  const reps = Math.ceil((end - at) / len);
  const fade = Math.max(1, Math.round(STUTTER_FADE * sr));
  const gated = m.param === "gate" ? Math.round(len / 2) : len;
  for (let k = 0; k < reps; k++) {
    const rate = Math.pow(2, (reps > 1 ? (m.to * k) / (reps - 1) : m.to) / 12);
    const from = at + k * len;
    const sound = Math.min(gated, end - from);
    for (let i = 0; i < len && from + i < end; i++) {
      let l = 0;
      let r = 0;
      const x = i * rate;
      if (i < sound && x < len - 1) {
        const j = Math.floor(x);
        const f = x - j;
        l = rate === 1 ? src.l[i]! : src.l[j]! + f * (src.l[j + 1]! - src.l[j]!);
        r = rate === 1 ? src.r[i]! : src.r[j]! + f * (src.r[j + 1]! - src.r[j]!);
        // Each repeat meets the next (and the barline) through a short fade; the first starts where the bar was.
        let g = 1;
        if (k > 0 && i < fade) g = i / fade;
        if (sound - i <= fade) g = Math.min(g, (sound - i - 1) / fade);
        l *= g;
        r *= g;
      }
      s.l[from + i] = l;
      s.r[from + i] = r;
    }
  }
}

/** The moves of `list` that run on a stem: a part's own (`part` set), or a role's and everything's. */
export function movesOn(list: readonly Move[], what: { part?: string; role: Role }): Move[] {
  return list.filter((m) => m.target !== "patch" && m.target !== "riser" && m.target !== "impact" && (what.part !== undefined ? m.scope !== "master" && m.scope.part === what.part : m.scope === "master" || m.scope.part === undefined) && covers(m, what));
}
