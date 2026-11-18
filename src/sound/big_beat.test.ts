/**
 * Big beat, Claudia's fourth style (by Carbon): the corpus is valid, its
 * breakbeat kit and seven synth patches measure as what they are meant to be,
 * a set travels across all four of Claudia's styles within the set's rules,
 * and a whole track through the worker mixes near the others' level with
 * mono lows, phrase-end stutters and no gaps under the backbeat snare.
 *
 * Nobody listened while it was written, so the numbers here are the ears.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROLES, type Role } from "../corpus/constants.js";
import type { StyleBundle } from "../corpus/schema.js";
import { validateCorpus } from "../corpus/validate.js";
import { velocityScale } from "../engine/parts.js";
import type { PieceOptions } from "../engine/piece.js";
import { MAX_TEMPO_STEP, PHRASE_BARS, SetConductor } from "../engine/set.js";
import type { Bar } from "../engine/types.js";
import { MODES, type ModeName, chordPitchClasses, keysCompatible, mod, parseRoman, pitchClass } from "../theory/theory.js";
import { type Stereo, stereo } from "./dsp.js";
import { measureWeight } from "./measure.js";
import { stemMoves } from "./moves.js";
import type { ToStems, ToWorker } from "./protocol.js";
import { barScore } from "./score.js";
import { partLevels, styleSound } from "./sound_set.js";
import { type SoundSet, renderSynthNote } from "./synth.js";
import type { ScoreNote } from "./types.js";

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const BIG = claudia.find((s) => s.id === "big_beat")!;
const MINIMAL = claudia.find((s) => s.id === "minimal_techno")!;
const BERLIN = claudia.find((s) => s.id === "berlin_techno")!;
const PSY = claudia.find((s) => s.id === "psychedelic_house")!;
const FOUR = [MINIMAL, BERLIN, PSY, BIG];
const corpus = BIG.corpus;
const SOUND = styleSound(corpus)!;
const KIT = corpus.synthKit!;
const ID = "big_beat";

const SR = 48000;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const round = (x: number, digits = 2) => Number(x.toFixed(digits));
const numbers: Record<string, Record<string, number>> = {};
const EXPRESSION: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: 0.5 } };

// --- The corpus --------------------------------------------------------------

test("the corpus is valid with no warnings, and is a Claudia style: parts, groups, a cap, moves, patches, a kit", () => {
  const v = validateCorpus(JSON.parse(readFileSync("styles/big_beat/corpus.json", "utf8")));
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  assert.deepEqual(v.warnings, []);
  const parts = corpus.parts!;
  assert.equal(parts.length, 15);
  assert.ok(parts.some((p) => p.roll) && corpus.moves?.build === 1, "a build with a roll before every drop");
  assert.ok(corpus.moves!.stutter >= 0.18, "stutters far more often than techno");
  for (const other of [MINIMAL, BERLIN, PSY]) {
    assert.ok(corpus.moves!.stutter > other.corpus.moves!.stutter * 3, `stutter ${corpus.moves!.stutter} vs ${other.id} ${other.corpus.moves!.stutter}`);
  }
  const a = corpus.arrangement!;
  assert.ok(a.most! < MINIMAL.corpus.arrangement!.most! && a.groups!.line! <= 3 && a.groups!.perc! <= 2 && a.groups!.noise! <= 2);
  assert.equal(parts.filter((p) => p.group === "noise").length, 2);
  for (const p of parts) if (p.role !== "drums" && p.role !== "bass" && p.role !== "pad") assert.equal(p.group, "line", p.id);
  // Every non-drum part plays a patch of the style's own, and none duplicates the other styles'.
  for (const p of parts) if (p.role !== "drums") assert.ok(corpus.patches!.some((x) => x.id === p.patch), p.id);
  for (const other of [MINIMAL, BERLIN, PSY]) {
    for (const p of corpus.patches!) for (const q of other.corpus.patches!) assert.notDeepEqual({ ...p, id: "" }, { ...q, id: "" }, `${p.id} is ${other.id}'s ${q.id}`);
    assert.notDeepEqual(KIT, other.corpus.synthKit);
  }
  assert.ok(!KIT.rumble && KIT.kick.sub && KIT.perc!.filter((p) => p.tuned).length === 2 && KIT.perc!.some((p) => p.fm !== undefined));
  // Long sections, a breakdown with a pad and no bass, a peak with the siren, and 0.3 mix-in/out ends.
  for (const f of corpus.forms) {
    assert.ok(f.sections.every((s) => s.bars === 16 || s.bars === 32), f.id);
    assert.ok(f.sections.some((s) => !s.roles.includes("bass") && s.roles.includes("pad")), `${f.id} has a breakdown with pad`);
    assert.ok(f.sections.some((s) => s.intensity >= 0.85 && s.roles.includes("lead")), `${f.id} has a peak with siren`);
    assert.ok(f.sections.reduce((n, s) => n + s.bars, 0) >= 128, f.id);
    assert.deepEqual([f.sections[0]!.bars, f.sections.at(-1)!.bars], [16, 16], f.id);
    assert.deepEqual([f.sections[0]!.intensity, f.sections.at(-1)!.intensity], [0.3, 0.3], f.id);
    assert.ok(f.sections.at(-2)!.intensity >= 0.65 && f.sections.at(-2)!.roles.includes("drums") && f.sections.at(-2)!.roles.includes("bass"), `${f.id} holds a full body into blends`);
  }
});

test("the grooves and lines: syncopated breakbeats, a driving fuzz bass across every beat, a screaming acid line, and a safe hook", () => {
  // Breakbeats: never four-on-the-floor; kick on beat 1 plus syncopation, backbeat snare on 2 and 4, ghost snares.
  const grooves = corpus.drums.filter((d) => d.kind === "groove" && d.material === undefined);
  assert.ok(grooves.length >= 7);
  let ghosted = 0;
  for (const g of grooves) {
    assert.notEqual(g.lanes.kick, "X...X...X...X...", `${g.id} is four-on-the-floor`);
    assert.equal(g.lanes.kick[0], "X", `${g.id} lands on the one`);
    assert.ok(/[Xx]/.test(g.lanes.kick.slice(1)), `${g.id} has a second kick`);
    assert.ok(/[Xx]/.test(g.lanes.snare[4]!) && /[Xx]/.test(g.lanes.snare[12]!), `${g.id} has backbeat snares on 2 and 4`);
    if (g.lanes.snare.includes("o")) ghosted++;
  }
  assert.ok(ghosted >= grooves.length - 1, "ghost snares fill the breakbeats");

  // The fuzz bass drives across every beat of every bar, so the low end never drops out under beat 2 or 4's snare.
  const bass = corpus.motifs.filter((m) => m.role === "bass");
  assert.ok(bass.length >= 6);
  for (const m of bass) {
    const bars = m.lengthBeats / 4;
    for (let bar = 0; bar < bars; bar++) {
      for (let beat = 0; beat < 4; beat++) {
        const b0 = bar * 4 + beat;
        const b1 = b0 + 1;
        assert.ok(m.notes.some((n) => n.t < b1 - 1e-9 && n.t + n.d > b0 + 1e-9), `${m.id}: empty beat ${b0}`);
      }
    }
    m.notes.forEach((n, i) => {
      if (n.g !== "slide") return;
      const before = m.notes[i - 1]!;
      assert.ok(before && Math.abs(before.t + before.d - n.t) < 1e-9, `${m.id}: slide at ${n.t} touches the note before`);
    });
  }

  // Screaming sawtooth acid: driven, resonant, tied slides and barking accents.
  const acidPatch = corpus.patches!.find((p) => p.id === "acid")!;
  assert.ok(acidPatch.osc.wave === "saw" && (acidPatch.drive ?? 0) >= 2.5 && acidPatch.glide !== undefined && acidPatch.accent !== undefined && acidPatch.filter.q >= 7);
  const acid = corpus.motifs.filter((m) => m.material === "acid");
  assert.ok(acid.length >= 5);
  for (const m of acid) {
    assert.ok(m.notes.some((n) => n.g === "accent") && m.notes.some((n) => n.g === "slide"), m.id);
    m.notes.forEach((n, i) => {
      if (n.g !== "slide") return;
      const before = m.notes[i - 1]!;
      assert.ok(Math.abs(before.t + before.d - n.t) < 1e-9 && n.d >= 0.25 && before.d >= 0.25, `${m.id}: tied slide at ${n.t}`);
    });
    assert.ok(m.notes.length / (m.lengthBeats / 4) <= 9, `${m.id}: at most nine notes a bar`);
  }

  // Running lines: hook (0.2) is cooler than acid (0.45) and siren (0.7), and keeps to {0, 3, 4, 7}.
  const running = corpus.parts!.filter((p) => ["arp", "lead", "counter"].includes(p.role)).sort((x, y) => (x.enters ?? 0) - (y.enters ?? 0));
  assert.deepEqual(running.map((p) => p.id), ["hook", "acid", "siren"]);
  const hook = corpus.motifs.filter((m) => m.material === "hook");
  assert.ok(hook.length >= 5);
  for (const m of hook) {
    assert.equal(m.anchor, "key", m.id);
    for (const n of m.notes) assert.ok([0, 3, 4, 7].includes(n.deg), `${m.id}: degree ${n.deg}`);
  }

  // Every chord symbol sits inside both dorian and mixolydian without a clashing third.
  for (const mode of ["dorian", "mixolydian"] as const) {
    const scale = new Set<number>(MODES[mode]);
    for (const p of corpus.progressions) {
      for (const ch of p.chords) {
        for (const pc of chordPitchClasses(0, parseRoman(ch.symbol))) {
          assert.ok(scale.has(mod(pc, 12)), `${ch.symbol} pitch class ${pc} in ${mode}`);
        }
      }
    }
  }
});

test("tempo and keys: reaches down to 112 bpm inside the booth cam's window, and keys neighbour all three other styles", () => {
  assert.deepEqual(corpus.tempo, { min: 112, max: 128 });
  assert.equal(corpus.beatsPerBar, 4);
  assert.ok(corpus.swing > 0 && corpus.swing <= 0.2 && corpus.swingUnit === "16th");
  // Booth cam 120-BPM clips allow 0.9x..1.16x (108..139.2 BPM).
  assert.ok(corpus.tempo.min / 120 >= 0.9 && corpus.tempo.max / 120 <= 1.16);
  // Overlaps psychedelic house and minimal techno directly, and reaches Berlin techno in one 3% step.
  assert.ok(corpus.tempo.min < PSY.corpus.tempo.min && corpus.tempo.max >= MINIMAL.corpus.tempo.min);
  assert.ok(Math.floor(corpus.tempo.max * (1 + MAX_TEMPO_STEP)) >= BERLIN.corpus.tempo.min);

  const key = (k: { tonic: string; mode: string }) => ({ tonic: pitchClass(k.tonic), mode: k.mode as ModeName });
  const mine = corpus.keys.map(key);
  assert.deepEqual([...new Set(corpus.keys.map((k) => k.mode))].sort(), ["dorian", "mixolydian"]);
  for (const k of mine) assert.ok(mine.filter((o) => keysCompatible(k, o)).length >= 4, `${JSON.stringify(k)} has neighbours of its own`);
  for (const other of [MINIMAL, BERLIN, PSY]) {
    const theirs = other.corpus.keys.map(key);
    for (const k of mine) assert.ok(theirs.some((o) => keysCompatible(k, o)), `${other.id}: from ${JSON.stringify(k)}`);
    for (const k of theirs) assert.ok(mine.some((o) => keysCompatible(k, o)), `${other.id}: into big_beat from ${JSON.stringify(k)}`);
  }
});

// --- A set over all four styles ------------------------------------------------

test("a set over all four styles: each plays, none is stuck, every change keeps tempo and key, pairs overlap, stutters fire, limits hold", () => {
  const { most, groups } = corpus.arrangement!;
  const groupOf = new Map(corpus.parts!.map((p) => [p.id, p.group]));
  type Track = { style: string; bpm: number; key: { tonic: number; mode: ModeName } };
  const count: Record<string, number> = {};
  const tempos: Record<string, number[]> = {};
  const overlaps: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const stuttersByStyle: Record<string, number> = {};
  const seen = new Set<string>();
  const links: Record<string, string> = {};
  const link = (what: string, seed: string, track: number, bar: number) => (links[what] ??= `?seed=${seed}&at=${track + 1}.${bar + 1}`);
  let fullest = 0;
  let builds = 0;
  let long = 0;
  let drifts = 0;
  let alone = 0;
  let under = 0;
  let hookUnder = 0;
  let hotUnder = 0;
  let longestWait = 0;
  const SEEDS = ["big-a", "big-b", "big-c", "big-d", "big-e", "big-f"];
  const BARS = 5000;
  for (const seed of SEEDS) {
    const c = new SetConductor(FOUR, seed, EXPRESSION);
    let last = -1;
    let before: Track | undefined;
    const since: Record<string, number> = {};
    for (let i = 0; i < BARS; i++) {
      const s = c.nextSlice();
      const own = s.decks.find((d) => d.deck === s.dominant)!.bar;
      const info = own.info;
      if (info.pieceIndex !== last) {
        last = info.pieceIndex;
        assert.equal(i % PHRASE_BARS, 0, "a track takes over on a phrase");
        const track: Track = { style: info.styleId, bpm: c.trackPlan(info.pieceIndex)!.bpm, key: { tonic: info.tonic, mode: info.mode } };
        if (before) {
          assert.ok(Math.abs(track.bpm / before.bpm - 1) <= MAX_TEMPO_STEP + 1e-9, `${seed}: ${before.bpm} to ${track.bpm}`);
          assert.ok(keysCompatible(track.key, before.key), `${seed}: ${JSON.stringify(before.key)} to ${JSON.stringify(track.key)}`);
          assert.notEqual(track.style, before.style);
        }
        count[track.style] = (count[track.style] ?? 0) + 1;
        (tempos[track.style] ??= []).push(track.bpm);
        for (const st of FOUR) {
          since[st.id] = st.id === track.style ? 0 : (since[st.id] ?? 0) + 1;
          longestWait = Math.max(longestWait, since[st.id]!);
        }
        before = track;
        if (track.style === ID) link("a track, where its body starts", seed, info.pieceIndex, Math.max(info.barInPiece, 16));
      }
      if (s.decks.length === 2 && s.transition!.bar === 0) {
        const [from, to] = s.decks.map((d) => d.bar.info);
        const pair = `${from!.styleId} > ${to!.styleId}`;
        overlaps[pair] = (overlaps[pair] ?? 0) + 1;
        kinds[s.transition!.type] = (kinds[s.transition!.type] ?? 0) + 1;
        if (s.transition!.type === "blend" && from!.barInPiece >= 4) {
          if (to!.styleId === ID) link(`a blend into it, from ${from!.styleId}`, seed, from!.pieceIndex, from!.barInPiece - 4);
          if (from!.styleId === ID) link(`a blend out of it, into ${to!.styleId}`, seed, from!.pieceIndex, from!.barInPiece - 4);
        }
      }
      if (s.decks.length === 1) {
        const bar = s.decks[0]!.bar;
        if (bar.moves?.some((m) => m.target === "stutter")) {
          stuttersByStyle[bar.info.styleId] = (stuttersByStyle[bar.info.styleId] ?? 0) + 1;
          if (bar.info.styleId === ID && bar.info.barInPiece >= 4) link("a phrase-end stutter", seed, bar.info.pieceIndex, bar.info.barInPiece - 3);
        }
      }
      for (const d of s.decks) {
        const b = d.bar.info;
        if (b.styleId !== ID) continue;
        const on = b.parts!;
        for (const id of on) seen.add(id);
        if (s.decks.length === 2) {
          if (d.deck !== s.dominant) {
            under++;
            if (on.includes("hook")) hookUnder++;
            if (on.includes("acid") || on.includes("siren")) hotUnder++;
            assert.ok(!on.includes("fuzz"), `${seed} bar ${i}: bass on the non-dominant deck: ${on}`);
            assert.ok(["hook", "acid", "siren"].filter((id) => on.includes(id)).length <= 1, `${seed} bar ${i}: ${on}`);
          }
          continue;
        }
        alone++;
        fullest = Math.max(fullest, on.length);
        assert.ok(on.length <= most!, `${seed} bar ${i}: ${on.length} parts: ${on}`);
        for (const [group, limit] of Object.entries(groups!)) assert.ok(on.filter((id) => groupOf.get(id) === group).length <= limit, `${seed} bar ${i}: ${group}: ${on}`);
        if (!on.includes("kick")) assert.ok(b.build !== undefined || !on.includes("fuzz"), `${seed} bar ${i}: ${on}`);
        if (b.build?.bar === 0) {
          builds++;
          if (b.build.bars === 8) long++;
          assert.ok(!on.includes("kick") && on.includes("roll"), "a build: kick out, roll in");
          link("four bars before a build into a drop", seed, b.pieceIndex, b.barInPiece - 4);
        }
        const drift = d.bar.moves?.find((m) => m.target === "patch" && m.scope !== "master" && m.scope.part !== undefined);
        if (drift?.span?.bar === 0) drifts++;
        if (on.includes("acid") && on.includes("siren") && b.intensity >= 0.85 && on.includes("kick")) {
          link("peak with acid and siren", seed, b.pieceIndex, b.barInPiece);
        }
      }
    }
  }
  const total = Object.values(count).reduce((x, y) => x + y, 0);
  const span = (ts: number[]) => `${Math.min(...ts)} to ${Math.max(...ts)} bpm`;
  const mine = tempos[ID]!;
  console.log(
    `a set over all four styles, ${SEEDS.length} seeds of ${BARS} bars, ${total} tracks:\n` +
      FOUR.map((s) => `  ${s.id}: ${count[s.id]} tracks (${span(tempos[s.id]!)}, ${stuttersByStyle[s.id] ?? 0} stutters)`).join("\n") +
      `\n  big beat in its own range (112 to 128) ${mine.filter((x) => x <= 128).length} times of ${mine.length}; median ${mine.slice().sort((x, y) => x - y)[mine.length >> 1]} bpm` +
      `\n  overlaps: ${Object.entries(overlaps).map(([k, n]) => `${k} ${n}`).join(", ")}` +
      `\n  kinds: ${JSON.stringify(kinds)}; the longest any style waits: ${longestWait} tracks` +
      `\n  big beat alone (${alone} bars): parts in at most ${fullest}; ${builds} builds (${long} of 8 bars); ${drifts} cutoff drifts; ${stuttersByStyle[ID] ?? 0} stutters` +
      `\n  as the deck without the low end, ${under} bars: hook plays in ${hookUnder}, acid/siren in ${hotUnder}` +
      `\n  links:\n${Object.entries(links).map(([k, l]) => `    ${k}: ${l}`).join("\n")}`,
  );
  for (const s of FOUR) assert.ok(count[s.id]! >= total / 6, `${s.id} plays: ${count[s.id]} of ${total}`);
  assert.ok(longestWait <= 24, `no style is away too long: ${longestWait}`);
  for (const x of FOUR) for (const y of FOUR) if (x !== y) assert.ok((overlaps[`${x.id} > ${y.id}`] ?? 0) >= 2, `${x.id} into ${y.id} overlap: ${overlaps[`${x.id} > ${y.id}`]}`);
  assert.ok(Math.min(...mine) <= 118 && mine.filter((x) => x <= 128).length >= mine.length / 2, "it reaches down into mid-tempo breakbeat territory");
  assert.equal(fullest, most, "the cap is reached somewhere");
  assert.ok(builds >= count[ID]! / 2 && long >= 4 && long < builds, "most tracks build, with both 4- and 8-bar builds");
  assert.ok(drifts >= count[ID]! / 3, `cutoff drifts: ${drifts} in ${count[ID]} tracks`);
  const myStutterPerTrack = (stuttersByStyle[ID] ?? 0) / count[ID]!;
  for (const other of [MINIMAL, BERLIN, PSY]) {
    const theirs = (stuttersByStyle[other.id] ?? 0) / count[other.id]!;
    assert.ok(myStutterPerTrack > theirs * 2.5, `stutters per track ${myStutterPerTrack.toFixed(2)} vs ${other.id} ${theirs.toFixed(2)}`);
  }
  assert.ok(hookUnder > under / 2 && hotUnder < under / 4, "over another track's low end it is the hook, seldom acid or siren");
  assert.deepEqual([...seen].sort(), corpus.parts!.map((p) => p.id).sort(), "every part is heard");
  assert.equal(Object.keys(links).length, 10, `links: ${Object.keys(links)}`);
});

// --- The sounds, measured ------------------------------------------------------

const cut = (s: Stereo, from: number, to: number): Stereo => ({ l: s.l.slice(Math.round(from * SR), Math.round(to * SR)), r: s.r.slice(Math.round(from * SR), Math.round(to * SR)) });
const rms = (s: Stereo, from = 0, to = s.l.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return Math.sqrt(e / (2 * Math.max(1, to - from)));
};
const peak = (s: Stereo) => s.l.reduce((m, x, i) => Math.max(m, Math.abs(x), Math.abs(s.r[i]!)), 0);

/** Power per frequency bin of a channel (radix-2 FFT, zero-padded), and the bin width in Hz. */
function spectrum(x: Float32Array): { power: Float64Array; hz: number } {
  let n = 1;
  while (n < x.length) n *= 2;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j]!, re[i]!];
  }
  for (let len = 2; len <= n; len *= 2) {
    const wr = Math.cos((2 * Math.PI) / len);
    const wi = -Math.sin((2 * Math.PI) / len);
    for (let at = 0; at < n; at += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = at + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  const power = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) power[i] = re[i]! ** 2 + im[i]! ** 2;
  return { power, hz: SR / n };
}

