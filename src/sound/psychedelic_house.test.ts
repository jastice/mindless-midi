/**
 * Psychedelic house, Claudia's third style: the corpus is valid, its sounds
 * measure as what they are meant to be, a set travels between all three
 * styles within the set's rules, and a whole track through the worker mixes
 * near the technos' level with a rounder low end.
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
import { type ModeName, keysCompatible, pitchClass } from "../theory/theory.js";
import { type Stereo, StemWindow, stereo } from "./dsp.js";
import { lowCorrelation, measureWeight } from "./measure.js";
import { stemMoves } from "./moves.js";
import type { ToStems, ToWorker } from "./protocol.js";
import { barScore } from "./score.js";
import { partLevels, styleSound } from "./sound_set.js";
import { type SoundSet, renderSynthNote } from "./synth.js";
import type { ScoreNote } from "./types.js";

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const PSY = claudia.find((s) => s.id === "psychedelic_house")!;
const MINIMAL = claudia.find((s) => s.id === "minimal_techno")!;
const BERLIN = claudia.find((s) => s.id === "berlin_techno")!;
const corpus = PSY.corpus;
const SOUND = styleSound(corpus)!;
const KIT = corpus.synthKit!;
const ID = "psychedelic_house";

const SR = 48000;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const round = (x: number, digits = 2) => Number(x.toFixed(digits));
const numbers: Record<string, Record<string, number>> = {};
const EXPRESSION: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: 0.5 } };

// --- The corpus --------------------------------------------------------------

test("the corpus is valid with no warnings, and is a Claudia style: parts, groups, a cap, moves, patches, a kit", () => {
  const v = validateCorpus(JSON.parse(readFileSync("styles/psychedelic_house/corpus.json", "utf8")));
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  assert.deepEqual(v.warnings, []);
  const parts = corpus.parts!;
  assert.ok(parts.length >= 10 && parts.length <= 15, `${parts.length} parts`);
  assert.ok(parts.some((p) => p.roll) && corpus.moves?.build === 1, "a build with a roll before every drop");
  assert.ok(corpus.moves!.long >= 0.8, "and most builds are the long kind");
  // Limits from the start: a cap under minimal techno's, and only two noise layers to choose from.
  const a = corpus.arrangement!;
  assert.ok(a.most! < MINIMAL.corpus.arrangement!.most! && a.groups!.line! <= 3 && a.groups!.perc! <= 2);
  assert.equal(parts.filter((p) => p.group === "noise").length, 2);
  for (const p of parts) if (p.role !== "drums" && p.role !== "bass" && p.role !== "pad") assert.equal(p.group, "line", p.id);
  // Every part but the drums plays a patch of the style's own, and none is one of the technos'.
  for (const p of parts) if (p.role !== "drums") assert.ok(corpus.patches!.some((x) => x.id === p.patch), p.id);
  for (const other of [MINIMAL, BERLIN]) {
    for (const p of corpus.patches!) for (const q of other.corpus.patches!) assert.notDeepEqual({ ...p, id: "" }, { ...q, id: "" }, `${p.id} is ${other.id}'s ${q.id}`);
    assert.notDeepEqual(KIT, other.corpus.synthKit);
  }
  assert.ok(!KIT.rumble && KIT.kick.sub && KIT.perc!.filter((p) => p.tuned).length >= 2, "no rumble; tuned hand percussion");
  // Long sections, a breakdown without the low end, a peak; every form long enough to play once through.
  for (const f of corpus.forms) {
    assert.ok(f.sections.every((s) => s.bars === 16 || s.bars === 32), f.id);
    assert.ok(f.sections.some((s) => !s.roles.includes("bass")), `${f.id} has a breakdown`);
    assert.ok(f.sections.some((s) => s.intensity >= 0.85), `${f.id} has a peak`);
    assert.ok(f.sections.reduce((n, s) => n + s.bars, 0) >= 112, f.id);
    // The mix zones are the low end alone.
    assert.deepEqual([f.sections[0]!.bars, f.sections.at(-1)!.bars], [16, 16], f.id);
  }
});

test("the lines: an off-beat bass, an acid line of ties and accents, and a pluck that is safe over another track", () => {
  // The bass answers the kick: no note on a beat.
  const bass = corpus.motifs.filter((m) => m.role === "bass");
  assert.ok(bass.length >= 6);
  for (const m of bass) for (const n of m.notes) assert.ok(Math.abs(n.t - Math.round(n.t)) > 0.2, `${m.id}: a note on beat ${n.t}`);
  // The acid patch slides and accents; every figure has both, and every slid note starts where the one before ends, so it is tied.
  const patch = corpus.patches!.find((p) => p.id === "acid")!;
  assert.ok(patch.glide !== undefined && patch.accent !== undefined && patch.filter.q >= 6 && patch.osc.voices === 1);
  const acid = corpus.motifs.filter((m) => m.material === "acid");
  assert.ok(acid.length >= 4);
  for (const m of acid) {
    assert.ok(m.notes.some((n) => n.g === "accent") && m.notes.some((n) => n.g === "slide"), m.id);
    m.notes.forEach((n, i) => {
      if (n.g !== "slide") return;
      const before = m.notes[i - 1]!;
      assert.ok(Math.abs(before.t + before.d - n.t) < 1e-9 && n.d >= 0.25 && before.d >= 0.2, `${m.id}: the slide at ${n.t} touches the note before`);
    });
    assert.ok(m.notes.length / (m.lengthBeats / 4) <= 9, `${m.id}: at most nine notes a bar`);
  }
  // Over another track the set plays a deck's coolest running line: that is the pluck, not the acid line,
  // and the pluck keeps to the tonic, fourth, fifth and octave, which every compatible key shares.
  const running = corpus.parts!.filter((p) => p.role === "arp").sort((x, y) => (x.enters ?? 0) - (y.enters ?? 0));
  assert.deepEqual(running.map((p) => p.id), ["pluck", "acid"]);
  const pluck = corpus.motifs.filter((m) => m.material === "pluck");
  for (const m of pluck) {
    assert.equal(m.anchor, "key", m.id);
    for (const n of m.notes) assert.ok([0, 3, 4, 7].includes(n.deg), `${m.id}: degree ${n.deg}`);
    assert.ok(m.notes.length / (m.lengthBeats / 4) <= 2, `${m.id}: sparse`);
  }
  // No chord has a third of its own that one of the three modes lacks: the same progressions serve all of them.
  const symbols = new Set(corpus.progressions.flatMap((p) => p.chords.map((c) => c.symbol)));
  assert.deepEqual([...symbols].sort(), ["Isus2", "bVII", "bVII5", "i5", "i7sus4", "i9sus4", "v7"]);
});

test("tempo and keys: a step under minimal techno, and keys near each other and near both technos'", () => {
  assert.deepEqual(corpus.tempo, { min: 118, max: 126 });
  assert.equal(corpus.beatsPerBar, 4);
  assert.ok(corpus.swing > 0 && corpus.swing <= 0.25 && corpus.swingUnit === "16th", "a little swing: under 11 ms on a sixteenth");
  // One 3% step from the upper half of the range reaches minimal techno's.
  assert.ok(Math.floor(123 * (1 + MAX_TEMPO_STEP)) >= MINIMAL.corpus.tempo.min && corpus.tempo.max >= MINIMAL.corpus.tempo.min);
  const key = (k: { tonic: string; mode: string }) => ({ tonic: pitchClass(k.tonic), mode: k.mode as ModeName });
  const mine = corpus.keys.map(key);
  assert.deepEqual([...new Set(corpus.keys.map((k) => k.mode))].sort(), ["aeolian", "dorian", "mixolydian"]);
  for (const k of mine) assert.ok(mine.filter((o) => keysCompatible(k, o)).length >= 6, `${JSON.stringify(k)} has neighbours of its own`);
  for (const other of [MINIMAL, BERLIN]) {
    const theirs = other.corpus.keys.map(key);
    // Every key here has one of theirs to go to, and nearly every one of theirs has one here.
    for (const k of mine) assert.ok(theirs.some((o) => keysCompatible(k, o)), `${other.id}: from ${JSON.stringify(k)}`);
    const reached = theirs.filter((k) => mine.some((o) => keysCompatible(k, o))).length;
    assert.ok(reached >= theirs.length - 2, `${other.id}: ${reached} of ${theirs.length} keys have one here`);
  }
});

// --- A set over all three styles -------------------------------------------------

test("a set over all three styles: each plays, none is stuck, every change keeps tempo and key, every pair overlaps, the limits hold", () => {
  const { most, groups } = corpus.arrangement!;
  const groupOf = new Map(corpus.parts!.map((p) => [p.id, p.group]));
  type Track = { style: string; bpm: number; key: { tonic: number; mode: ModeName } };
  const count: Record<string, number> = {};
  const tempos: Record<string, number[]> = {};
  const overlaps: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const seen = new Set<string>();
  const links: Record<string, string> = {};
  const link = (what: string, seed: string, track: number, bar: number) => (links[what] ??= `?seed=${seed}&at=${track + 1}.${bar + 1}`);
  let fullest = 0;
  let builds = 0;
  let long = 0;
  let drifts = 0;
  let alone = 0;
  let withAcid = 0;
  let under = 0;
  let acidUnder = 0;
  let pluckUnder = 0;
  let longestWait = 0;
  const SEEDS = ["psy-a", "psy-b", "psy-c", "psy-d"];
  const BARS = 5000;
  for (const seed of SEEDS) {
    const c = new SetConductor(claudia, seed, EXPRESSION);
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
        for (const st of claudia) {
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
      for (const d of s.decks) {
        const b = d.bar.info;
        if (b.styleId !== ID) continue;
        const on = b.parts!;
        for (const id of on) seen.add(id);
        if (s.decks.length === 2) {
          // The deck without the low end plays one running line: mostly the pluck.
          if (d.deck !== s.dominant) {
            under++;
            if (on.includes("acid")) acidUnder++;
            if (on.includes("pluck")) pluckUnder++;
            assert.ok(!(on.includes("acid") && on.includes("pluck")) && !on.includes("sub"), `${seed} bar ${i}: ${on}`);
          }
          continue;
        }
        alone++;
        fullest = Math.max(fullest, on.length);
        assert.ok(on.length <= most!, `${seed} bar ${i}: ${on.length} parts: ${on}`);
        for (const [group, limit] of Object.entries(groups!)) assert.ok(on.filter((id) => groupOf.get(id) === group).length <= limit, `${seed} bar ${i}: ${group}: ${on}`);
        // The kick is out only in a build, or in a breakdown, where the bass is out too.
        if (!on.includes("kick")) assert.ok(b.build !== undefined || !on.includes("sub"), `${seed} bar ${i}: ${on}`);
        if (b.build?.bar === 0) {
          builds++;
          if (b.build.bars === 8) long++;
          assert.ok(!on.includes("kick") && on.includes("roll"), "a build: kick out, roll in");
          link("four bars before a build into a drop", seed, b.pieceIndex, b.barInPiece - 4);
        }
        const drift = d.bar.moves?.find((m) => m.target === "patch" && m.scope !== "master" && m.scope.part === "acid");
        if (drift?.span?.bar === 0) drifts++;
        if (on.includes("acid")) {
          withAcid++;
          if (b.intensity >= 0.8 && drift && drift.span!.bar >= 4 && b.barInSection % 8 === 0 && on.includes("kick")) link("the acid line in full flight, its cutoff drifting", seed, b.pieceIndex, b.barInPiece);
        }
      }
    }
  }
  const total = Object.values(count).reduce((x, y) => x + y, 0);
  const span = (ts: number[]) => `${Math.min(...ts)} to ${Math.max(...ts)} bpm`;
  const mine = tempos[ID]!;
  console.log(
    `a set over all three styles, ${SEEDS.length} seeds of ${BARS} bars, ${total} tracks:\n` +
      claudia.map((s) => `  ${s.id}: ${count[s.id]} tracks (${span(tempos[s.id]!)})`).join("\n") +
      `\n  psychedelic house in its own range (118 to 126) ${mine.filter((x) => x <= 126).length} times of ${mine.length}; median ${mine.slice().sort((x, y) => x - y)[mine.length >> 1]} bpm` +
      `\n  overlaps: ${Object.entries(overlaps).map(([k, n]) => `${k} ${n}`).join(", ")}` +
      `\n  kinds: ${JSON.stringify(kinds)}; the longest any style waits: ${longestWait} tracks` +
      `\n  psychedelic house alone: parts in at most ${fullest}; the acid line in ${Math.round((100 * withAcid) / alone)}% of bars; ${builds} builds (${long} of 8 bars); ${drifts} drifts of the acid line's cutoff` +
      `\n  as the deck without the low end, ${under} bars: the pluck plays in ${pluckUnder}, the acid line in ${acidUnder}` +
      `\n  links:\n${Object.entries(links).map(([k, l]) => `    ${k}: ${l}`).join("\n")}`,
  );
  for (const s of claudia) assert.ok(count[s.id]! >= total / 5, `${s.id} plays: ${count[s.id]} of ${total}`);
  // A leg heads for one end of the tempo span, and the style at the other end waits; it comes back.
  assert.ok(longestWait <= 16, `no style is away for more than 16 tracks: ${longestWait}`);
  for (const x of claudia) for (const y of claudia) if (x !== y) assert.ok((overlaps[`${x.id} > ${y.id}`] ?? 0) >= 3, `${x.id} into ${y.id} overlap: ${overlaps[`${x.id} > ${y.id}`]}`);
  assert.ok(Math.min(...mine) <= 123 && mine.filter((x) => x <= 126).length >= mine.length / 3, "it plays in its own range too");
  assert.equal(fullest, most, "the cap is reached somewhere");
  assert.ok(builds >= count[ID]! / 2 && long > builds / 2, "most tracks have a build, most of them long");
  assert.ok(drifts >= count[ID]! / 3, `the acid line's cutoff drifts: ${drifts} times in ${count[ID]} tracks`);
  assert.ok(acidUnder < under / 4 && pluckUnder > under / 2, "over another track's low end it is the pluck, seldom the acid line");
  assert.deepEqual([...seen].sort(), corpus.parts!.map((p) => p.id).sort(), "every part is heard");
  assert.equal(Object.keys(links).length, 7, `links: ${Object.keys(links)}`);
});

// --- The sounds, measured ------------------------------------------------------

const cut = (s: Stereo, from: number, to: number): Stereo => ({ l: s.l.slice(Math.round(from * SR), Math.round(to * SR)), r: s.r.slice(Math.round(from * SR), Math.round(to * SR)) });
const rms = (s: Stereo, from = 0, to = s.l.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return Math.sqrt(e / (2 * Math.max(1, to - from)));
};
const peak = (s: Stereo) => s.l.reduce((m, x, i) => Math.max(m, Math.abs(x), Math.abs(s.r[i]!)), 0);
const minus = (a: Stereo, b: Stereo): Stereo => ({ l: a.l.map((x, i) => x - b.l[i]!), r: a.r.map((x, i) => x - b.r[i]!) });

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

/** How far the sound sits to the left (positive) or right, dB. */
const lean = (s: Stereo) => db(rms({ l: s.l, r: s.l }) / rms({ l: s.r, r: s.r }));

