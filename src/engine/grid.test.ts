/**
 * Parts and the arrangement grid: the grid's rules on minimal techno's real
 * forms, the grid alone on made-up sections, and what a part's notes carry.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Part, StyleBundle } from "../corpus/schema.js";
import { Rng } from "../theory/rng.js";
import { Conductor } from "./conductor.js";
import { type GridPart, type GridSection, PHRASE_BARS, SLOT_BARS, TURN_STEP, mixBars, planGrid } from "./grid.js";
import { evolveLanes, evolveMotif } from "./parts.js";
import { DEFAULT_PIECE_OPTIONS, Piece, type PieceOptions } from "./piece.js";
import { SetConductor, type Slice, mixLeaveOut } from "./set.js";
import type { Bar } from "./types.js";

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const TECHNO = claudia.find((s) => s.id === "minimal_techno")!;
const PARTS = TECHNO.corpus.parts!;
const part = (id: string): Part => PARTS.find((p) => p.id === id)!;
const SET: PieceOptions = { minSeconds: 180, maxSeconds: 360, frame: "set", expression: { gestures: true, velocityFloor: 0.42 } };

const track = (seed: string, lift = 0) => new Piece(TECHNO, seed, 0, { ...SET, lift });
const barsOf = (p: Piece): Bar[] => Array.from({ length: p.totalBars }, (_, b) => p.renderBar(b, b));
const playing = (b: Bar) => (b.info.parts ?? []).filter((id) => !b.info.thin?.includes(id));
/** Ids that are in one bar's grid and not the other's. */
const changed = (a: Bar | undefined, b: Bar) => {
  const before = a?.info.parts ?? [];
  const now = b.info.parts ?? [];
  return [...now.filter((id) => !before.includes(id)), ...before.filter((id) => !now.includes(id))];
};
const breakdown = (p: Piece, bar: number) => {
  const roles = p.sectionAt(bar)!.roles;
  return !roles.includes("bass") || !roles.includes("drums");
};

const SEEDS = Array.from({ length: 24 }, (_, i) => `grid-${i}`);
const LIFTS = [-0.3, -0.15, 0, 0.15, 0.3];

test("minimal techno declares its parts, and a track's bars carry the grid and notes that name their part", () => {
  assert.ok(PARTS.length >= 10 && PARTS.length <= 16, `${PARTS.length} parts`);
  const p = track("carry");
  assert.ok(p.grid);
  const heard = new Set<string>();
  for (const bar of barsOf(p)) {
    assert.ok(bar.info.parts, "every bar has its grid");
    const on = playing(bar);
    for (const n of bar.notes) {
      assert.ok(n.part !== undefined && on.includes(n.part), `bar ${bar.info.barInPiece}: a note of ${n.part} while ${on} play`);
      assert.equal(n.role, part(n.part).role);
      heard.add(n.part);
    }
    // A drum part plays its own lanes and no other's.
    for (const n of bar.notes) if (n.role === "drums") assert.ok(part(n.part!).lanes!.some((l) => ({ kick: 36, snare: 38, rim: 37, clap: 39, closedHat: 42, openHat: 46, ride: 51, crash: 49, tomLow: 45, tomHigh: 50, shaker: 70 })[l] === n.key));
  }
  assert.ok(heard.size >= 6, `parts heard in one track: ${[...heard]}`);
  if (process.env.SHOW_GRID) {
    const rows = barsOf(p).filter((b) => b.info.barInPiece % 4 === 0).map((b) => `${String(b.info.barInPiece).padStart(3)} ${b.info.intensity.toFixed(2)} ${(b.info.turn ?? "").padEnd(5)} ${PARTS.map((x) => (b.info.parts!.includes(x.id) ? x.id : " ".repeat(x.id.length))).join(" ")}  [${p.sectionAt(b.info.barInPiece)!.roles}]`);
    console.log(rows.join("\n"));
  }
});

