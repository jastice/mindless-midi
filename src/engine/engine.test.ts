import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../corpus/schema.js";
import { MODES, chordPitchClasses, mod, parseRoman } from "../theory/theory.js";
import { Conductor, MAX_SEEK_PIECE } from "./conductor.js";
import { barsToMidi } from "./midi_file.js";
import type { Bar } from "./types.js";

const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };

function take(c: Conductor, n: number): Bar[] {
  return Array.from({ length: n }, () => c.nextBar());
}

for (const style of styles) {
  test(`${style.id}: notes are well-formed and mostly consonant`, () => {
    const bars = take(new Conductor([style], `engine-test-${style.id}`), 600);
    let total = 0;
    let inKey = 0;
    const roles = new Set<string>();
    for (const bar of bars) {
      const ranges = [style.corpus.tempo, ...style.corpus.forms.flatMap((f) => (f.tempo ? [f.tempo] : []))];
      assert.ok(ranges.some((r) => bar.bpm >= r.min && bar.bpm <= r.max), `${bar.bpm} bpm outside every tempo range`);
      const { tonic, mode } = bar.info;
      assert.doesNotMatch(bar.info.keyName, /[A-Z][a-z]+[A-Z]/, "display name has no camelCase");
      const allowed = new Set(MODES[mode].map((i) => mod(tonic + i, 12)));
      for (const sym of bar.info.chords) for (const pc of chordPitchClasses(tonic, parseRoman(sym))) allowed.add(pc);
      for (const n of bar.notes) {
        assert.ok(Number.isInteger(n.key) && n.key >= 0 && n.key <= 127, `key ${n.key}`);
        assert.ok(Number.isInteger(n.vel) && n.vel >= 1 && n.vel <= 127, `vel ${n.vel}`);
        assert.ok(n.dur > 0, `dur ${n.dur}`);
        assert.ok(n.beat >= 0 && n.beat < bar.beats + 0.05, `beat ${n.beat}`);
        roles.add(n.role);
        if (n.role === "drums") continue;
        total++;
        // Chromatic approach tones are deliberate; everything else should fit.
        if (allowed.has(mod(n.key, 12))) inKey++;
      }
    }
    const ratio = inKey / total;
    assert.ok(total > 500, `only ${total} pitched notes`);
    assert.ok(ratio > 0.9, `only ${(ratio * 100).toFixed(1)}% of notes fit key/chord`);
    const used = new Set(style.corpus.forms.flatMap((f) => f.sections.flatMap((s) => s.roles)));
    for (const r of used) assert.ok(roles.has(r), `role ${r} never played`);
  });
}

test("pieces stay within the target length", () => {
  const c = new Conductor(styles, "length-test");
  let pieceStart = 0;
  let seconds = 0;
  let pieces = 0;
  for (let i = 0; i < 3000 && pieces < 12; i++) {
    const bar = c.nextBar();
    if (bar.info.barInPiece === 0 && i > 0) {
      assert.ok(seconds >= 120 && seconds <= 420, `piece of ${seconds.toFixed(0)}s`);
      pieces++;
      seconds = 0;
      pieceStart = i;
    }
    seconds += (bar.beats * 60) / bar.bpm;
  }
  assert.ok(pieces >= 10, `${pieces} pieces (last started at bar ${pieceStart})`);
});