const drumNote = (t: number, key: number, more: Partial<ScoreNote> = {}): ScoreNote => ({ t, dur: 0.1, key, vel: 110, ch: 9, role: "drums", program: 0, ...more });

function render(notes: ScoreNote[], seconds: number, sound: SoundSet = SOUND): Stereo {
  const out = stereo(Math.round(seconds * SR));
  notes.forEach((n, i) => renderSynthNote(out, n, SR, "none", notes[i - 1], false, sound));
  return out;
}

/** A patch as its part plays it, at 122 BPM: `pos` is where in the track the note starts, in beats. */
const BEAT = 60 / 122;
function play(patch: string, role: Role, keys: number[], dur: number, seconds: number, pos = 0): Stereo {
  return render(keys.map((key) => ({ t: 0.01, dur, key, vel: 100, ch: 0, role, program: 90, patch, beat: BEAT, pos })), seconds);
}


const kitOf = (s: StyleBundle): SoundSet => {
  const { rumble: _, ...dry } = s.corpus.synthKit!;
  return { kit: dry };
};

test("kick: round, nearly all of it under 80 Hz, less click than either techno's, and gone before the next one", () => {
  const kick = render([drumNote(0, 36)], 1.5);
  const others = [MINIMAL, BERLIN].map((s) => render([drumNote(0, 36)], 1.5, kitOf(s)));
  const m = (numbers.kick = {
    below80: round(share(kick, 0, 80)),
    below120: round(share(kick, 0, 120)),
    above1k: round(share(kick, 1000, Infinity), 5),
    minimalAbove1k: round(share(others[0]!, 1000, Infinity), 5),
    berlinAbove1k: round(share(others[1]!, 1000, Infinity), 5),
    // How bright the strike is: the first 10 ms.
    strikeBrightness: round(brightness(cut(kick, 0, 0.01)), 0),
    minimalStrikeBrightness: round(brightness(cut(others[0]!, 0, 0.01)), 0),
    berlinStrikeBrightness: round(brightness(cut(others[1]!, 0, 0.01)), 0),
    ringSeconds: round(ringTime(kick)),
    peak: round(peak(kick)),
  });
  assert.ok(m.below80 > 0.85 && m.below120 > 0.95, JSON.stringify(m));
  assert.ok(m.above1k < m.minimalAbove1k / 2 && m.above1k < m.berlinAbove1k / 2, "less click than the technos");
  assert.ok(m.strikeBrightness < m.minimalStrikeBrightness && m.strikeBrightness < m.berlinStrikeBrightness, "a duller strike");
  assert.ok(m.ringSeconds > 0.15 && m.ringSeconds < 60 / 126, `full, and gone by the next kick at 126 BPM: ${m.ringSeconds} s`);
  assert.ok(m.peak < 1);
  assert.deepEqual(kick.l, kick.r);
});