test("no more than two parts change in a phrase outside a turn or the start of a build, and only every four bars", () => {
  let turns = 0;
  let changes = 0;
  for (const seed of SEEDS) {
    for (const lift of LIFTS) {
      const p = track(seed, lift);
      const bars = barsOf(p);
      const perPhrase = new Map<number, number>();
      bars.forEach((bar, b) => {
        const diff = changed(bars[b - 1], bar);
        if (b === 0 || !diff.length) return;
        assert.equal(bar.info.barInSection % SLOT_BARS, 0, `${seed}: a change on bar ${b}`);
        if (bar.info.turn) {
          assert.equal(bar.info.barInSection, 0);
          turns++;
          return;
        }
        if (bar.info.build?.bar === 0) {
          // A build starts: the kick goes (if it was in) and the roll comes in, and nothing else.
          assert.ok(diff.includes("roll") && diff.every((id) => id === "roll" || id === "kick"), `${seed}: ${diff} as a build starts on bar ${b}`);
          return;
        }
        changes += diff.length;
        assert.ok(diff.length <= 2, `${seed} lift ${lift}: ${diff} change at once on bar ${b}`);
        const phrase = Math.floor(b / PHRASE_BARS);
        perPhrase.set(phrase, (perPhrase.get(phrase) ?? 0) + diff.length);
      });
      for (const [phrase, n] of perPhrase) assert.ok(n <= 2, `${seed} lift ${lift}: ${n} changes in phrase ${phrase}`);
      // A turn is where the plan says: the low end leaves or returns, or the section is a quarter hotter or cooler.
      bars.forEach((bar, b) => {
        if (!bar.info.turn) return;
        const before = p.sectionAt(b - 1)!;
        const now = p.sectionAt(b)!;
        assert.ok(breakdown(p, b) !== breakdown(p, b - 1) || Math.abs(now.intensity - before.intensity) >= TURN_STEP - 1e-9, `${seed}: a turn on bar ${b}`);
      });
    }
  }
  assert.ok(turns > 100 && changes > 1000, `${turns} turns, ${changes} changes`);
});

test("the kick and the bass are absent only in a breakdown or a build, or while the track mixes in and out", () => {
  let out = 0;
  for (const seed of SEEDS) {
    for (const lift of LIFTS) {
      const p = track(seed, lift);
      const mix = mixBars(p.totalBars);
      for (const bar of barsOf(p)) {
        const b = bar.info.barInPiece;
        const on = bar.info.parts!;
        const roles = p.sectionAt(b)!.roles;
        if (!on.includes("kick")) {
          out++;
          assert.ok(breakdown(p, b) || bar.info.build, `${seed}: no kick on bar ${b}, section ${roles}`);
        } else assert.ok(!breakdown(p, b) && !bar.info.build, `${seed}: a kick in the breakdown or a build at bar ${b}`);
        const mixing = b < mix / 2 || b >= p.totalBars - mix / 2;
        if (!on.includes("sub")) assert.ok(!roles.includes("bass") || mixing, `${seed}: no bass on bar ${b}, section ${roles}`);
        else assert.ok(roles.includes("bass") && !mixing);
        // The low end never rests for a fill.
        assert.ok(!bar.info.thin?.includes("kick") && !bar.info.thin?.includes("sub"));
      }
    }
  }
  assert.ok(out > 500, `${out} bars without a kick`);
});

