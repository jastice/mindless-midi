import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../corpus/schema.js";
import { validateCorpus } from "../corpus/validate.js";
import { SetConductor, MAX_TEMPO_STEP } from "../engine/set.js";
import type { PieceOptions } from "../engine/piece.js";
import { type Key, keysCompatible } from "../theory/theory.js";
import { stereo } from "./dsp.js";
import { renderSynthNote } from "./synth.js";
import { styleSound } from "./sound_set.js";
import type { ScoreNote } from "./types.js";

const pack = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const style = pack.find((s) => s.id === "big_beat")!;
const options: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: 0.5 } };

test("Razor Breaks validates without warnings; every groove is broken with a two-and-four backbeat", () => {
  const result = validateCorpus(JSON.parse(readFileSync("styles/big_beat/corpus.json", "utf8")));
  assert.ok(result.ok, result.ok ? "" : result.errors.join("\n"));
  assert.deepEqual(result.warnings, []);
  for (const p of style.corpus.drums.filter((p) => p.kind === "groove")) {
    assert.ok([4, 12].every((i) => p.lanes.snare[i] === "X"), `${p.id}: backbeat`);
    assert.ok([...p.lanes.kick].some((x, i) => /[Xx]/.test(x) && i % 4 !== 0), `${p.id}: syncopation`);
    assert.ok([4, 8, 12].some((i) => p.lanes.kick[i] === "."), `${p.id}: space between kicks`);
  }
});

test("arranged breaks keep their snare, leave gaps for drops and reproduce the same notes", () => {
  let backbeats = 0;
  let offbeats = 0;
  let drops = 0;
  let builds = 0;
  let edits = 0;
  for (const seed of ["BITE-130", "RAZOR-02", "RAZOR-03", "RAZOR-04"]) {
    const piece = new SetConductor([style], seed, options).trackPiece(0);
    const replay = new SetConductor([style], seed, options).trackPiece(0);
    for (let i = 0; i < piece.totalBars; i++) {
      const bar = piece.renderBar(i, i);
      assert.deepEqual(bar, replay.renderBar(i, i));
      assert.ok(bar.info.parts!.length <= style.corpus.arrangement!.most!);
      if (bar.info.turn === "drop") drops++;
      if (bar.info.build) {
        builds++;
        assert.ok(!bar.info.parts!.includes("break"), "the break leaves room for the roll");
      }
      edits += (bar.moves ?? []).filter((m) => m.target === "stutter").length;
      // Fills may deliberately cut the last beat; normal bars retain the backbeat.
      if (bar.info.parts!.includes("break") && bar.info.barInSection < bar.info.sectionBars - 1) {
        const snares = bar.notes.filter((n) => n.part === "break" && n.key === 38);
        for (const beat of [1, 3]) {
          assert.ok(snares.some((n) => Math.abs(n.beat - beat) < 0.08), `${seed} bar ${i}: snare at ${beat}`);
          backbeats++;
        }
        offbeats += bar.notes.filter((n) => n.key === 36 && Math.abs(n.beat - Math.round(n.beat)) > 0.15).length;
      }
    }
  }
  assert.ok(backbeats > 200 && offbeats > 100 && drops >= 4 && builds >= 16 && edits > 0);
});

test("the four-style set reaches Razor Breaks and blends within tempo and key limits", () => {
  const seen = new Set<string>();
  const links = new Set<string>();
  for (const seed of ["razor-travel", "razor-travel-2"]) {
    const set = new SetConductor(pack, seed, options);
    let before: { style: string; bpm: number; key: Key } | undefined;
    let last = -1;
    for (let i = 0; i < 2500; i++) {
      const slice = set.nextSlice();
      const bar = slice.decks.find((d) => d.deck === slice.dominant)!.bar;
      const info = bar.info;
      seen.add(info.styleId);
      if (last !== info.pieceIndex) {
        const now = { style: info.styleId, bpm: set.trackPlan(info.pieceIndex)!.bpm, key: { tonic: info.tonic, mode: info.mode } };
        if (before) {
          assert.ok(Math.abs(now.bpm / before.bpm - 1) <= MAX_TEMPO_STEP + 1e-9);
          assert.ok(keysCompatible(now.key, before.key));
          links.add(`${before.style}>${now.style}`);
        }
        before = now;
        last = info.pieceIndex;
      }
      for (const deck of slice.decks) assert.equal(deck.bar.bpm, bar.bpm);
    }
  }
  assert.deepEqual([...seen].sort(), pack.map((s) => s.id).sort());
  assert.ok([...links].some((p) => p.startsWith("big_beat>")) && [...links].some((p) => p.endsWith(">big_beat")));
});

test("designed sounds render finite, audible audio with headroom at soft and hard velocities", () => {
  const sr = 24000;
  const sound = styleSound(style.corpus)!;
  const sounds = style.corpus.parts!.filter((p) => p.patch).map((p) => ({
    role: p.role, program: style.corpus.instruments.find((i) => i.role === p.role)!.program,
    patch: p.patch!, key: p.role === "bass" ? 33 : 57,
  }));
  sounds.push(...[36, 38, 42, 46, 37, 45, 50, 39].map((key) => ({ role: "drums" as const, program: 0, patch: "", key })));
  for (const s of sounds) for (const vel of [45, 120]) {
    const output = stereo(sr * 2);
    const n: ScoreNote = { ...s, t: 0.01, dur: 0.25, vel, ch: s.role === "drums" ? 9 : 0, beat: 60 / 130, pos: 0 };
    renderSynthNote(output, n, sr, "big_beat", undefined, true, sound);
    let peak = 0;
    let energy = 0;
    for (const channel of [output.l, output.r]) for (const x of channel) {
      assert.ok(Number.isFinite(x));
      peak = Math.max(peak, Math.abs(x));
      energy += x * x;
    }
    assert.ok(peak > 0.001 && energy > 0.0001, `${s.patch || s.key}: silent`);
    assert.ok(peak < 1, `${s.patch || s.key}: peak ${peak}`);
  }
});
