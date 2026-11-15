/**
 * The arrangement grid: for a track with parts, which of them play in each
 * bar. Sections set the broad shape (which roles, how intense); the grid
 * brings the parts in and out inside it, a few bars apart.
 *
 *   - Changes fall every 4 bars. Outside a turn, a slot changes one part, or
 *     swaps one for another, and a phrase of 8 bars changes at most two.
 *   - A part may enter only where the section has its role and is at least as
 *     intense as the part's `enters`. A set's `lift` is already in the
 *     section's intensity, so a cooler track is a sparser one.
 *   - The kick and the bass are the low end. They play wherever the section
 *     has both roles and leave only for a breakdown: a section without one.
 *   - A turn is the first bar of a section where the low end leaves or comes
 *     back, or which is a quarter hotter or cooler than the one before. There
 *     any number of parts may change: at a "drop" everything that may play
 *     comes in (or the share of it the style asks for), at a "break"
 *     everything that may not goes.
 *   - The last bar of a phrase may rest one hat or percussion part.
 *   - A build (a style with `moves`): the last 4 or 8 bars before a drop. The
 *     kick leaves, the roll part comes in, and nothing else moves until the
 *     drop brings the kick back and sends the roll out.
 *   - A set's track mixes in and out: it starts on the kick alone, adds a
 *     part every 4 bars with the bass half way, and ends the same way round.
 *
 * It is planned once, up front, from its own random stream, so it is the same
 * however a bar is reached.
 */
import type { Role } from "../corpus/constants.js";
import type { Rng } from "../theory/rng.js";

/** Bars in a phrase; a set's tracks are whole phrases. */
export const PHRASE_BARS = 8;
/** Bars between changes. */
export const SLOT_BARS = 4;
/** Bars at each end of a set's track that mix it in and out. */
export const MIX_BARS = 16;
/** A section this much hotter or cooler than the last starts with a turn. */
export const TURN_STEP = 0.25;
/** A part stays in, or out, at least this long before the grid moves it again by choice. */
const HOLD_BARS = 8;

export const DEFAULT_RATES: GridRates = { change: 0.5, swap: 0.2, thin: 0.3 };

/**
 * Bars at each end of a track of `totalBars` that mix it in and out:
 * `MIX_BARS`, or a phrase less at a time for a track too short to play at
 * least one phrase whole between them; none for a track of under three phrases.
 */
export function mixBars(totalBars: number): number {
  for (let m = MIX_BARS; m > 0; m -= PHRASE_BARS) if (2 * m + PHRASE_BARS <= totalBars) return m;
  return 0;
}

export interface GridPart {
  id: string;
  role: Role;
  enters: number;
  /** The low end: "kick" for the part with the kick lane, "bass" for the first bass part. */
  anchor?: "kick" | "bass";
  /** May rest for the last bar of a phrase (hats and percussion). */
  rests?: boolean;
  /** Plays the roll in a build, and nowhere else. */
  roll?: boolean;
  /** Parts that crowd each other; `GridRates.groups` says how many of a group play at once. */
  group?: string;
}

/** Builds before drops, for a style that asks for them. `rng` is a stream of their own. */
export interface GridBuilds {
  /** Chance that a drop has a build. */
  chance: number;
  /** Share of builds that are 8 bars rather than 4. */
  long: number;
  rng: Rng;
}

export interface GridSection {
  startBar: number;
  bars: number;
  intensity: number;
  roles: readonly Role[];
}

export interface GridRates {
  change: number;
  swap: number;
  thin: number;
  /** Share of the parts that may play that a drop brings in at once (default 1: everything). */
  drop?: number | undefined;
  /** The most parts in at once, the low end included. */
  most?: number | undefined;
  /** The most parts of each group in at once. */
  groups?: Record<string, number> | undefined;
}

export type Turn = "drop" | "break";