/** Share of the energy between `lo` and `hi` Hz. */
function share(s: Stereo, lo: number, hi: number): number {
  let inside = 0;
  let total = 0;
  for (const ch of [s.l, s.r]) {
    const { power, hz } = spectrum(ch);
    for (let i = 0; i < power.length; i++) {
      total += power[i]!;
      if (i * hz >= lo && i * hz < hi) inside += power[i]!;
    }
  }
  return total > 0 ? inside / total : 0;
}

/** Seconds from the loudest 5 ms window until the level has stayed `drop` dB under it. */
function ringTime(s: Stereo, drop = 20): number {
  const hop = Math.round(0.005 * SR);
  const env: number[] = [];
  for (let at = 0; at + hop <= s.l.length; at += hop) env.push(rms(s, at, at + hop));
  const top = Math.max(...env);
  const from = env.indexOf(top);
  let last = from;
  for (let i = from; i < env.length; i++) if (db(env[i]! / top) > -drop) last = i;
  return ((last + 1 - from) * hop) / SR;
}

/** Cheap brightness: the mean frequency weighted by energy. */
function brightness(s: Stereo): number {
  let a = 0;
  let b = 0;
  for (let i = 1; i < s.l.length; i++) {
    a += (s.l[i]! - s.l[i - 1]!) ** 2;
    b += s.l[i]! ** 2;
  }
  return (Math.sqrt(a / Math.max(b, 1e-20)) * SR) / (2 * Math.PI);
}