test("a part enters only from its intensity, and a cooler track is a sparser one", () => {
  const mean: number[] = [];
  for (const lift of LIFTS) {
    let sum = 0;
    let n = 0;
    for (const seed of SEEDS) {
      const p = track(seed, lift);
      const bars = barsOf(p);
      bars.forEach((bar, b) => {
        sum += bar.info.parts!.length;
        n++;
        const section = p.sectionAt(b)!;
        for (const id of bar.info.parts!) {
          if (b > 0 && bars[b - 1]!.info.parts!.includes(id)) continue;
          if (id === "kick" || id === "sub" || id === "roll") continue;
          // (Where nothing may play, the coolest part does: a section is never silent.)
          if (bar.info.parts!.length === 1) continue;
          assert.ok(section.roles.includes(part(id).role), `${seed}: ${id} enters a section of ${section.roles}`);
          assert.ok(section.intensity >= (part(id).enters ?? 0) - 1e-9, `${seed} lift ${lift}: ${id} enters at ${section.intensity.toFixed(2)}`);
        }
        assert.ok(bar.info.parts!.length > 0, `${seed}: bar ${b} is empty`);
      });
    }
    mean.push(sum / n);
  }
  console.log(`parts in, on average, at lift ${LIFTS.join(", ")}: ${mean.map((x) => x.toFixed(2)).join(", ")}`);
  for (let i = 1; i < mean.length; i++) assert.ok(mean[i]! > mean[i - 1]! + 0.1, `lift ${LIFTS[i]} plays more than ${LIFTS[i - 1]}`);
  // The style caps how many parts play at once, which narrows the range.
  assert.ok(mean.at(-1)! > mean[0]! + 1.5, "by more than a part and a half from the coolest to the hottest");
  // The same track, cooler: nothing above the line the lift leaves.
  const cool = track("line", -0.3);
  for (const bar of barsOf(cool)) assert.ok(!bar.info.parts!.includes("ride") && !bar.info.parts!.includes("acid"));
});

test("a set's track starts on the kick alone, adds a part every four bars with the bass half way, and ends the same way round", () => {
  for (const seed of SEEDS) {
    const p = track(seed);
    const bars = barsOf(p);
    const mix = mixBars(p.totalBars);
    assert.equal(mix, 16);
    assert.deepEqual(bars[0]!.info.parts, ["kick"]);
    for (let b = 0; b < mix; b++) {
      const on = bars[b]!.info.parts!;
      assert.ok(on.length <= 1 + Math.floor(b / SLOT_BARS), `${seed}: ${on} on bar ${b}`);
      assert.equal(on.includes("sub"), b >= mix / 2, `${seed}: bass on bar ${b}`);
    }
    assert.ok(bars[mix - 1]!.info.parts!.length >= 3);
    const end = p.totalBars;
    for (let b = end - mix; b < end; b++) {
      const on = bars[b]!.info.parts!;
      const left = Math.ceil((end - b) / SLOT_BARS);
      assert.ok(on.length <= left + 1, `${seed}: ${on} with ${end - b} bars to go`);
      assert.ok(changed(bars[b - 1], bars[b]!).every((id) => !on.includes(id) || id === "kick"), `${seed}: only the kick may come back in a mix-out (bar ${b})`);
      if (b >= end - mix / 2) assert.ok(!on.includes("sub"));
    }
    assert.ok(bars[end - 1]!.info.parts!.length <= 2);
    // The conductor leaves nothing out of a style with parts: the grid has done it.
    assert.equal(mixLeaveOut(p, 0), undefined);
  }
});

test("the last bar of a phrase sometimes rests one hat or percussion part", () => {
  let rests = 0;
  let ends = 0;
  for (const seed of SEEDS) {
    for (const bar of barsOf(track(seed))) {
      const b = bar.info.barInPiece;
      if (b % PHRASE_BARS === PHRASE_BARS - 1) ends++;
      if (!bar.info.thin) continue;
      rests++;
      assert.equal(b % PHRASE_BARS, PHRASE_BARS - 1);
      assert.equal(bar.info.thin.length, 1);
      const p = part(bar.info.thin[0]!);
      assert.ok(p.role === "drums" && p.id !== "kick" && bar.info.parts!.includes(p.id));
      assert.ok(!bar.notes.some((n) => n.part === p.id), "and it is silent for that bar");
    }
  }
  const rate = rests / ends;
  console.log(`phrase ends that thin out: ${rests} of ${ends}`);
  assert.ok(rate > 0.1 && rate < TECHNO.corpus.arrangement!.thin + 0.05, `${rate}`);
});