/** One entry per bar of the track. */
export interface Grid {
  /** Ids of the parts that are in, in the order the style declares them. */
  parts: string[][];
  /** Of those, the ones resting for this bar only. */
  thin: (string[] | undefined)[];
  turn: (Turn | undefined)[];
  /** In a build: this bar of how many. Only planned with `GridBuilds`. */
  build?: ({ bar: number; bars: number } | undefined)[];
}

/** `mix` is the bars of mix-in and mix-out (0 for a piece that is not a set's track). */
export function planGrid(parts: readonly GridPart[], sections: readonly GridSection[], rates: GridRates, rng: Rng, mix = 0, builds?: GridBuilds): Grid {
  const total = sections.reduce((a, s) => Math.max(a, s.startBar + s.bars), 0);
  const grid: Grid = { parts: [], thin: [], turn: [] };
  const kick = parts.find((p) => p.anchor === "kick");
  const bass = parts.find((p) => p.anchor === "bass");
  const roll = parts.find((p) => p.roll);
  const breakdown = (s: GridSection) => (bass !== undefined && !s.roles.includes("bass")) || (kick !== undefined && !s.roles.includes("drums"));
  const builtAt = builds ? planBuilds(sections, breakdown, builds, total, mix) : undefined;
  if (builtAt) grid.build = [];
  const eligible = (p: GridPart, s: GridSection) => {
    if (p === roll) return false;
    if (p === kick) return !breakdown(s);
    if (p === bass) return s.roles.includes("bass");
    return s.roles.includes(p.role) && s.intensity >= p.enters - 1e-9;
  };
  const byEnters = (a: GridPart, b: GridPart) => a.enters - b.enters;
  const limited = rates.most !== undefined || rates.groups !== undefined;
  /** Whether `p` may join `among` under the style's limits. */
  const room = (p: GridPart, among: readonly GridPart[]) => {
    if (!limited) return true;
    if (rates.most !== undefined && among.length >= rates.most) return false;
    const limit = p.group === undefined ? undefined : rates.groups?.[p.group];
    return limit === undefined || among.filter((x) => x.group === p.group).length < limit;
  };

  let on: GridPart[] = [];
  /** The bar each part last entered or left. */
  const moved = new Map<string, number>();
  const settled = (p: GridPart, bar: number) => bar - (moved.get(p.id) ?? -HOLD_BARS) >= HOLD_BARS;
  let phrase = -1;
  let used = 0;
  const enter = (p: GridPart, bar: number, free = false) => {
    on.push(p);
    moved.set(p.id, bar);
    if (!free) used++;
  };
  const leave = (p: GridPart, bar: number, free = false) => {
    on = on.filter((x) => x !== p);
    moved.set(p.id, bar);
    if (!free) used++;
  };

  sections.forEach((s, si) => {
    const before = sections[si - 1];
    const next = sections[si + 1];
    for (let at = 0; at < s.bars; at += SLOT_BARS) {
      const bar = s.startBar + at;
      if (Math.floor(bar / PHRASE_BARS) !== phrase) {
        phrase = Math.floor(bar / PHRASE_BARS);
        used = 0;
      }
      const may = parts.filter((p) => eligible(p, s));
      const others = (list: GridPart[]) => list.filter((p) => p !== kick && p !== bass);
      // Slots left in the track, this one included: the mix-out lets one part more play per slot from the end.
      const left = Math.ceil((total - bar) / SLOT_BARS);
      const cap = mix ? left + 1 : Infinity;
      const mixIn = bar < mix;
      const mixOut = mix > 0 && bar >= total - mix;
      const bassOut = mix > 0 && bar >= total - mix / 2;
      const build = builtAt?.get(bar);
      let turn: Turn | undefined;

      if (bar === 0) {
        // A set's track starts on the kick alone; a piece starts on its low end.
        const first = mix ? [kick] : [kick, bass];
        on = first.filter((p): p is GridPart => p !== undefined && eligible(p, s));
        if (!on.length) on = may.length ? [may.slice().sort(byEnters)[0]!] : [];
        for (const p of on) moved.set(p.id, -HOLD_BARS);
      } else if (mixIn) {
        // Mix-in: one part more every slot, the bass half way.
        const wanted = bar >= mix / 2 && bass && eligible(bass, s) && !on.includes(bass) ? bass : others(may).filter((p) => !on.includes(p) && room(p, on)).sort(byEnters)[0];
        if (kick && eligible(kick, s) && !on.includes(kick)) enter(kick, bar, true);
        if (wanted) enter(wanted, bar);
      } else {
        const lowBefore = before !== undefined && !breakdown(before);
        const low = !breakdown(s);
        const step = before ? s.intensity - before.intensity : 0;
        if (at === 0 && before && (low !== lowBefore || Math.abs(step) >= TURN_STEP - 1e-9)) turn = low && (!lowBefore || step > 0) ? "drop" : "break";

        if (turn === "drop") {
          // Everything that may play comes in, the coolest parts first if the end of the track is near.
          // (In a mix-out only the low end comes back.)
          const low = may.filter((p) => p === kick || (p === bass && !bassOut));
          let fresh = others(may).filter((p) => !mixOut || on.includes(p));
          const share = rates.drop ?? 1;
          if (share < 1) {
            // Not quite everything: what was playing stays, and a draw of the rest joins it.
            const staying = fresh.filter((p) => on.includes(p));
            const coming = rng.shuffle(fresh.filter((p) => !on.includes(p)));
            fresh = [...staying, ...coming].slice(0, Math.max(staying.length, Math.ceil(fresh.length * share)));
          }
          if (limited) {
            // What was playing has first claim on the room, then the coolest parts.
            const kept: GridPart[] = [...low];
            for (const p of [...fresh.filter((x) => on.includes(x)), ...fresh.filter((x) => !on.includes(x)).sort(byEnters)]) if (room(p, kept)) kept.push(p);
            fresh = kept.filter((p) => !low.includes(p));
          }
          const keep = new Set([...low, ...fresh.sort(byEnters).slice(0, Math.max(0, cap - low.length))]);
          for (const p of on.slice()) if (!keep.has(p)) leave(p, bar, true);
          for (const p of parts) if (keep.has(p) && !on.includes(p)) enter(p, bar, true);
        } else if (turn === "break") {
          for (const p of on.slice()) if (!may.includes(p)) leave(p, bar, true);
          for (const p of [kick, bass]) if (p && may.includes(p) && !on.includes(p) && !(p === bass && bassOut)) enter(p, bar, true);
        } else if (at === 0) {
          // An ordinary boundary: the low end is where it was.
          for (const p of [kick, bass]) if (p && may.includes(p) && !on.includes(p) && !mixOut) enter(p, bar, true);
        }
        if (bass && bassOut && on.includes(bass)) leave(bass, bar, turn !== undefined);
        if (build?.bar === 0) {
          // A build starts: the kick goes and the roll comes in, whatever else this phrase has done.
          if (kick && on.includes(kick)) leave(kick, bar, true);
          if (roll && !on.includes(roll)) enter(roll, bar, true);
        }

        if (!turn && !build) {
          // What has to go: a part the section no longer allows, or one too many for the end of the track.
          const stale = others(on).filter((p) => !may.includes(p)).sort((a, b) => b.enters - a.enters);
          while (used < 2 && stale.length) leave(stale.shift()!, bar);
          while (used < 2 && on.length > cap && others(on).length) leave(others(on).sort((a, b) => b.enters - a.enters)[0]!, bar);
          // What will have to go at the next boundary leaves ahead of it, one a slot, unless that boundary is a turn.
          const slotsLeft = Math.ceil((s.bars - at) / SLOT_BARS);
          const nextTurn = next !== undefined && (breakdown(next) !== breakdown(s) || Math.abs(next.intensity - s.intensity) >= TURN_STEP - 1e-9);
          const doomed = next && !nextTurn ? others(on).filter((p) => !eligible(p, next)).sort((a, b) => b.enters - a.enters) : [];
          if (used < 2 && doomed.length >= slotsLeft && doomed.length) leave(doomed[0]!, bar);
          else if (used < 2 && !mixOut && rng.chance(rates.change)) {
            // A change by choice: something enters, something leaves, or one is swapped for another.
            const staying = (p: GridPart) => !next || nextTurn || slotsLeft > 2 || eligible(p, next);
            const add = others(may).filter((p) => !on.includes(p) && settled(p, bar) && staying(p) && room(p, on));
            const drop = others(on).filter((p) => settled(p, bar));
            const canAdd = add.length > 0 && on.length < cap;
            const canDrop = drop.length > 0 && on.length > 2;
            const pickAdd = () => rng.weighted(add, (p) => 1 / (0.2 + p.enters));
            if (canAdd && canDrop && used === 0 && rng.chance(rates.swap)) {
              leave(rng.pick(drop), bar);
              enter(pickAdd(), bar);
            } else if (canAdd && (!canDrop || rng.chance((2 * add.length) / (2 * add.length + Math.max(0, drop.length - 1))))) enter(pickAdd(), bar);
            else if (canDrop) leave(rng.pick(drop), bar);
          }
        }
        // A section is never silent: if nothing may play, its coolest part does.
        if (!on.length) {
          const fallback = (may.length ? may : parts.filter((p) => s.roles.includes(p.role) && p !== kick && p !== roll)).slice().sort(byEnters)[0];
          if (fallback) enter(fallback, bar, true);
        }
      }

      const ids = parts.filter((p) => on.includes(p)).map((p) => p.id);
      for (let b = bar; b < Math.min(bar + SLOT_BARS, s.startBar + s.bars); b++) {
        grid.parts[b] = ids;
        grid.thin[b] = undefined;
        grid.turn[b] = b === bar ? turn : undefined;
        if (grid.build) grid.build[b] = build && { bar: build.bar + b - bar, bars: build.bars };
        if (b % PHRASE_BARS === PHRASE_BARS - 1 && rng.chance(rates.thin)) {
          const resting = on.filter((p) => p.rests);
          if (resting.length) grid.thin[b] = [rng.pick(resting).id];
        }
      }
    }
  });
  return grid;
}