function correlation(s: Stereo): number {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < s.l.length; i++) {
    lr += s.l[i]! * s.r[i]!;
    ll += s.l[i]! ** 2;
    rr += s.r[i]! ** 2;
  }
  return lr / Math.sqrt(ll * rr);
}

const lean = (s: Stereo) => db(rms({ l: s.l, r: s.l }) / rms({ l: s.r, r: s.r }));

const drumNote = (t: number, key: number, more: Partial<ScoreNote> = {}): ScoreNote => ({ t, dur: 0.1, key, vel: 110, ch: 9, role: "drums", program: 0, ...more });

function render(notes: ScoreNote[], seconds: number, sound: SoundSet = SOUND): Stereo {
  const out = stereo(Math.round(seconds * SR));
  notes.forEach((n, i) => renderSynthNote(out, n, SR, "none", notes[i - 1], false, sound));
  return out;
}

/** A patch as its part plays it, at 120 BPM. */
const BEAT = 60 / 120;
function play(patch: string, role: Role, keys: number[], dur: number, seconds: number, pos = 0): Stereo {
  return render(keys.map((key) => ({ t: 0.01, dur, key, vel: 100, ch: 0, role, program: 80, patch, beat: BEAT, pos })), seconds);
}

const kitOf = (s: StyleBundle): SoundSet => {
  const { rumble: _, ...dry } = s.corpus.synthKit!;
  return { kit: dry };
};