test("the rest of the kit: soft hats above 6 kHz, a roomy clap, congas and a bongo on the key, a shaker", () => {
  const one = (key: number, seconds: number, more: Partial<ScoreNote> = {}) => render([drumNote(0.01, key, more)], seconds);
  const closed = one(42, 0.6);
  const open = one(46, 1.5);
  const clap = one(39, 1.5);
  const low = one(45, 1);
  const high = one(50, 1);
  const bongo = one(37, 0.6);
  const shaker = one(70, 0.6);
  const m = (numbers.kit = {
    hatAbove6k: round(share(closed, 6000, Infinity), 3),
    hatBelow3k: round(share(closed, 0, 3000), 5),
    hatRing: round(ringTime(closed), 3),
    openRing: round(ringTime(open), 3),
    clapBand: round(share(clap, 500, 3000)),
    clapRing: round(ringTime(clap)),
    congaLowOn220: round(share(cut(low, 0.05, 0.4), 196, 247)),
    congaHighOn330: round(share(cut(high, 0.05, 0.4), 294, 370)),
    bongoOn660: round(share(cut(bongo, 0.03, 0.3), 588, 741)),
    congaRing: round(ringTime(low), 3),
    congaBelow100: round(share(low, 0, 100), 4),
    shakerAbove4k: round(share(shaker, 4000, Infinity)),
    shakerRing: round(ringTime(shaker), 3),
  });
  assert.ok(m.hatAbove6k > 0.9 && m.hatBelow3k < 0.001 && m.hatRing <= 0.06, JSON.stringify(m));
  assert.ok(m.openRing > 3 * m.hatRing && m.openRing < 60 / 126, `open hat: ${m.openRing} s`);
  assert.ok(m.clapBand > 0.8 && m.clapRing > 0.2 && m.clapRing < 60 / 126, JSON.stringify(m));
  assert.ok(m.congaLowOn220 > 0.85 && m.congaHighOn330 > 0.85 && m.bongoOn660 > 0.7, `the congas are the root and the fifth of a track on A, the bongo the fifth above: ${JSON.stringify(m)}`);
  assert.ok(m.congaRing < 0.3 && m.congaBelow100 < 0.01, "short, and out of the low end");
  assert.ok(m.shakerAbove4k > 0.8 && m.shakerRing < 0.12, JSON.stringify(m));
  // On D the low conga is a fourth up, at 294 Hz; on E a fourth down, at 165 Hz.
  assert.ok(share(cut(one(45, 1, { tonic: 2 }), 0.05, 0.4), 262, 330) > 0.85);
  assert.ok(share(cut(one(45, 1, { tonic: 4 }), 0.05, 0.4), 147, 185) > 0.85);
  for (const s of [closed, open, clap, low, high, bongo, shaker]) assert.ok(peak(s) < 1);
});