test("same seed, same music; different seed, different music", () => {
  const a = JSON.stringify(take(new Conductor(styles, "det"), 80));
  const b = JSON.stringify(take(new Conductor(styles, "det"), 80));
  const c = JSON.stringify(take(new Conductor(styles, "other"), 80));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("style rotation never repeats a style back to back and uses the pool", () => {
  const pool = styles.slice(0, 3);
  const c = new Conductor(pool, "rotation", { minSeconds: 20, maxSeconds: 30 });
  const order: string[] = [];
  for (let i = 0; i < 2000 && order.length < 30; i++) {
    const bar = c.nextBar();
    if (bar.info.barInPiece === 0) order.push(bar.info.styleId);
  }
  for (let i = 1; i < order.length; i++) assert.notEqual(order[i], order[i - 1]);
  assert.deepEqual(new Set(order), new Set(pool.map((s) => s.id)));
});

test("setStyles and skip take effect at the next bar", () => {
  const c = new Conductor([styles[0]!], "skip");
  take(c, 3);
  c.setStyles([styles[1]!]);
  assert.equal(c.nextBar().info.styleId, styles[0]!.id, "current piece continues");
  c.skip();
  const bar = c.nextBar();
  assert.equal(bar.info.styleId, styles[1]!.id);
  assert.equal(bar.info.barInPiece, 0);
  assert.ok(bar.controls.some((x) => x.kind === "reset"));
});

test("seek resumes exactly where a straight run was, skips included", () => {
  const pool = styles.slice(0, 4);
  const opts = { minSeconds: 20, maxSeconds: 30 };
  const run = new Conductor(pool, "seek", opts);
  const bars = take(run, 7);
  run.skip();
  bars.push(...take(run, 500));
  const key = (b: Bar) => JSON.stringify([b.beats, b.bpm, b.notes, b.info]);
  for (const [piece, bar] of [[0, 0], [1, 0], [4, 5], [6, 13]] as const) {
    const at = bars.findIndex((b) => b.info.pieceIndex === piece && b.info.barInPiece === bar);
    assert.ok(at >= 0, `piece ${piece} bar ${bar} reached`);
    const c = new Conductor(pool, "seek", opts);
    c.seek(piece, bar);
    const resumed = take(c, 60);
    let same = 0;
    for (const [j, b] of resumed.entries()) {
      const was = bars[at + j]!;
      if (was.info.pieceIndex !== b.info.pieceIndex) break; // the straight run skipped away from piece 0 here
      assert.equal(key(b), key(was), `piece ${piece} bar ${bar} + ${j}`);
      same++;
    }
    assert.equal(same, piece === 0 ? 7 : 60);
    // The setup of the piece's earlier bars comes along with the first bar, and only with it.
    const setup = bars.slice(at - bar, at + 1).flatMap((b) => b.controls.map((x) => ({ ...x, beat: 0 })));
    assert.deepEqual(resumed[0]!.controls, setup);
    for (const b of resumed.slice(1, 40)) if (b.info.barInPiece > 0) assert.deepEqual(b.controls, []);
  }
});

test("seek clamps wild positions", () => {
  const c = new Conductor(styles, "wild");
  const landed = c.seek(10 ** 9, 10 ** 9);
  const bar = c.nextBar();
  assert.deepEqual(landed, { piece: bar.info.pieceIndex, bar: bar.info.barInPiece });
  assert.equal(bar.info.pieceIndex, MAX_SEEK_PIECE);
  assert.equal(bar.info.barInPiece, bar.info.pieceBars - 1);
  assert.throws(() => c.seek(1, 1), /before the first bar/);
});

test("MIDI export is a valid format-0 file", () => {
  const bars = take(new Conductor(styles, "midi"), 64);
  const bytes = barsToMidi(bars);
  assert.deepEqual([...bytes.slice(0, 4)], [0x4d, 0x54, 0x68, 0x64]);
  assert.deepEqual([...bytes.slice(8, 10)], [0, 0]); // format 0
  assert.deepEqual([...bytes.slice(14, 18)], [0x4d, 0x54, 0x72, 0x6b]);
  const len = (bytes[18]! << 24) | (bytes[19]! << 16) | (bytes[20]! << 8) | bytes[21]!;
  assert.equal(len, bytes.length - 22);
  assert.deepEqual([...bytes.slice(-3)], [0xff, 0x2f, 0x00]);
  const noteOns = bars.reduce((a, b) => a + b.notes.length, 0);
  let found = 0;
  for (let i = 22; i < bytes.length - 2; i++) if ((bytes[i]! & 0xf0) === 0x90 && bytes[i + 2]! > 0) found++;
  assert.ok(found >= noteOns * 0.95, `${found} note-on-like bytes for ${noteOns} notes`);
});

test("area forms use their own tempo, keys, instruments and material", () => {
  const metroid = styles.find((s) => s.id === "metroid")!;
  const forms = new Map(metroid.corpus.forms.map((f) => [f.id, f]));
  const c = new Conductor([metroid], "areas", { minSeconds: 20, maxSeconds: 30 });
  const seen = new Set<string>();
  let pieceProgressions = new Set<string>();
  let area: (typeof metroid.corpus.forms)[number] | undefined;
  const checkPalette = () => {
    if (!area?.palette) return;
    const allowed = new Set(
      metroid.corpus.progressions.filter((p) => p.palette === area!.palette).flatMap((p) => p.chords.map((ch) => ch.symbol)),
    );
    for (const sym of pieceProgressions) assert.ok(allowed.has(sym), `${area.id}: chord ${sym} is not from its palette`);
  };
  for (let i = 0; i < 6000 && seen.size < 5; i++) {
    const bar = c.nextBar();
    if (bar.info.barInPiece === 0) {
      checkPalette();
      pieceProgressions = new Set();
      area = metroid.corpus.forms.find((f) => f.palette !== undefined && f.palette === bar.info.area);
      if (area) {
        seen.add(area.id);
        if (area.tempo) assert.ok(bar.bpm >= area.tempo.min && bar.bpm <= area.tempo.max, `${area.id}: ${bar.bpm} bpm`);
        if (area.keys) {
          assert.ok(
            area.keys.some((k) => bar.info.mode === k.mode && bar.info.keyName.startsWith(k.tonic + " ")),
            `${area.id}: key ${bar.info.keyName}`,
          );
        }
        for (const inst of area.instruments ?? []) {
          if (inst.role === "drums") continue;
          const ch = { lead: 0, counter: 1, arp: 2, pad: 3, comp: 4, bass: 5 }[inst.role];
          assert.ok(
            bar.controls.some((x) => x.kind === "program" && x.ch === ch && x.value === inst.program),
            `${area.id}: ${inst.role} should switch to program ${inst.program}`,
          );
        }
      }
    }
    if (area && !bar.info.gap && bar.info.section !== "ending") for (const sym of bar.info.chords) pieceProgressions.add(sym);
  }
  assert.ok(forms.size > 5);
  assert.equal(seen.size, 5, `areas heard: ${[...seen].join(", ")}`);
});

test("a style never plays the same form twice in a row", () => {
  for (const style of styles) {
    if (style.corpus.forms.length < 2) continue;
    const c = new Conductor([style], `forms-${style.id}`, { minSeconds: 20, maxSeconds: 30 });
    let last = "";
    let pieces = 0;
    for (let i = 0; i < 3000 && pieces < 15; i++) {
      const bar = c.nextBar();
      if (bar.info.barInPiece !== 0) continue;
      const form = c.currentPiece!.formId;
      assert.notEqual(form, last, `${style.id} repeated form ${form}`);
      last = form;
      pieces++;
    }
  }
});