test("kick: hard, mono, punchier strike than psychedelic house, no rumble, tight enough for syncopated doubles", () => {
  const kick = render([drumNote(0, 36)], 1.5);
  const psyKick = render([drumNote(0, 36)], 1.5, kitOf(PSY));
  const m = (numbers.kick = {
    below90: round(share(kick, 0, 90)),
    below150: round(share(kick, 0, 150)),
    above1k: round(share(kick, 1000, Infinity), 5),
    psyAbove1k: round(share(psyKick, 1000, Infinity), 5),
    strikeBrightness: round(brightness(cut(kick, 0, 0.01)), 0),
    psyStrikeBrightness: round(brightness(cut(psyKick, 0, 0.01)), 0),
    ringSeconds: round(ringTime(kick)),
    peak: round(peak(kick)),
  });
  assert.ok(m.below90 > 0.7 && m.below150 > 0.9, JSON.stringify(m));
  assert.ok(m.above1k > m.psyAbove1k * 2 && m.strikeBrightness > m.psyStrikeBrightness, `harder strike than house: ${JSON.stringify(m)}`);
  assert.ok(m.ringSeconds > 0.14 && m.ringSeconds < 0.4, `tight for syncopated breakbeats: ${m.ringSeconds} s`);
  assert.ok(m.peak < 1);
  assert.deepEqual(kick.l, kick.r);
});