test("the grid is deterministic, and the same after a seek", () => {
  const key = (b: Bar) => JSON.stringify([b.notes, b.info]);
  assert.deepEqual(barsOf(track("same")).map(key), barsOf(track("same")).map(key));
  assert.notDeepEqual(track("same").grid, track("other").grid);
  // Reaching a bar directly gives the grid that playing to it gives.
  const p = track("same");
  const q = track("same");
  for (const b of [57, 3, 120, 16]) assert.deepEqual(q.renderBar(b, 0).info, barsOf(p)[b]!.info);
  // And through the set conductor, notes and all, on both decks where tracks overlap.
  const slice = (s: Slice) => JSON.stringify(s.decks.map((d) => key(d.bar)));
  const run = Array.from({ length: 1200 }, ((c) => () => c.nextSlice())(new SetConductor([TECHNO], "seek-parts")));
  let reached = 0;
  for (const [t, bar] of [[1, 0], [1, 9], [2, 61], [3, 7], [1, 20], [2, 20], [3, 20], [4, 20]] as const) {
    const at = run.findIndex((s) => s.decks.some((d) => d.bar.info.pieceIndex === t && d.bar.info.barInPiece === bar));
    // (A track cut or filtered into starts past its first bars: those are only reached by a seek.)
    if (at < 0) continue;
    reached++;
    const c = new SetConductor([TECHNO], "seek-parts");
    c.seek(t, bar);
    for (let j = 0; j < 64; j++) assert.equal(slice(c.nextSlice()), slice(run[at + j]!), `track ${t} bar ${bar} + ${j}`);
  }
  assert.ok(reached >= 6, `${reached} places reached`);
});

test("a set over minimal techno: every track mixes in and out by part, and the set's lift thins and fills the grid", () => {
  // Each track's own grid, before the set's decks interleave two of them (see set.test.ts for that).
  const c = new SetConductor([TECHNO], "set-parts");
  const perTrack = new Map<number, { lift: number; parts: number; bars: number; firsts: string[][] }>();
  let last: Bar | undefined;
  for (let t = 0; t < 30; t++) {
    const piece = c.trackPiece(t);
    for (let b = 0; b < piece.totalBars; b++) {
      const bar = piece.renderBar(b, b);
      const rec = perTrack.get(t) ?? { lift: c.trackPlan(t)!.lift, parts: 0, bars: 0, firsts: [] };
      perTrack.set(t, rec);
      rec.parts += bar.info.parts!.length;
      rec.bars++;
      if (b === 0) {
        assert.deepEqual(bar.info.parts, ["kick"], `track ${t} starts on its kick`);
        // The track before ended on little: a kick and one more.
        if (last) assert.ok(last.info.parts!.length <= 2, `track ${t - 1} ends on ${last.info.parts}`);
      }
      if (b < 16 && b % 4 === 0) rec.firsts.push(bar.info.parts!);
      for (const n of bar.notes) assert.ok(bar.info.parts!.includes(n.part!));
      last = bar;
    }
  }
  const tracks = [...perTrack.values()].filter((r) => r.bars > 100);
  assert.ok(tracks.length >= 20, `${tracks.length} tracks`);
  for (const r of tracks) {
    // One part more each slot, as far as the opening section's intensity allows; the bass is the third in at the latest.
    const sizes = r.firsts.map((f) => f.length);
    assert.ok(sizes[0] === 1 && sizes.every((n, i) => i === 0 || n === sizes[i - 1]! + 1 || (n === sizes[i - 1] && i !== 2)), `the mix-in adds one part a slot: ${JSON.stringify(r.firsts)}`);
    assert.ok(r.firsts[2]!.includes("sub") && !r.firsts[1]!.includes("sub"));
  }
  assert.ok(tracks.some((r) => r.firsts[3]!.length === 4));
  // Cooler tracks (the warm-up, the troughs of the wave) play fewer parts than hotter ones.
  const byLift = tracks.slice().sort((a, b) => a.lift - b.lift);
  const third = Math.floor(byLift.length / 3);
  const avg = (rs: typeof tracks) => rs.reduce((a, r) => a + r.parts / r.bars, 0) / rs.length;
  const cool = avg(byLift.slice(0, third));
  const hot = avg(byLift.slice(-third));
  console.log(`set: parts in on average, coolest third of tracks ${cool.toFixed(2)} (lift ${byLift[0]!.lift} up), hottest third ${hot.toFixed(2)} (lift up to ${byLift.at(-1)!.lift})`);
  assert.ok(hot > cool + 0.5, `${cool} -> ${hot}`);
});

