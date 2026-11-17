import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../corpus/schema.js";
import { SetConductor } from "../engine/set.js";
import type { Bar } from "../engine/types.js";
import { type ClipSet, type Cue, Director, MAX_RATE, MIN_RATE, PHRASE, type Placement, RollingPlan, cuesFor, energyOf, factsOf, isDrop, rateOf, trackFacts } from "./director.js";

const clips = JSON.parse(readFileSync("src/claudia/clips.json", "utf8")) as ClipSet;
const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const SHORT = { minSeconds: 60, maxSeconds: 150 };

/** The shot list's MVP: Home, Vinyl and Peak only, no build, cue or look. */
const MVP: ClipSet = { ...clips, clips: clips.clips.filter((c) => /^(L01|L02|L05|L08|T01|T02|T07|T08)-/.test(c.id)) };
const SETS = [clips, MVP];
const posed = (p: Placement, ...poses: string[]) => poses.includes(p.clip.from) || poses.includes(p.clip.to);

interface Run {
  bars: Bar[];
  cues: Cue[];
  plan: Placement[];
}

/** Play `n` bars of a seeded set the way the page does: each bar, the plan is told what is coming from that bar's facts and its track's sections. */
function run(set: ClipSet, seed: string, n: number, opts = SHORT): Run {
  const conductor = new SetConductor(claudia, seed, opts);
  const plan = new RollingPlan(new Director(set, seed));
  const bars: Bar[] = [];
  const cues: Cue[] = [];
  const played: Placement[] = [];
  for (let b = 0; b < n; b++) {
    const bar = conductor.nextBar();
    bars.push(bar);
    const track = trackFacts(conductor, bar.info.pieceIndex)!;
    const next = track.out ? trackFacts(conductor, bar.info.pieceIndex + 1) : null;
    const ahead = cuesFor(bar.info.barInPiece, bar.bpm, track, next);
    assert.equal(ahead[0]!.barInPiece, bar.info.barInPiece);
    cues.push(ahead[0]!);
    plan.advance(b, ahead);
    const p = plan.at(b)!;
    assert.ok(p, `bar ${b} has a clip`);
    if (played[played.length - 1] !== p) played.push(p);
  }
  return { bars, cues, plan: played };
}

test("every clip starts on the pose the one before ended on, on a bar line, back to back", () => {
  for (const set of SETS) {
    for (const seed of ["a", "b", "c"]) {
      const { plan } = run(set, `booth-${seed}`, 3000);
      assert.ok(plan.length > 300, `${plan.length} clips`);
      plan.forEach((p, i) => {
        assert.ok(Number.isInteger(p.bar) && p.clip.bars >= 1 && Number.isInteger(p.clip.bars));
        const before = plan[i - 1];
        if (!before) return assert.equal(p.clip.from, "home");
        assert.equal(p.clip.from, before.clip.to, `${before.clip.id} -> ${p.clip.id} at bar ${p.bar}`);
        assert.equal(p.bar, before.bar + before.clip.bars, `${p.clip.id} follows ${before.clip.id} without a gap`);
      });
    }
  }
});

test("clips are 3 or 5 bars (a drop clip 2), and every phrase starts on a clip boundary", () => {
  for (const set of SETS) {
    for (const seed of ["a", "b"]) {
      const { cues, plan } = run(set, `phrase-${seed}`, 3000);
      const starts = new Set(plan.map((p) => p.bar));
      for (const p of plan) assert.ok(p.clip.bars === 3 || p.clip.bars === 5 || (isDrop(p.clip) && p.clip.bars === 2), `${p.clip.id}: ${p.clip.bars} bars`);
      let missed = 0;
      cues.forEach((cue, b) => {
        if (cue.barInPiece % PHRASE === 0 && !starts.has(b)) missed++;
      });
      assert.equal(missed, 0, `${missed} phrase starts fall inside a clip`);
    }
  }
});

test("a plan starting mid-phrase is on the phrase grid by the end of the next phrase", () => {
  const director = new Director(clips, "mid");
  for (let from = 1; from < PHRASE; from++) {
    const cues = cuesFor(from, 128, factsOf({ pieceIndex: 0, barInPiece: from, pieceBars: 160, intensity: 0.6 }, null), null);
    const plan = director.plan(0, "home", cues, [], true);
    const starts = new Set(plan.map((p) => p.bar + from));
    for (let phrase = 2 * PHRASE; phrase < 150; phrase += PHRASE) assert.ok(starts.has(phrase), `from bar ${from}: phrase at ${phrase}`);
  }
});