test("bass: a round mono donk in the octave above the kick, short enough to stay off the beat", () => {
  // The bass part's roots lie from B1 (62 Hz) to A2 (110 Hz).
  const m: Record<string, number> = (numbers.bass = {});
  for (const key of [35, 40, 45]) {
    const hz = 440 * Math.pow(2, (key - 69) / 12);
    const note = play("bass", "bass", [key], 0.3 * BEAT, 1.5);
    assert.deepEqual(note.l, note.r);
    m[`fundamental${key}`] = round(share(note, hz / 1.3, hz * 1.3));
    assert.ok(m[`fundamental${key}`]! > 0.6, `key ${key}: ${m[`fundamental${key}`]}`);
  }
  const note = play("bass", "bass", [40], 0.3 * BEAT, 1.5);
  m.below60 = round(share(note, 0, 60), 3);
  m.above400 = round(share(note, 400, Infinity), 4);
  m.ringSeconds = round(ringTime(note), 3);
  m.peak = round(peak(note));
  // The attack has more above the fundamental than the tail: the FM falls away, which is the "donk".
  m.attackBrightness = round(brightness(cut(note, 0.012, 0.04)), 0);
  m.tailBrightness = round(brightness(cut(note, 0.1, 0.18)), 0);
  assert.ok(m.below60 < 0.2 && m.above400 < 0.05, JSON.stringify(m));
  assert.ok(m.attackBrightness > 1.3 * m.tailBrightness, `it mellows: ${m.attackBrightness} Hz to ${m.tailBrightness} Hz`);
  assert.ok(m.ringSeconds < 0.5 * BEAT, `written on the off-beat for 0.3 of a beat, it is gone before the next kick: ${m.ringSeconds} s of ${round(0.5 * BEAT, 3)}`);
  assert.ok(m.peak < 1);
});