test("a piece that is not a set's track has a grid too, with no mix-in", () => {
  const c = new Conductor([TECHNO], "plain", DEFAULT_PIECE_OPTIONS);
  const first = c.nextBar();
  assert.deepEqual(first.info.parts, ["kick", "sub"]);
  let ending = false;
  for (let i = 0; i < 400 && !ending; i++) {
    const bar = c.nextBar();
    ending = bar.info.section === "ending";
    if (!bar.info.gap && !ending) assert.ok(bar.info.parts);
  }
  assert.ok(ending, "and it still ends");
});

// --- Pattern evolution ---------------------------------------------------------

/** The style with another `evolve` rate. */
const evolving = (rate: number): StyleBundle => ({ ...TECHNO, corpus: { ...TECHNO.corpus, arrangement: { ...TECHNO.corpus.arrangement!, evolve: rate } } });
/** A part's onsets in a bar, in sixteenths. */
const steps = (bar: Bar, id: string) => bar.notes.filter((n) => n.part === id).map((n) => Math.round(n.beat * 4)).sort((a, b) => a - b).join(",");

test("a part's pattern changes by small steps at phrase boundaries, starts each section as written, and the low end keeps its place", () => {
  let moved = 0;
  let sections = 0;
  for (const seed of SEEDS.slice(0, 8)) {
    const still = new Piece(evolving(0), seed, 0, SET);
    const busy = new Piece(evolving(1), seed, 0, SET);
    assert.deepEqual(busy.grid, still.grid, "evolution does not touch the grid");
    const a = barsOf(still);
    const b = barsOf(busy);
    a.forEach((bar, i) => {
      // The first phrase of a section is the pattern as written, whatever the rate.
      if (bar.info.barInSection < PHRASE_BARS) assert.deepEqual(b[i]!.notes, bar.notes, `${seed}: bar ${i}`);
      // The kick and the bass never move in time.
      for (const id of ["kick", "sub"]) assert.equal(steps(b[i]!, id), steps(bar, id), `${seed}: ${id} on bar ${i}`);
      if (bar.info.barInSection === 0) sections++;
    });
    // Within a phrase a part plays one pattern; across the phrases of a long section it has moved.
    for (const id of ["hat", "bleep", "acid", "rim", "open"]) {
      for (let i = PHRASE_BARS; i < b.length; i++) {
        const bar = b[i]!;
        if (bar.info.barInSection !== 2 * PHRASE_BARS || bar.info.sectionBars < 3 * PHRASE_BARS) continue;
        const first = b[i - 2 * PHRASE_BARS]!;
        if (steps(bar, id) && steps(first, id) && steps(bar, id) !== steps(first, id)) moved++;
      }
    }
    // And a bar reached directly is the bar reached by playing: the changes so far are replayed, not remembered.
    const direct = new Piece(evolving(1), seed, 0, SET);
    for (const i of [70, 30, 100]) {
      const bar = direct.renderBar(i, i);
      for (const id of ["hat", "bleep", "rim", "sub"]) assert.equal(steps(bar, id), steps(b[i]!, id), `${seed}: ${id} on bar ${i}`);
    }
  }
  assert.ok(moved > 10, `${moved} patterns moved over ${sections} sections`);
});