test("drops land on the section's first bar, out of a build when the set has one, and the peak holds its phrase", () => {
  for (const set of SETS) {
    let drops = 0;
    let landed = 0;
    let built = 0;
    let peakBars = 0;
    for (const seed of ["a", "b", "c", "d"]) {
      const { cues, plan } = run(set, `drop-${seed}`, 3000);
      const startsAt = new Map(plan.map((p) => [p.bar, p]));
      const covering = (b: number) => plan.find((p) => p.bar <= b && b < p.bar + p.clip.bars)!;
      cues.forEach((cue, b) => {
        if (!cue.drop || b < 8) return;
        drops++;
        const p = startsAt.get(b);
        if (!p || !isDrop(p.clip)) return;
        landed++;
        if (p.clip.from === "build") built++;
        for (let k = b; k < b + PHRASE; k++) if (covering(k).clip.to === "peak") peakBars++;
      });
      // Drop clips play only on drops.
      for (const p of plan) if (isDrop(p.clip)) assert.ok(cues[p.bar]!.drop, `${p.clip.id} at bar ${p.bar} is not on a drop`);
    }
    assert.ok(drops > 20, `${drops} drops in the sets`);
    assert.ok(landed / drops > 0.8, `${landed} of ${drops} drops landed`);
    assert.ok(peakBars / (landed * PHRASE) > 0.6, `${peakBars} of ${landed * PHRASE} bars after a drop at the peak`);
    // Build is 3-bar clips only, so the phrase before a drop builds only when it starts at Home (5 bars, then T05);
    // from Vinyl, Cue, Peak or Look the drop comes straight from Home (T07).
    if (set === clips) assert.ok(built / landed > 0.5, `${built} of ${landed} drops out of a build`);
  }
});

test("blend zones work the record; the body stays at the decks, with a look now and then", () => {
  for (const [set, least] of [
    [clips, 0.5],
    [MVP, 0.5],
  ] as const) {
    const { cues, plan } = run(set, "blend", 3000);
    let blendBars = 0;
    let recordBars = 0;
    let bodyBars = 0;
    let bodyRecord = 0;
    let bodyLook = 0;
    for (const p of plan) {
      const cue = cues[p.bar];
      if (!cue || cue.moment) continue;
      if (cue.mix !== "body") {
        blendBars += p.clip.bars;
        if (posed(p, "vinyl", "cue")) recordBars += p.clip.bars;
      } else {
        bodyBars += p.clip.bars;
        if (posed(p, "vinyl", "cue")) bodyRecord += p.clip.bars;
        if (posed(p, "look")) bodyLook += p.clip.bars;
      }
    }
    assert.ok(recordBars / blendBars > least, `${recordBars} of ${blendBars} blend bars at the record`);
    assert.ok(bodyRecord / bodyBars < 0.15, `${bodyRecord} of ${bodyBars} body bars at the record`);
    if (set === clips) assert.ok(bodyLook / bodyBars > 0.02 && bodyLook / bodyBars < 0.2, `${bodyLook} of ${bodyBars} body bars looking`);
  }
});

test("flourishes play, but never two in a row", () => {
  const { plan } = run(clips, "flourish", 3000);
  plan.forEach((p, i) => {
    const before = plan[i - 1];
    if (before) assert.ok(!(p.clip.kind === "flourish" && before.clip.kind === "flourish"), `two flourishes at ${p.bar}`);
  });
  const ids = new Set(plan.filter((p) => p.clip.kind === "flourish").map((p) => p.clip.id));
  assert.equal(ids.size, 3, `flourishes played: ${[...ids].join(", ")}`);
});

test("no clip plays two energy steps from what the music plays", () => {
  const step = { low: 0, mid: 1, high: 2 } as const;
  for (const seed of ["a", "b"]) {
    const { cues, plan } = run(clips, `energy-${seed}`, 3000);
    for (const p of plan) {
      const cue = cues[p.bar]!;
      if (p.clip.energy) assert.ok(Math.abs(step[p.clip.energy] - step[energyOf(cue.intensity)]) < 2, `${p.clip.id} at bar ${p.bar}, intensity ${cue.intensity.toFixed(2)}`);
    }
  }
});