test("kick and bass share the low end by taking turns: the bass sounds between the kicks, and neither masks the other", () => {
  // Two bars at 122 BPM as the parts write them: kick on every beat, bass on every off-beat (E1, the middle of its range).
  const notes: ScoreNote[] = [];
  for (let i = 0; i < 8; i++) {
    notes.push(drumNote(i * BEAT, 36));
    notes.push({ t: (i + 0.5) * BEAT, dur: 0.3 * BEAT, key: 40, vel: 100, ch: 1, role: "bass", program: 38, patch: "bass", beat: BEAT, pos: i + 0.5 });
  }
  const kicks = render(notes.filter((n) => n.role === "drums"), 8 * BEAT);
  const bass = render(notes.filter((n) => n.role === "bass"), 8 * BEAT);
  const low = (s: Stereo, from: number, to: number) => {
    const c = cut(s, from * BEAT, to * BEAT);
    return rms(c) * Math.sqrt(share(c, 0, 150));
  };
  const m: Record<string, number> = (numbers.lowEnd = {});
  // Per half beat of the second bar: who has the low end, and by how much.
  const onBeat: number[] = [];
  const offBeat: number[] = [];
  for (let b = 4; b < 8; b++) {
    onBeat.push(db(low(kicks, b, b + 0.25) / Math.max(low(bass, b, b + 0.25), 1e-9)));
    offBeat.push(db(low(bass, b + 0.5, b + 0.8) / Math.max(low(kicks, b + 0.5, b + 0.8), 1e-9)));
  }
  m.kickOverBassOnTheBeatDb = round(Math.min(...onBeat), 1);
  m.bassOverKickOffTheBeatDb = round(Math.min(...offBeat), 1);
  m.bassAgainstKickDb = round(db(low(bass, 4.5, 4.8) / low(kicks, 4, 4.25)), 1);
  const both: Stereo = { l: kicks.l.map((x, i) => x + bass.l[i]!), r: kicks.r.map((x, i) => x + bass.r[i]!) };
  m.barBelow80 = round(share(cut(both, 4 * BEAT, 8 * BEAT), 0, 80));
  m.barBelow150 = round(share(cut(both, 4 * BEAT, 8 * BEAT), 0, 150));
  m.peak = round(peak(both));
  assert.ok(m.kickOverBassOnTheBeatDb > 15, `on the beat the kick is alone: ${onBeat.map((x) => x.toFixed(1))} dB over the bass`);
  assert.ok(m.bassOverKickOffTheBeatDb > 6, `off the beat the bass is over what is left of the kick: ${offBeat.map((x) => x.toFixed(1))} dB`);
  assert.ok(Math.abs(m.bassAgainstKickDb) < 6, `the two are of a size: ${m.bassAgainstKickDb} dB`);
  assert.ok(m.peak < 1, `together: ${m.peak}`);
});

/** An acid note as its part plays it (octave 3), with touch as the player has it. */
const acidNote = (t: number, dur: number, key: number, more: Partial<ScoreNote> = {}): ScoreNote => ({ t, dur, key, vel: 96, ch: 2, role: "arp", part: "acid", program: 80, patch: "acid", beat: BEAT, pos: t / BEAT, ...more });
function touched(notes: ScoreNote[], seconds: number): Stereo {
  const out = stereo(Math.round(seconds * SR));
  notes.forEach((n, i) => renderSynthNote(out, n, SR, "none", notes[i - 1], true, SOUND));
  return out;
}

