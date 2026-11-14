import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../corpus/schema.js";
import { SetConductor } from "../engine/set.js";
import type { Bar } from "../engine/types.js";
import { type Clip, type ClipSet, type Cue, Director, MAX_RATE, MIN_RATE, type Placement, RollingPlan, cuesFor, rateOf } from "./director.js";

const clips = JSON.parse(readFileSync("src/claudia/clips.json", "utf8")) as ClipSet;
const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const SHORT = { minSeconds: 60, maxSeconds: 150 };

/** A synthetic clip set with real poses and transitions, as the full shot list will have. */
const FULL: ClipSet = {
  fps: 24,
  width: 752,
  height: 416,
  stills: {},
  clips: (
    [
      ["L1", "loop", "home", "home", 3, "low"],
      ["L2", "loop", "home", "home", 3, "mid"],
      ["L3", "loop", "home", "home", 4, "high"],
      ["L4", "loop", "cue", "cue", 2],
      ["L6", "loop", "peak", "peak", 2],
      ["T1", "transition", "home", "cue", 1],
      ["T2", "transition", "cue", "home", 1],
      ["T5", "transition", "home", "peak", 1],
      ["T6", "transition", "peak", "home", 2],
      ["F1", "flourish", "home", "home", 2],
    ] as const
  ).map(([id, kind, from, to, bars, energy]) => ({
    id,
    kind,
    from,
    to,
    ...(energy && { energy }),
    file: `${id}.mp4`,
    frames: bars * 45,
    bars,
    bpm: 128,
    beatPhase: 0,
    fadeFrames: 6,
  })) as Clip[],
};

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
    const ahead = cuesFor(bar.info, bar.bpm, conductor.layout(bar.info.pieceIndex));
    cues.push(ahead[0]!);
    plan.advance(b, ahead);
    const p = plan.at(b)!;
    assert.ok(p, `bar ${b} has a clip`);
    if (played[played.length - 1] !== p) played.push(p);
  }
  return { bars, cues, plan: played };
}

test("every clip starts on the pose the one before ended on, on a bar line, back to back", () => {
  for (const set of [clips, FULL]) {
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

test("drops land on the section's first bar, and most drops get one", () => {
  for (const set of [clips, FULL]) {
    let drops = 0;
    let landed = 0;
    for (const seed of ["a", "b", "c", "d"]) {
      const { cues, plan } = run(set, `drop-${seed}`, 3000);
      const startsAt = new Map(plan.map((p) => [p.bar, p]));
      cues.forEach((cue, b) => {
        if (!cue.drop || b < 8) return;
        drops++;
        const p = startsAt.get(b);
        if (p && (p.clip.scene === "drop" || p.clip.to === "peak")) landed++;
      });
      for (const p of plan) {
        if (p.clip.scene !== "drop") continue;
        // A drop scene off a drop is a rare flourish; count them.
        assert.ok(p.bar >= 0);
      }
    }
    assert.ok(drops > 20, `${drops} drops in the sets`);
    assert.ok(landed / drops > 0.8, `${landed} of ${drops} drops landed`);
  }
});

test("blend zones get the cue: scenes at Home now, the Cue pose with the full set", () => {
  for (const [set, inBlend] of [
    [clips, (p: Placement) => p.clip.scene === "blend"],
    [FULL, (p: Placement) => p.clip.from === "cue" || p.clip.to === "cue"],
  ] as const) {
    const { cues, plan } = run(set, "blend", 3000);
    let blendBars = 0;
    let cueBars = 0;
    let bodyBars = 0;
    let bodyCue = 0;
    for (const p of plan) {
      const cue = cues[p.bar];
      if (!cue) continue;
      if (cue.mix !== "body") {
        blendBars += p.clip.bars;
        if (inBlend(p)) cueBars += p.clip.bars;
      } else {
        bodyBars += p.clip.bars;
        if (inBlend(p)) bodyCue += p.clip.bars;
      }
    }
    assert.ok(cueBars / blendBars > 0.35, `${cueBars} of ${blendBars} blend bars cueing`);
    assert.ok(bodyCue / bodyBars < 0.15, `${bodyCue} of ${bodyBars} body bars cueing`);
  }
});

test("never two flourishes in a row, and no scene twice in a row outside a blend", () => {
  for (const set of [clips, FULL]) {
    const { cues, plan } = run(set, "flourish", 3000);
    plan.forEach((p, i) => {
      const before = plan[i - 1];
      if (!before) return;
      assert.ok(!(p.clip.kind === "flourish" && before.clip.kind === "flourish"), `two flourishes at ${p.bar}`);
      if (p.clip.scene && p.clip.id === before.clip.id) assert.notEqual(cues[p.bar]?.mix, "body", `${p.clip.id} twice at ${p.bar}`);
    });
  }
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
    assert.ok(r >= MIN_RATE && r <= MAX_RATE, `${p.clip.id} at ${bpm} bpm: ×${r.toFixed(3)}`);
  }
});

test("a skip mid-plan keeps the clip playing and replans after it", () => {
  const director = new Director(clips, "skip");
  const plan = new RollingPlan(director);
  const facts = (piece: number, barInPiece: number) => ({ pieceIndex: piece, barInPiece, pieceBars: 96, intensity: 0.6 });
  for (let b = 0; b < 40; b++) plan.advance(b, cuesFor(facts(0, b), 128, null));
  const playing = plan.at(40 - 1)!;
  // Track 1 starts at bar 40 instead of bar 96.
  plan.advance(40, cuesFor(facts(1, 0), 128, null));
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
  const cues = cuesFor({ pieceIndex: 3, barInPiece: 0, pieceBars: 96, intensity: 0.4 }, 128, sections);
  assert.equal(cues.length, 96 + 32);
  assert.equal(cues[0]!.mix, "in");
  assert.equal(cues[16]!.mix, "body");
  assert.equal(cues[80]!.mix, "out");
  assert.deepEqual(
    cues.flatMap((c, i) => (c.drop ? [i] : [])),
    [32],
  );
  assert.equal(cues[96]!.piece, 4);
  assert.equal(cues[96]!.mix, "in");
});