test("snare and kit: a fat mid-bodied breakbeat snare, crunchy hats, tuned Apache bongos and a metallic cowbell", () => {
  const one = (key: number, seconds: number, more: Partial<ScoreNote> = {}) => render([drumNote(0.01, key, more)], seconds);
  const snare = one(38, 1);
  const psySnare = render([drumNote(0.01, 38)], 1, kitOf(PSY));
  const berlinSnare = render([drumNote(0.01, 38)], 1, kitOf(BERLIN));
  const closed = one(42, 0.6);
  const open = one(46, 1.5);
  const clap = one(39, 1);
  const bongoLow = one(45, 1);
  const bongoHigh = one(50, 1);
  const cowbell = one(37, 0.8);
  const tamb = one(70, 0.6);
  const m = (numbers.kit = {
    snareBelow2k: round(share(snare, 120, 2000)),
    psySnareBelow2k: round(share(psySnare, 120, 2000)),
    berlinSnareBelow2k: round(share(berlinSnare, 120, 2000)),
    snareRing: round(ringTime(snare), 3),
    hatAbove4k5: round(share(closed, 4500, Infinity), 3),
    hatBelow2k5: round(share(closed, 0, 2500), 5),
    hatRing: round(ringTime(closed), 3),
    openRing: round(ringTime(open), 3),
    clapBand: round(share(clap, 450, 2800)),
    clapRing: round(ringTime(clap), 3),
    bongoLowOn165: round(share(cut(bongoLow, 0.05, 0.4), 145, 190)),
    bongoHighOn220: round(share(cut(bongoHigh, 0.04, 0.35), 195, 250)),
    cowbellMid: round(share(cowbell, 350, 2500)),
    cowbellRing: round(ringTime(cowbell), 3),
    tambAbove4k: round(share(tamb, 4000, Infinity)),
  });
  assert.ok(m.snareBelow2k > 0.35 && m.snareBelow2k > m.psySnareBelow2k * 2 && m.snareBelow2k > m.berlinSnareBelow2k * 1.8, `fatter breakbeat snare body: ${JSON.stringify(m)}`);
  assert.ok(m.snareRing > 0.12 && m.snareRing < 0.45, `snare ring: ${m.snareRing} s`);
  assert.ok(m.hatAbove4k5 > 0.9 && m.hatBelow2k5 < 0.002 && m.hatRing <= 0.08, JSON.stringify(m));
  assert.ok(m.openRing > 3 * m.hatRing && m.openRing < 0.6, `open hat: ${m.openRing} s`);
  assert.ok(m.clapBand > 0.75 && m.clapRing > 0.12 && m.clapRing < 0.45, JSON.stringify(m));
  assert.ok(m.bongoLowOn165 > 0.8 && m.bongoHighOn220 > 0.8, `Apache bongos on the fifth and root of A: ${JSON.stringify(m)}`);
  // Transposed with the track's tonic: on D (+5 semitones, nearest is +5 -> 220 Hz and 293.7 Hz).
  assert.ok(share(cut(one(50, 1, { tonic: 2 }), 0.04, 0.35), 262, 330) > 0.8);
  assert.ok(m.cowbellMid > 0.7 && m.cowbellRing > 0.08 && m.cowbellRing < 0.35, `FM cowbell: ${JSON.stringify(m)}`);
  assert.ok(m.tambAbove4k > 0.8, JSON.stringify(m));
  for (const s of [snare, closed, open, clap, bongoLow, bongoHigh, cowbell, tamb]) assert.ok(peak(s) < 1);
});

test("fuzz bass and breakbeat: mono, sub weight plus overdriven harmonic bite, and steady low end across all four beats", () => {
  const m: Record<string, number> = (numbers.fuzz = {});
  for (const key of [35, 40, 45]) {
    const note = play("fuzz", "bass", [key], 0.5 * BEAT, 1.5);
    assert.deepEqual(note.l, note.r);
    m[`subAndLow${key}`] = round(share(note, 20, 160));
    assert.ok(m[`subAndLow${key}`]! > 0.5, `key ${key}: ${m[`subAndLow${key}`]}`);
  }
  const note = play("fuzz", "bass", [40], 0.5 * BEAT, 1.5);
  const otherBasses = [MINIMAL, BERLIN, PSY].map((s) => {
    const id = s.corpus.parts!.find((p) => p.role === "bass")!.patch!;
    return render([{ t: 0.01, dur: 0.5 * BEAT, key: 40, vel: 100, ch: 1, role: "bass", program: 38, patch: id, beat: BEAT, pos: 0 }], 1.5, styleSound(s.corpus)!);
  });
  m.biteAbove180 = round(share(note, 180, 2000), 3);
  m.minimalAbove180 = round(share(otherBasses[0]!, 180, 2000), 3);
  m.berlinAbove180 = round(share(otherBasses[1]!, 180, 2000), 3);
  m.psyAbove180 = round(share(otherBasses[2]!, 180, 2000), 3);
  m.peak = round(peak(note));
  assert.ok(m.biteAbove180 > 0.12 && m.biteAbove180 > m.berlinAbove180 * 2 && m.biteAbove180 > m.psyAbove180 * 2, `overdriven harmonic bite: ${JSON.stringify(m)}`);
  assert.ok(m.peak < 1);

  // Two bars of a syncopated breakbeat (kick on 1 and the '&' of 3, snare on 2 and 4) with the fuzz bass driving every beat,
  // mixed at the style's drum and bass instrument volumes: the low end below 150 Hz stays strong across all four beats.
  const drumGain = corpus.instruments.find((i) => i.role === "drums")!.volume;
  const bassGain = corpus.instruments.find((i) => i.role === "bass")!.volume;
  const drumNotes: ScoreNote[] = [];
  const bassNotes: ScoreNote[] = [];
  for (let bar = 0; bar < 2; bar++) {
    const b = bar * 4;
    drumNotes.push(drumNote(b * BEAT, 36), drumNote((b + 2.5) * BEAT, 36), drumNote((b + 1) * BEAT, 38), drumNote((b + 3) * BEAT, 38));
    for (let step = 0; step < 8; step++) {
      const key = step === 3 ? 47 : step === 6 ? 45 : 40;
      bassNotes.push({ t: (b + step * 0.5) * BEAT, dur: 0.5 * BEAT, key, vel: step % 2 === 0 ? 105 : 88, ch: 1, role: "bass", program: 38, patch: "fuzz", beat: BEAT, pos: b + step * 0.5 });
    }
  }
  const dStem = render(drumNotes, 8 * BEAT);
  const bStem = render(bassNotes, 8 * BEAT);
  const groove = stereo(dStem.l.length);
  for (let i = 0; i < groove.l.length; i++) {
    groove.l[i] = dStem.l[i]! * drumGain + bStem.l[i]! * bassGain;
    groove.r[i] = dStem.r[i]! * drumGain + bStem.r[i]! * bassGain;
  }
  const beatLow = [4, 5, 6, 7].map((b) => {
    const c = cut(groove, b * BEAT, (b + 1) * BEAT);
    return db(rms(c) * Math.sqrt(share(c, 0, 150)));
  });
  m.beatLowSpreadDb = round(Math.max(...beatLow) - Math.min(...beatLow), 1);
  assert.ok(m.beatLowSpreadDb < 5, `continuous low end across all 4 beats: ${beatLow.map((x) => x.toFixed(1))} dB`);
  assert.ok(peak(groove) < 1.2);
});