test("acid: mono, resonant and above the bass; an accent barks, a slide is tied, and the cutoff travels over 24 bars", () => {
  const sixteenth = BEAT / 4;
  const plain = touched([acidNote(0.01, sixteenth, 45)], 1);
  const accent = touched([acidNote(0.01, sixteenth, 45, { gesture: "accent", vel: 110 })], 1);
  assert.deepEqual(plain.l, plain.r);
  // The filter's movement inside one note: bright at the strike, closed by the end of a held note.
  const held = touched([acidNote(0.01, 2 * BEAT, 45)], 2);
  // A tied pair against the same two notes struck: an accented A2, then E3 slid into.
  const slide = { gesture: "slide" as const, curves: { bend: [[0, -2], [0.06, 0]] as [number, number][] } };
  const first = () => acidNote(0.01, sixteenth, 45, { gesture: "accent", vel: 110 });
  const tied = touched([first(), acidNote(0.01 + sixteenth, 2 * sixteenth, 52, slide)], 1);
  const struck = touched([first(), acidNote(0.01 + sixteenth, 2 * sixteenth, 52)], 1);
  const join = 0.01 + sixteenth;
  const across = (s: Stereo) => db(rms(cut(s, join, join + 0.01)) / rms(cut(s, join - 0.01, join)));
  // The patch's own slow sweep, 96 beats long: widest open 24 beats in, most closed 72 beats in.
  const at = (pos: number) => cut(touched([acidNote(0.01, 2 * BEAT, 45, { pos })], 1), 0.3, 0.5);
  const m = (numbers.acid = {
    below100: round(share(plain, 0, 100), 3),
    band100to4k: round(share(plain, 100, 4000), 3),
    ringSeconds: round(ringTime(plain), 3),
    brightStrike: round(brightness(cut(held, 0.012, 0.04)), 0),
    brightHeld: round(brightness(cut(held, 0.4, 0.6)), 0),
    accentBrightness: round(brightness(cut(accent, 0.01, 0.1)) / brightness(cut(plain, 0.01, 0.1)), 2),
    accentDb: round(db(rms(cut(accent, 0.01, 0.15)) / rms(cut(plain, 0.01, 0.15))), 1),
    tiedAcrossJoinDb: round(across(tied), 1),
    struckAcrossJoinDb: round(across(struck), 1),
    tiedPeak: round(peak(tied)),
    struckPeak: round(peak(struck)),
    tiedPairDb: round(db(rms(cut(tied, 0.01, join + 2 * sixteenth))), 1),
    struckPairDb: round(db(rms(cut(struck, 0.01, join + 2 * sixteenth))), 1),
    tiedLength: round(ringTime(tied, 40), 3),
    struckLength: round(ringTime(struck, 40), 3),
    brightOpen: round(brightness(at(24)), 0),
    brightRest: round(brightness(at(0)), 0),
    brightShut: round(brightness(at(72)), 0),
    peak: round(peak(accent)),
  });
  assert.ok(m.below100 < 0.03 && m.band100to4k > 0.9, JSON.stringify(m));
  assert.ok(m.ringSeconds < 2 * sixteenth, `a sixteenth is over before the next but one: ${m.ringSeconds} s`);
  assert.ok(m.brightStrike > 1.8 * m.brightHeld, `the filter closes inside a note: ${m.brightStrike} Hz to ${m.brightHeld} Hz`);
  assert.ok(m.accentBrightness > 1.4 && m.accentDb > 0, `an accent barks: ${m.accentBrightness} times as bright, ${m.accentDb} dB`);
  assert.ok(m.tiedAcrossJoinDb < 1 && m.struckAcrossJoinDb > m.tiedAcrossJoinDb + 2, `no new attack on a tied note: ${m.tiedAcrossJoinDb} dB across the join, struck ${m.struckAcrossJoinDb} dB`);
  assert.ok(m.tiedPeak <= m.struckPeak, "and no bump where release and attack would overlap");
  assert.ok(m.brightOpen > 1.5 * m.brightRest && m.brightRest > 1.5 * m.brightShut, `the cutoff travels: ${m.brightShut}, ${m.brightRest}, ${m.brightOpen} Hz`);
  assert.ok(m.peak < 1);
});

test("a tied slide through a sliding window, as the worker renders it: the same samples as in one buffer", () => {
  const sixteenth = BEAT / 4;
  const slide = { gesture: "slide" as const, curves: { bend: [[0, -2], [0.06, 0]] as [number, number][] } };
  const notes = () => [acidNote(1, sixteenth, 45), acidNote(1 + sixteenth, sixteenth, 52, slide), acidNote(1 + 2 * sixteenth, 2 * sixteenth, 45, slide)];
  const whole = touched(notes(), 2);
  // The window has moved on by half a second when the notes arrive, and the last note comes after another take.
  const w = new StemWindow(0, 4 * SR);
  const got = stereo(2 * SR);
  const take = (frames: number) => {
    const s = w.take(frames);
    got.l.set(s.l, w.base - frames);
    got.r.set(s.r, w.base - frames);
  };
  take(SR / 2);
  const ns = notes();
  renderSynthNote(w, ns[0]!, SR, "none", undefined, true, SOUND);
  renderSynthNote(w, ns[1]!, SR, "none", ns[0], true, SOUND);
  take(Math.round((0.5 + 1.5 * sixteenth) * SR));
  renderSynthNote(w, ns[2]!, SR, "none", ns[1], true, SOUND);
  take(2 * SR - w.base);
  let worst = 0;
  for (let i = 0; i < whole.l.length; i++) worst = Math.max(worst, Math.abs(whole.l[i]! - got.l[i]!));
  assert.ok(peak(whole) > 0.05 && worst < 1e-6, `differs by ${worst}`);
});