/**
 * Where the builds fall: the bars before each drop that draws one, keyed by
 * their first bar of each slot. A build stays inside the section before its
 * drop and out of the mix-in and mix-out.
 */
function planBuilds(sections: readonly GridSection[], breakdown: (s: GridSection) => boolean, builds: GridBuilds, total: number, mix: number): Map<number, { bar: number; bars: number }> {
  const out = new Map<number, { bar: number; bars: number }>();
  sections.forEach((s, si) => {
    const before = sections[si - 1];
    if (!before || s.startBar < mix || (mix > 0 && s.startBar >= total - mix)) return;
    const low = !breakdown(s);
    const lowBefore = !breakdown(before);
    const step = s.intensity - before.intensity;
    const drop = (low !== lowBefore || Math.abs(step) >= TURN_STEP - 1e-9) && low && (!lowBefore || step > 0);
    if (!drop) return;
    // Both draws happen for every drop, so one build's choice never moves another's.
    const wanted = builds.rng.chance(builds.chance);
    const long = builds.rng.chance(builds.long);
    if (!wanted) return;
    const bars = [long ? 2 * SLOT_BARS : SLOT_BARS, SLOT_BARS].find((n) => n <= before.bars && s.startBar - n >= mix);
    if (bars === undefined) return;
    for (let at = 0; at < bars; at += SLOT_BARS) out.set(s.startBar - bars + at, { bar: at, bars });
  });
  return out;
}