const acidNote = (t: number, dur: number, key: number, more: Partial<ScoreNote> = {}): ScoreNote => ({ t, dur, key, vel: 96, ch: 2, role: "arp", part: "acid", program: 80, patch: "acid", beat: BEAT, pos: t / BEAT, ...more });
function touched(notes: ScoreNote[], seconds: number): Stereo {
  const out = stereo(Math.round(seconds * SR));
  notes.forEach((n, i) => renderSynthNote(out, n, SR, "none", notes[i - 1], true, SOUND));
  return out;
}

test("acid: mono, screaming sawtooth, an accent barks, a slide is tied, and the cutoff sweeps over 16 bars", () => {
  const sixteenth = BEAT / 4;
  const plain = touched([acidNote(0.01, sixteenth, 45)], 1);
  const accent = touched([acidNote(0.01, sixteenth, 45, { gesture: "accent", vel: 112 })], 1);
  assert.deepEqual(plain.l, plain.r);
  const held = touched([acidNote(0.01, 2 * BEAT, 45)], 2);
  const slide = { gesture: "slide" as const, curves: { bend: [[0, -2], [0.05, 0]] as [number, number][] } };
  const first = () => acidNote(0.01, sixteenth, 45, { gesture: "accent", vel: 112 });
  const tied = touched([first(), acidNote(0.01 + sixteenth, 2 * sixteenth, 52, slide)], 1);
  const struck = touched([first(), acidNote(0.01 + sixteenth, 2 * sixteenth, 52)], 1);
  const join = 0.01 + sixteenth;
  const across = (s: Stereo) => db(rms(cut(s, join, join + 0.01)) / rms(cut(s, join - 0.01, join)));
  // 64-beat sine modulator: widest open at 16 beats, most closed at 48 beats.
  const at = (pos: number) => cut(touched([acidNote(0.01, 2 * BEAT, 45, { pos })], 1), 0.3, 0.5);
  const m = (numbers.acid = {
    below80: round(share(plain, 0, 80), 3),
    band100to5k: round(share(plain, 100, 5000), 3),
    ringSeconds: round(ringTime(plain), 3),
    brightStrike: round(brightness(cut(held, 0.012, 0.04)), 0),
    brightHeld: round(brightness(cut(held, 0.4, 0.6)), 0),
    accentBrightness: round(brightness(cut(accent, 0.01, 0.1)) / brightness(cut(plain, 0.01, 0.1)), 2),
    accentDb: round(db(rms(cut(accent, 0.01, 0.15)) / rms(cut(plain, 0.01, 0.15))), 1),
    tiedAcrossJoinDb: round(across(tied), 1),
    struckAcrossJoinDb: round(across(struck), 1),
    brightOpen: round(brightness(at(16)), 0),
    brightRest: round(brightness(at(0)), 0),
    brightShut: round(brightness(at(48)), 0),
    peak: round(peak(accent)),
  });
  assert.ok(m.below80 < 0.03 && m.band100to5k > 0.88, JSON.stringify(m));
  assert.ok(m.ringSeconds < 2 * sixteenth, `tight sixteenth: ${m.ringSeconds} s`);
  assert.ok(m.brightStrike > 1.7 * m.brightHeld, `filter closes inside a note: ${m.brightStrike} to ${m.brightHeld} Hz`);
  assert.ok(m.accentBrightness > 1.3 && m.accentDb > 0, `accent barks: ${m.accentBrightness}x, ${m.accentDb} dB`);
  assert.ok(m.tiedAcrossJoinDb < 1 && m.struckAcrossJoinDb > m.tiedAcrossJoinDb + 1.5, `tied slide has no re-attack: ${m.tiedAcrossJoinDb} vs ${m.struckAcrossJoinDb} dB`);
  assert.ok(m.brightOpen > 1.5 * m.brightRest && m.brightRest > 1.5 * m.brightShut, `16-bar sweep: ${m.brightShut}, ${m.brightRest}, ${m.brightOpen} Hz`);
  assert.ok(m.peak < 1);
});