test("pluck, organ and keys: a small wandering pluck, a hollow stab that holds, an electric piano that rings", () => {
  // The pluck sits in octave 5; the stabs voice a chord around middle C.
  const pluck = (pos: number) => play("pluck", "arp", [76], 0.2 * BEAT, 1.5, pos);
  const leans = [0, 0.75, 1.5, 2.25, 3, 3.75].map((pos) => round(lean(pluck(pos)), 1));
  const chord = [57, 62, 64, 67];
  const organ = play("organ", "comp", chord, 0.25 * BEAT, 2);
  const organHeld = play("organ", "comp", chord, 1.2 * BEAT, 2);
  const keys = play("keys", "comp", chord, 1.5 * BEAT, 4);
  const stabOf = (s: StyleBundle) => render(chord.map((key) => ({ t: 0.01, dur: 0.25 * BEAT, key, vel: 100, ch: 0, role: "comp" as Role, program: 90, patch: "stab", beat: BEAT, pos: 0 })), 2, styleSound(s.corpus)!);
  const m = (numbers.lines = {
    pluckBelow300: round(share(pluck(0), 0, 300), 4),
    pluckBand400to5k: round(share(pluck(0), 400, 5000), 3),
    pluckRing: round(ringTime(pluck(0)), 3),
    pluckLeanSpreadDb: round(Math.max(...leans) - Math.min(...leans), 1),
    pluckPeak: round(peak(pluck(0))),
    organBelow150: round(share(organ, 0, 150), 4),
    organBand150to3k: round(share(organ, 150, 3000), 3),
    organRing: round(ringTime(organ), 3),
    // A square's hollow tone: the second harmonic of the chord's lowest note against its third.
    organHeldDb: round(db(rms(cut(organHeld, 0.4, 0.55)) / rms(cut(organHeld, 0.02, 0.1))), 1),
    minimalStabHeldDb: round(db(rms(cut(stabOf(MINIMAL), 0.1, 0.12)) / rms(cut(stabOf(MINIMAL), 0.02, 0.04))), 1),
    organBrightness: round(brightness(cut(organ, 0.02, 0.12)), 0),
    minimalStabBrightness: round(brightness(cut(stabOf(MINIMAL), 0.02, 0.12)), 0),
    berlinStabBrightness: round(brightness(cut(stabOf(BERLIN), 0.02, 0.12)), 0),
    organCorrelation: round(correlation(organ)),
    organPeak: round(peak(organ)),
    keysBelow150: round(share(keys, 0, 150), 4),
    keysBand150to3k: round(share(keys, 150, 3000), 3),
    keysRing: round(ringTime(keys), 2),
    keysBrightStart: round(brightness(cut(keys, 0.012, 0.06)), 0),
    keysBrightTail: round(brightness(cut(keys, 0.5, 0.7)), 0),
    keysCorrelation: round(correlation(keys)),
    keysPeak: round(peak(keys)),
  });
  assert.ok(m.pluckBelow300 < 0.01 && m.pluckBand400to5k > 0.9 && m.pluckRing < 0.3, JSON.stringify(m));
  assert.ok(m.pluckLeanSpreadDb > 3, `the pluck lands somewhere else each time: ${leans} dB left`);
  assert.ok(m.organBelow150 < 0.03 && m.organBand150to3k > 0.9, JSON.stringify(m));
  assert.ok(m.organHeldDb > -6, `the organ holds a held chord: ${m.organHeldDb} dB after half a second`);
  assert.ok(m.organRing < 0.35, `and stops with the note: ${m.organRing} s`);
  assert.ok(m.organCorrelation > 0.2 && m.organCorrelation < 0.99 && m.keysCorrelation > 0.2 && m.keysCorrelation < 0.99, "stereo, not out of phase");
  assert.ok(m.keysBelow150 < 0.06 && m.keysBand150to3k > 0.9, JSON.stringify(m));
  assert.ok(m.keysRing > 0.5 && m.keysRing < 1.5 && m.keysBrightStart > 1.2 * m.keysBrightTail, `the keys ring and mellow: ${m.keysRing} s, ${m.keysBrightStart} Hz to ${m.keysBrightTail} Hz`);
  assert.ok(m.pluckPeak < 1 && m.organPeak < 1 && m.keysPeak < 1);
});

test("pad: slow, wide, out of the low end, and phasing over six bars", () => {
  // A close chord on A3 as the pad's patterns voice it.
  const keys = [57, 62, 64, 67];
  const at = (pos: number) => cut(play("pad", "pad", keys, 4, 4.5, pos - 3 / BEAT), 2.5, 3.5);
  const pad = play("pad", "pad", keys, 6, 12);
  const theirs = (s: StyleBundle, patch: string, shift: number) => render(keys.map((key) => ({ t: 0.01, dur: 6, key: key + shift, vel: 100, ch: 0, role: "pad" as Role, program: 89, patch, beat: BEAT, pos: 0 })), 12, styleSound(s.corpus)!);
  const m = (numbers.pad = {
    below150: round(share(cut(pad, 3, 6), 0, 150), 4),
    band200to3k: round(share(cut(pad, 3, 6), 200, 3000), 3),
    attackDb: round(db(rms(cut(pad, 0.01, 0.21)) / rms(cut(pad, 3, 6))), 1),
    releaseSeconds: round(ringTime(cut(pad, 6, 12)), 2),
    correlation: round(correlation(cut(pad, 3, 6))),
    brightness: round(brightness(cut(pad, 3, 6)), 0),
    minimalPadBrightness: round(brightness(cut(theirs(MINIMAL, "pad", 0), 3, 6)), 0),
    berlinDroneBrightness: round(brightness(cut(theirs(BERLIN, "drone", -12), 3, 6)), 0),
    // The band sweeps over 24 beats: highest 6 beats in, lowest 18 beats in.
    brightHigh: round(brightness(at(6)), 0),
    brightLow: round(brightness(at(18)), 0),
    peak: round(peak(pad)),
  });
  assert.ok(m.below150 < 0.02 && m.band200to3k > 0.85, JSON.stringify(m));
  assert.ok(m.attackDb < -10 && m.releaseSeconds > 0.8, `slow in and out: ${m.attackDb} dB, ${m.releaseSeconds} s`);
  assert.ok(m.correlation > 0.1 && m.correlation < 0.9, `wide, not out of phase: ${m.correlation}`);
  assert.ok(m.brightHigh > 1.6 * m.brightLow, `it phases: ${m.brightLow} Hz to ${m.brightHigh} Hz`);
  assert.ok(m.peak < 1);
  console.log("measured:", JSON.stringify(numbers, null, 1));
});

// --- A whole track through the worker --------------------------------------------

// The worker is a module worker: it listens on `self`. (As in worker.test.ts.)
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

/** Bars of a style through the worker (synth, weighted mix), as the player sends them; the stems per role and their sum. */
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

/** The first whole track of a set over one style, at a tempo both styles can play. */
function track(style: StyleBundle, seed: string): Bar[] {
  const opts: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: FLOOR } };
  // The track's own bars, at its own tempo: in the set its last bars overlap the next track's.
  const piece = new SetConductor([style], seed, opts).trackPiece(0);
  return Array.from({ length: piece.totalBars }, (_, b) => piece.renderBar(b, b));
}