test("one step of evolution is one step: a note more or less, an accent moved, or a turn by a sixteenth", () => {
  const motif = TECHNO.corpus.motifs.find((m) => m.id === "morse")!;
  const groove = TECHNO.corpus.drums.find((d) => d.id === "drive")!;
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const out = evolveMotif(motif, new Rng(`step-${i}`));
    const before = motif.notes.map((n) => n.t);
    const after = out.notes.map((n) => n.t);
    const same = (x: number[], y: number[]) => x.length === y.length && x.every((t, k) => Math.abs(t - y[k]!) < 1e-9);
    const turned = before.map((t) => (t + 0.25) % motif.lengthBeats).sort((x, y) => x - y);
    const kind = after.length === before.length + 1 ? "gain" : after.length === before.length - 1 ? "lose" : same(after, turned) ? "turn" : same(after, before) ? "accent" : "?";
    seen.add(kind);
    assert.notEqual(kind, "?", `${before} -> ${after}`);
    assert.deepEqual(out.notes.map((n) => n.deg).sort(), out.notes.map(() => 0), "no pitch changes");
    for (const n of out.notes) assert.ok(n.t >= 0 && n.t < motif.lengthBeats && Math.abs(n.t * 4 - Math.round(n.t * 4)) < 1e-9);
    // The low end only moves an accent.
    assert.ok(same(evolveMotif(motif, new Rng(`step-${i}`), true).notes.map((n) => n.t), before));

    const lanes = evolveLanes(groove, ["closedHat"], new Rng(`step-${i}`)).lanes;
    assert.equal(lanes.closedHat.length, 16);
    assert.match(lanes.closedHat, /^[Xxo.]{16}$/);
    const hits = (x: string) => x.replace(/\./g, "").length;
    assert.ok(Math.abs(hits(lanes.closedHat) - hits(groove.lanes.closedHat)) <= 1);
    for (const lane of ["kick", "clap", "openHat"] as const) assert.equal(lanes[lane], groove.lanes[lane], "other lanes are untouched");
  }
  assert.deepEqual([...seen].sort(), ["accent", "gain", "lose", "turn"]);
});

// --- The grid alone ----------------------------------------------------------

const P = (id: string, role: GridPart["role"], enters: number, more: Partial<GridPart> = {}): GridPart => ({ id, role, enters, ...more });
const TOY: GridPart[] = [
  P("kick", "drums", 0, { anchor: "kick" }),
  P("hat", "drums", 0.1, { rests: true }),
  P("clap", "drums", 0.5, { rests: true }),
  P("bass", "bass", 0, { anchor: "bass" }),
  P("stab", "comp", 0.3),
  P("pad", "pad", 0.2),
];
const sections = (list: [bars: number, intensity: number, roles: GridPart["role"][]][]): GridSection[] => {
  let startBar = 0;
  return list.map(([bars, intensity, roles]) => {
    const s = { startBar, bars, intensity, roles };
    startBar += bars;
    return s;
  });
};