test("blend zones are the set's overlaps, and small drops pass at the decks", () => {
  let small = 0;
  for (const seed of ["a", "b"]) {
    const { bars, cues, plan } = run(clips, `overlap-${seed}`, 3000);
    let off = 0;
    bars.forEach((bar, b) => {
      // A cut's bars before it ramp the tempo on one deck: no overlap.
      const overlap = !!bar.transition && bar.transition.type !== "cut" && bar.transition.bars > 0;
      if (overlap !== (cues[b]!.mix !== "body")) off++;
    });
    assert.equal(off, 0, `${off} of ${bars.length} bars disagree with the set on blending`);
    const startsAt = new Map(plan.map((p) => [p.bar, p]));
    bars.forEach((bar, b) => {
      if (bar.info.turn !== "drop" || bar.info.intensity >= 0.5) return;
      small++;
      const p = startsAt.get(b);
      assert.ok(!p || !isDrop(p.clip), `${p?.clip.id} on a small drop at bar ${b}`);
    });
  }
  assert.ok(small >= 5, `${small} small drops`);
});

test("the same seed from the same bar gives the same booth cam", () => {
  const ids = (r: Run) => r.plan.map((p) => `${p.bar}:${p.clip.id}`).join(" ");
  assert.equal(ids(run(clips, "same", 1500)), ids(run(clips, "same", 1500)));
  assert.notEqual(ids(run(clips, "same", 1500)), ids(run(clips, "other", 1500)));
});

test("rates stay within limits at the set's tempos", () => {
  const { bars, plan } = run(clips, "rates", 3000, { minSeconds: 180, maxSeconds: 360 });
  const bpms = new Set(bars.map((b) => b.bpm));
  assert.ok(bpms.size > 1, "the tempo moves");
  for (const p of plan) {
    const bpm = bars[p.bar]!.bpm;
    const r = rateOf(p.clip, bpm);
    assert.ok(r >= MIN_RATE && r <= (p.clip.maxRate ?? MAX_RATE), `${p.clip.id} at ${bpm} bpm: ×${r.toFixed(3)}`);
  }
});

test("a skip mid-plan keeps the clip playing and replans after it", () => {
  const director = new Director(clips, "skip");
  const plan = new RollingPlan(director);
  const facts = (piece: number, barInPiece: number) => ({ pieceIndex: piece, barInPiece, pieceBars: 96, intensity: 0.6 });
  for (let b = 0; b < 40; b++) plan.advance(b, cuesFor(b, 128, factsOf(facts(0, b), null), null));
  const playing = plan.at(40 - 1)!;
  // Track 1 starts at bar 40 instead of bar 96.
  plan.advance(40, cuesFor(0, 128, factsOf(facts(1, 0), null), null));
  if (playing.bar + playing.clip.bars > 40) assert.equal(plan.at(40), playing, "the clip on screen plays on");
  const next = plan.at(playing.bar + playing.clip.bars)!;
  assert.equal(next.bar, playing.bar + playing.clip.bars);
  // After the skip the next clip was planned for the blend of track 1.
  assert.equal(plan.after(playing), next);
});

test("cues mark blend zones, drops and the next track", () => {
  const sections = [
    { start: 0, bars: 32, intensity: 0.4 },
    { start: 32, bars: 32, intensity: 0.8 },
    { start: 64, bars: 32, intensity: 0.5 },
  ];
  const cues = cuesFor(0, 128, factsOf({ pieceIndex: 3, barInPiece: 0, pieceBars: 96, intensity: 0.4 }, sections), null);
  assert.equal(cues.length, 96 + 32);
  assert.equal(cues[0]!.mix, "in");
  assert.equal(cues[16]!.mix, "body");
  assert.equal(cues[80]!.mix, "out");
  assert.deepEqual(
    cues.flatMap((c, i) => (c.drop ? [i] : [])),
    [32],
  );
  assert.deepEqual(
    [23, 24, 31, 32, 39, 40].map((b) => cues[b]!.moment),
    [null, "build", "build", "peak", "peak", null],
  );
  assert.equal(cues[96]!.piece, 4);
  assert.equal(cues[96]!.mix, "in");
});