test("hook, brass, organ, siren and pad: wah clav, pitch-scooped horn hit, fast rotary organ, gliding siren and formant pad", () => {
  const hookAt = (pos: number) => play("hook", "arp", [64], 0.25 * BEAT, 1, pos);
  const hookLeans = [0, 0.75, 1.5, 2.25].map((pos) => round(lean(hookAt(pos)), 1));
  const chord = [57, 64, 69];
  const brass = play("brass", "comp", chord, 0.4 * BEAT, 1.5);
  // Without the pitch scoop, to verify the onset scoop bends the attack.
  const unscoopedSound: SoundSet = {
    ...SOUND,
    patches: { ...SOUND.patches, brass_flat: { ...SOUND.patches!.brass!, scoop: 0 } },
  };
  const brassFlat = render(chord.map((key) => ({ t: 0.01, dur: 0.4 * BEAT, key, vel: 100, ch: 0, role: "comp" as Role, program: 62, patch: "brass_flat", beat: BEAT, pos: 0 })), 1.5, unscoopedSound);
  const scoopDiff = rms({ l: brass.l.slice(Math.round(0.01 * SR), Math.round(0.05 * SR)).map((x, i) => x - brassFlat.l[Math.round(0.01 * SR) + i]!), r: new Float32Array(Math.round(0.04 * SR)) });

  const organAt = (pos: number) => play("organ", "comp", [57, 62, 64, 67], 0.3 * BEAT, 1, pos);
  const organHeld = play("organ", "comp", [57, 62, 64, 67], 1.2 * BEAT, 2);
  const siren = play("siren", "lead", [76], 1.5 * BEAT, 2.5);
  const pad = play("pad", "pad", [57, 64, 69], 6, 12);
  const padAt = (pos: number) => cut(play("pad", "pad", [57, 64, 69], 4, 4.5, pos - 3 / BEAT), 2.5, 3.5);

  const m = (numbers.voices = {
    hookBelow200: round(share(hookAt(0), 0, 200), 4),
    hookBand300to5k: round(share(hookAt(0), 300, 5000), 3),
    hookWahHigh: round(brightness(cut(hookAt(1), 0.01, 0.12)), 0),
    hookWahLow: round(brightness(cut(hookAt(3), 0.01, 0.12)), 0),
    hookLeanSpreadDb: round(Math.max(...hookLeans) - Math.min(...hookLeans), 1),
    brassBelow150: round(share(brass, 0, 150), 4),
    brassBand180to5k: round(share(brass, 180, 5000), 3),
    brassRing: round(ringTime(brass), 3),
    brassCorrelation: round(correlation(brass)),
    brassScoopDiff: round(scoopDiff, 3),
    organRotarySpreadDb: round(Math.abs(lean(organAt(0.375)) - lean(organAt(1.125))), 1),
    organHeldDb: round(db(rms(cut(organHeld, 0.4, 0.55)) / rms(cut(organHeld, 0.02, 0.1))), 1),
    sirenBelow250: round(share(siren, 0, 250), 4),
    sirenCorrelation: round(correlation(siren)),
    padBelow150: round(share(cut(pad, 3, 6), 0, 150), 4),
    padAttackDb: round(db(rms(cut(pad, 0.01, 0.21)) / rms(cut(pad, 3, 6))), 1),
    padRelease: round(ringTime(cut(pad, 6, 12)), 2),
    padCorrelation: round(correlation(cut(pad, 3, 6))),
    padBrightHigh: round(brightness(padAt(8)), 0),
    padBrightLow: round(brightness(padAt(24)), 0),
  });
  assert.ok(m.hookBelow200 < 0.02 && m.hookBand300to5k > 0.88, JSON.stringify(m));
  assert.ok(m.hookWahHigh > 1.3 * m.hookWahLow && m.hookLeanSpreadDb > 3, `wah clav sweeps and pans: ${JSON.stringify(m)}`);
  assert.ok(m.brassBelow150 < 0.04 && m.brassBand180to5k > 0.88 && m.brassRing < 0.45, JSON.stringify(m));
  assert.ok(m.brassCorrelation > 0.2 && m.brassCorrelation < 0.98 && m.brassScoopDiff > 0.02, `stereo pitch-scooped brass: ${JSON.stringify(m)}`);
  assert.ok(m.organRotarySpreadDb > 3 && m.organHeldDb > -6, `rotary organ spins and holds: ${JSON.stringify(m)}`);
  assert.ok(m.sirenBelow250 < 0.03 && m.sirenCorrelation > 0.15 && m.sirenCorrelation < 0.98, JSON.stringify(m));
  assert.ok(m.padBelow150 < 0.02 && m.padAttackDb < -10 && m.padRelease > 0.7, JSON.stringify(m));
  assert.ok(m.padCorrelation > 0.1 && m.padCorrelation < 0.92 && m.padBrightHigh > 1.4 * m.padBrightLow, JSON.stringify(m));
  for (const [name, s] of [["hook", hookAt(0)], ["brass", brass], ["organ", organHeld], ["siren", siren], ["pad", pad]] as const) {
    assert.ok(peak(s) < 1, `${name}: peak ${peak(s).toFixed(2)}`);
  }
  console.log("measured:", JSON.stringify(numbers, null, 1));
});

// --- A whole track through the worker --------------------------------------------

const WSR = 24000;
const FLOOR = 0.5;
const scope: { onmessage: ((e: { data: ToWorker }) => void) | null } = { onmessage: null };
(globalThis as unknown as { self: typeof scope }).self = scope;
await import("./worker.js");
let posted: ToStems[] = [];
let cleared: (() => void) | null = null;
const port = {
  postMessage(msg: ToStems) {
    if (msg.type === "clear") cleared?.();
    else posted.push(msg);
  },
};
const send = (data: ToWorker) => scope.onmessage!({ data });
send({ type: "init", sampleRate: WSR, port } as unknown as ToWorker);

async function run(style: StyleBundle, bars: Bar[]): Promise<{ roles: Map<Role, Stereo>; mix: Stereo; frames: number }> {
  posted = [];
  const parts = partLevels(style.corpus);
  const levels = Object.fromEntries(style.corpus.instruments.map((i) => [i.role, i.volume])) as Partial<Record<Role, number>>;
  const sound = styleSound(style.corpus);
  const programs = new Map<number, number>();
  const patches = new Map<number | string, string>();
  let start = 0;
  let frames = 0;
  for (const bar of bars) {
    frames = Math.round(((bar.beats * 60) / bar.bpm) * WSR);
    const notes = barScore(bar, programs, { legato: true, gestures: true, patches }).map((n) => ({ ...n, t: n.t + start / WSR }));
    const moves = stemMoves(bar);
    send({
      type: "bar",
      engine: "synth",
      start,
      frames,
      styleId: style.id,
      newPiece: bar.info.barInPiece === 0,
      levels,
      ...(parts && { partLevels: parts }),
      notes,
      mix: { intensity: bar.info.intensity, lean: velocityScale(bar.info.intensity, FLOOR) },
      touch: true,
      ...(sound && { sound }),
      ...(moves && { moves }),
    });
    start += frames;
  }
  await new Promise<void>((resolve) => {
    cleared = resolve;
    send({ type: "clear", from: start });
  });
  const pcm = posted.filter((m) => m.type === "pcm");
  const total = pcm.reduce((a, m) => a + m.frames, 0);
  const roles = new Map<Role, Stereo>();
  const mix = stereo(total);
  let at = 0;
  for (const m of pcm) {
    m.roles.forEach((r, i) => {
      const role = ROLES[r]!;
      const s = roles.get(role) ?? stereo(total);
      roles.set(role, s);
      s.l.set(m.data[2 * i]!, at);
      s.r.set(m.data[2 * i + 1]!, at);
      for (let k = 0; k < m.frames; k++) {
        mix.l[at + k]! += m.data[2 * i]![k]!;
        mix.r[at + k]! += m.data[2 * i + 1]![k]!;
      }
    });
    at += m.frames;
  }
  return { roles, mix, frames };
}