test("a whole track through the worker: near the technos' level, a rounder low end than theirs, mono lows, nothing clipping", async () => {
  // The first of a few tracks in which the acid line plays for a good while (a set's first track is a cool one).
  const bars = ["psy-worker", "psy-worker-b", "psy-worker-c", "psy-worker-d", "psy-worker-e", "psy-worker-f"].map((seed) => track(PSY, seed)).find((t) => t.filter((b) => b.info.parts!.includes("acid")).length >= 32)!;
  const t0 = performance.now();
  const mine = await run(PSY, bars);
  const ms = (performance.now() - t0) / bars.length;
  const others = [];
  for (const s of [MINIMAL, BERLIN]) {
    const theirBars = track(s, "psy-worker");
    others.push({ style: s, bars: theirBars, heard: await run(s, theirBars) });
  }
  // Past the mix-in and before the mix-out.
  const body = (r: { mix: Stereo; frames: number }, n: number): Stereo => ({ l: r.mix.l.slice(16 * r.frames, (n - 16) * r.frames), r: r.mix.r.slice(16 * r.frames, (n - 16) * r.frames) });
  const m = measureWeight(body(mine, bars.length), WSR);
  const was = others.map((o) => measureWeight(body(o.heard, o.bars.length), WSR));
  const line = (x: typeof m) => `rms ${db(x.rms).toFixed(1)} dB, crest ${x.crest.toFixed(1)} dB, range ${x.range.toFixed(1)} dB, sub ${(x.sub * 100).toFixed(0)}%, low-mid ${(x.lowMid * 100).toFixed(0)}%, low corr ${x.lowCorrelation.toFixed(2)}`;
  const top = peak(mine.mix);
  const on = bars.reduce((a, b) => a + b.info.parts!.length, 0) / bars.length;
  // Each role where it plays hardest: its loudest bar outside builds (there the pad's stem carries the riser).
  const loudest = (r: typeof mine, list: Bar[]) =>
    [...r.roles].map(([role, s]) => `${role} ${db(Math.max(...list.map((b, i) => (b.info.build ? 0 : rms(s, i * r.frames, (i + 1) * r.frames))))).toFixed(1)} dB`).join(", ");
  // The low end bar by bar: below 150 Hz, the bars with kick and bass in, outside builds.
  const lowOf = (r: typeof mine, list: Bar[]) => {
    const levels: number[] = [];
    list.forEach((b, i) => {
      if (b.info.build || !b.info.parts!.includes("kick") || !b.info.parts!.includes("sub") || i < 16 || i >= list.length - 16) return;
      const c: Stereo = { l: r.mix.l.slice(i * r.frames, (i + 1) * r.frames), r: r.mix.r.slice(i * r.frames, (i + 1) * r.frames) };
      levels.push(db(rms(c) * Math.sqrt(measureWeight(c, WSR).sub + measureWeight(c, WSR).lowMid * 0.3)));
    });
    levels.sort((x, y) => x - y);
    return { median: levels[levels.length >> 1]!, spread: levels[Math.floor(levels.length * 0.95)]! - levels[Math.floor(levels.length * 0.05)]! };
  };
  const low = lowOf(mine, bars);
  const slides = bars.reduce((a, b) => a + b.notes.filter((n) => n.part === "acid" && n.gesture === "slide").length, 0);
  const acidBars = bars.filter((b) => b.info.parts!.includes("acid")).length;
  console.log(
    `one track through the worker (weighted mix, synth, ${WSR} Hz):\n` +
      `  psychedelic house ${line(m)} (${bars.length} bars at ${bars[0]!.bpm} bpm, ${on.toFixed(1)} parts in on average, peak ${top.toFixed(2)}, the acid line in ${acidBars} bars with ${slides} slid notes)\n` +
      others.map((o, i) => `  ${o.style.id.padEnd(17)} ${line(was[i]!)} (${o.bars.length} bars at ${o.bars[0]!.bpm} bpm, peak ${peak(o.heard.mix).toFixed(2)})\n`).join("") +
      `  loudest bar per role: ${loudest(mine, bars)}\n` +
      others.map((o) => `  loudest bar per role, ${o.style.id}: ${loudest(o.heard, o.bars)}\n`).join("") +
      `  low end in bars with kick and bass: median ${low.median.toFixed(1)} dB, 5th to 95th percentile ${low.spread.toFixed(1)} dB apart\n` +
      `  render time ${ms.toFixed(0)} ms per bar (a bar is ${((mine.frames / WSR) * 1000).toFixed(0)} ms)`,
  );
  for (const s of [mine.mix, ...mine.roles.values()]) for (let i = 0; i < s.l.length; i++) assert.ok(Number.isFinite(s.l[i]) && Number.isFinite(s.r[i]));
  // No bar is silent: a breakdown keeps at least the pad or a line.
  const quietest = Math.min(...bars.map((_, i) => rms(mine.mix, i * mine.frames, (i + 1) * mine.frames)));
  assert.ok(db(quietest) > -55, `the quietest bar: ${db(quietest).toFixed(1)} dB`);
  for (const [i, w] of was.entries()) assert.ok(Math.abs(db(m.rms / w.rms)) < 3, `level: ${db(m.rms / w.rms).toFixed(1)} dB against ${others[i]!.style.id}`);
  // A low end of its own: there, but less of the mix than Berlin techno's wall of rumble.
  assert.ok(m.sub > 0.3 && m.sub < was[1]!.sub, `sub share ${m.sub.toFixed(2)} against Berlin techno's ${was[1]!.sub.toFixed(2)}`);
  assert.ok(low.spread < 6, `the low end is even from bar to bar: ${low.spread.toFixed(1)} dB`);
  assert.ok(m.lowCorrelation > 0.95, `the low end is mono: ${m.lowCorrelation}`);
  assert.ok(top < 1 && top < Math.max(...others.map((o) => peak(o.heard.mix))) * 1.5, `peak ${top}`);
  assert.ok(slides > 20, "the acid line plays, with slides");
  assert.ok(ms < ((mine.frames / WSR) * 1000) / 4, `${ms} ms per bar`);
});