test("the grid alone: a breakdown takes the low end out at once, and the drop brings everything in", () => {
  const form = sections([
    [16, 0.3, ["drums", "bass", "comp"]],
    [16, 0.4, ["drums", "comp", "pad"]],
    [16, 0.8, ["drums", "bass", "comp", "pad"]],
  ]);
  for (let i = 0; i < 20; i++) {
    const g = planGrid(TOY, form, { change: 0.5, swap: 0.3, thin: 0 }, new Rng(`toy-${i}`));
    assert.deepEqual(g.parts[0], ["kick", "bass"]);
    assert.equal(g.turn[16], "break");
    assert.ok(!g.parts[16]!.includes("kick") && !g.parts[16]!.includes("bass"));
    assert.ok(g.parts[16]!.length > 0, "a breakdown is not silence");
    for (let b = 16; b < 32; b++) assert.ok(!g.parts[b]!.includes("kick") && !g.parts[b]!.includes("bass") && !g.parts[b]!.includes("clap"));
    assert.equal(g.turn[32], "drop");
    assert.deepEqual(g.parts[32], ["kick", "hat", "clap", "bass", "stab", "pad"]);
    assert.equal(g.turn.filter(Boolean).length, 2);
    // With a share, the drop brings the low end, what was playing, and a draw of the rest up to that share of the four that may play.
    const half = planGrid(TOY, form, { change: 0.5, swap: 0.3, thin: 0, drop: 0.5 }, new Rng(`toy-${i}`));
    const on = half.parts[32]!;
    assert.ok(on.includes("kick") && on.includes("bass"));
    for (const id of half.parts[31]!) assert.ok(on.includes(id), `${id} stays through the drop`);
    assert.equal(on.length, 2 + Math.max(2, half.parts[31]!.length), `${on}`);
  }
});

test("the grid alone: a part the next section will not allow leaves ahead of it, one at a time", () => {
  // A small step down (no turn) that rules out the clap and the stab.
  const form = sections([
    [8, 0.6, ["drums", "bass", "comp"]],
    [32, 0.6, ["drums", "bass", "comp"]],
    [16, 0.45, ["drums", "bass"]],
  ]);
  for (let i = 0; i < 20; i++) {
    const g = planGrid(TOY, form, { change: 1, swap: 0, thin: 0 }, new Rng(`ahead-${i}`));
    assert.equal(g.turn.filter(Boolean).length, 0);
    for (let b = 40; b < 56; b++) assert.ok(!g.parts[b]!.includes("clap") && !g.parts[b]!.includes("stab"), `seed ${i}: ${g.parts[b]} on bar ${b}`);
    for (let b = 1; b < 56; b++) {
      const diff = [...g.parts[b]!.filter((x) => !g.parts[b - 1]!.includes(x)), ...g.parts[b - 1]!.filter((x) => !g.parts[b]!.includes(x))];
      assert.ok(diff.length <= 1, `seed ${i}: ${diff} on bar ${b}`);
    }
  }
});

test("the grid alone: with no rate nothing moves by choice", () => {
  const form = sections([[64, 0.9, ["drums", "bass", "comp", "pad"]]]);
  const g = planGrid(TOY, form, { change: 0, swap: 0, thin: 0 }, new Rng("still"));
  for (let b = 0; b < 64; b++) assert.deepEqual(g.parts[b], ["kick", "bass"]);
  const busy = planGrid(TOY, form, { change: 1, swap: 0, thin: 1 }, new Rng("busy"));
  assert.ok(busy.parts[63]!.length > 4, `${busy.parts[63]}`);
  assert.ok(busy.thin.filter(Boolean).length >= 6, "and with thin at 1 every phrase with a hat ends on a gap");
});

test("a style's limits hold: no more of a group than it allows, and no more parts than `most`", () => {
  const { most, groups } = TECHNO.corpus.arrangement!;
  assert.ok(most !== undefined && groups !== undefined);
  let fullest = 0;
  for (const seed of SEEDS)
    for (const lift of LIFTS)
      for (const bar of barsOf(track(seed, lift))) {
        const on = bar.info.parts!.map(part);
        for (const [group, limit] of Object.entries(groups)) {
          const n = on.filter((p) => p.group === group).length;
          assert.ok(n <= limit, `${seed} lift ${lift} bar ${bar.info.barInPiece}: ${n} of group ${group}: ${bar.info.parts}`);
        }
        // The roll of a build is extra.
        const count = on.filter((p) => !p.roll).length;
        assert.ok(count <= most, `${seed} lift ${lift} bar ${bar.info.barInPiece}: ${count} parts: ${bar.info.parts}`);
        fullest = Math.max(fullest, count);
      }
  assert.equal(fullest, most, "the limit is reached somewhere");
});