function track(style: StyleBundle, seed: string): Bar[] {
  const opts: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: FLOOR } };
  const piece = new SetConductor([style], seed, opts).trackPiece(0);
  return Array.from({ length: piece.totalBars }, (_, b) => piece.renderBar(b, b));
}

test("a whole track through the worker: near the other styles' level, mono and even low end, stutters audible, nothing clipping", async () => {
  const bars = ["big-worker", "big-worker-b", "big-worker-c", "big-worker-d", "big-worker-e", "big-worker-f"]
    .map((seed) => track(BIG, seed))
    .find((t) => t.filter((b) => b.info.parts!.includes("acid")).length >= 24 && t.some((b) => b.moves?.some((m) => m.target === "stutter")))!;
  assert.ok(bars, "found a track with acid and stutters");
  const t0 = performance.now();
  const mine = await run(BIG, bars);
  const ms = (performance.now() - t0) / bars.length;
  const others = [];
  for (const s of [MINIMAL, BERLIN, PSY]) {
    const theirBars = track(s, "big-worker");
    others.push({ style: s, bars: theirBars, heard: await run(s, theirBars) });
  }
  const body = (r: { mix: Stereo; frames: number }, n: number): Stereo => ({ l: r.mix.l.slice(16 * r.frames, (n - 16) * r.frames), r: r.mix.r.slice(16 * r.frames, (n - 16) * r.frames) });
  const m = measureWeight(body(mine, bars.length), WSR);
  const was = others.map((o) => measureWeight(body(o.heard, o.bars.length), WSR));
  const line = (x: typeof m) => `rms ${db(x.rms).toFixed(1)} dB, crest ${x.crest.toFixed(1)} dB, range ${x.range.toFixed(1)} dB, sub ${(x.sub * 100).toFixed(0)}%, low-mid ${(x.lowMid * 100).toFixed(0)}%, low corr ${x.lowCorrelation.toFixed(2)}`;
  const top = peak(mine.mix);
  const on = bars.reduce((a, b) => a + b.info.parts!.length, 0) / bars.length;
  const loudest = (r: typeof mine, list: Bar[]) =>
    [...r.roles].map(([role, s]) => `${role} ${db(Math.max(...list.map((b, i) => (b.info.build ? 0 : rms(s, i * r.frames, (i + 1) * r.frames))))).toFixed(1)} dB`).join(", ");
  const lowOf = (r: typeof mine, list: Bar[]) => {
    const levels: number[] = [];
    list.forEach((b, i) => {
      if (b.info.build || !b.info.parts!.includes("kick") || !b.info.parts!.includes("fuzz") || i < 16 || i >= list.length - 16) return;
      const c: Stereo = { l: r.mix.l.slice(i * r.frames, (i + 1) * r.frames), r: r.mix.r.slice(i * r.frames, (i + 1) * r.frames) };
      levels.push(db(rms(c) * Math.sqrt(measureWeight(c, WSR).sub + measureWeight(c, WSR).lowMid * 0.3)));
    });
    levels.sort((x, y) => x - y);
    return { median: levels[levels.length >> 1]!, spread: levels[Math.floor(levels.length * 0.95)]! - levels[Math.floor(levels.length * 0.05)]! };
  };
  const low = lowOf(mine, bars);
  const stutters = bars.filter((b) => b.moves?.some((mv) => mv.target === "stutter")).length;
  const slides = bars.reduce((a, b) => a + b.notes.filter((n) => n.part === "acid" && n.gesture === "slide").length, 0);
  console.log(
    `one track through the worker (weighted mix, synth, ${WSR} Hz):\n` +
      `  big_beat          ${line(m)} (${bars.length} bars at ${bars[0]!.bpm} bpm, ${on.toFixed(1)} parts in on average, peak ${top.toFixed(2)}, ${stutters} stutters, ${slides} acid slides)\n` +
      others.map((o, i) => `  ${o.style.id.padEnd(17)} ${line(was[i]!)} (${o.bars.length} bars at ${o.bars[0]!.bpm} bpm, peak ${peak(o.heard.mix).toFixed(2)})\n`).join("") +
      `  loudest bar per role: ${loudest(mine, bars)}\n` +
      `  low end in bars with kick and fuzz: median ${low.median.toFixed(1)} dB, 5th to 95th percentile ${low.spread.toFixed(1)} dB apart\n` +
      `  render time ${ms.toFixed(0)} ms per bar (a bar is ${((mine.frames / WSR) * 1000).toFixed(0)} ms)`,
  );
  for (const s of [mine.mix, ...mine.roles.values()]) for (let i = 0; i < s.l.length; i++) assert.ok(Number.isFinite(s.l[i]) && Number.isFinite(s.r[i]));
  const quietest = Math.min(...bars.map((_, i) => rms(mine.mix, i * mine.frames, (i + 1) * mine.frames)));
  assert.ok(db(quietest) > -55, `the quietest bar: ${db(quietest).toFixed(1)} dB`);
  for (const [i, w] of was.entries()) assert.ok(Math.abs(db(m.rms / w.rms)) < 3, `level: ${db(m.rms / w.rms).toFixed(1)} dB against ${others[i]!.style.id}`);
  assert.ok(m.sub > 0.25 && m.sub < was[1]!.sub, `sub share ${m.sub.toFixed(2)} against Berlin techno's ${was[1]!.sub.toFixed(2)}`);
  assert.ok(low.spread < 6, `the low end is even from bar to bar: ${low.spread.toFixed(1)} dB`);
  assert.ok(m.lowCorrelation > 0.95, `the low end is mono: ${m.lowCorrelation}`);
  assert.ok(top < 1 && top < Math.max(...others.map((o) => peak(o.heard.mix))) * 1.5, `peak ${top}`);
  assert.ok(stutters >= 1 && slides >= 15);
  assert.ok(ms < ((mine.frames / WSR) * 1000) / 4, `${ms} ms per bar`);
});
