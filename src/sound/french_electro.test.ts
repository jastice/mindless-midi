/**
 * French Electro (by Neon): the corpus validates cleanly, its hybrid
 * 909/LinnDrum kit and seven synth patches measure as designed, a set travels
 * across all seven of Claudia's styles within tempo and key limits, and a whole
 * track through the worker mixes near the other styles' level with mono lows,
 * heavy sidechain pump, clean bass swaps and no clipping.
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
import { bandShare, lowCorrelation, measureWeight } from "./measure.js";
import { stemMoves } from "./moves.js";
import type { ToStems, ToWorker } from "./protocol.js";
import { barScore } from "./score.js";
import { partLevels, styleSound } from "./sound_set.js";
import { type SoundSet, renderSynthNote } from "./synth.js";
import type { ScoreNote } from "./types.js";

const claudia = (JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: StyleBundle[] }).styles;
const FRENCH = claudia.find((s) => s.id === "french_electro")!;
const MINIMAL = claudia.find((s) => s.id === "minimal_techno")!;
const BERLIN = claudia.find((s) => s.id === "berlin_techno")!;
const PSY = claudia.find((s) => s.id === "psychedelic_house")!;
const BIG = claudia.find((s) => s.id === "big_beat")!;
const OTHERS = claudia.filter((s) => s.id !== "french_electro");
const corpus = FRENCH.corpus;
const SOUND = styleSound(corpus)!;
const KIT = corpus.synthKit!;
const ID = "french_electro";

const SR = 48000;
const BEAT = 60 / 126;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const round = (x: number, digits = 2) => Number(x.toFixed(digits));
const numbers: Record<string, Record<string, number>> = {};
const EXPRESSION: PieceOptions = { minSeconds: 180, maxSeconds: 360, expression: { gestures: true, velocityFloor: 0.5 } };

function cut(s: Stereo, aSec: number, bSec: number, sr = SR): Stereo {
  const a = Math.max(0, Math.round(aSec * sr));
  const b = Math.min(s.l.length, Math.round(bSec * sr));
  return { l: s.l.slice(a, b), r: s.r.slice(a, b) };
}

function rms(s: Stereo, a = 0, b = s.l.length): number {
  let e = 0;
  for (let i = a; i < b; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return Math.sqrt(e / (2 * Math.max(1, b - a)));
}

function peak(s: Stereo): number {
  let p = 0;
  for (let i = 0; i < s.l.length; i++) p = Math.max(p, Math.abs(s.l[i]!), Math.abs(s.r[i]!));
  return p;
}

function correlation(s: Stereo): number {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < s.l.length; i++) {
    lr += s.l[i]! * s.r[i]!;
    ll += s.l[i]! * s.l[i]!;
    rr += s.r[i]! * s.r[i]!;
  }
  return ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
}

/** Stereo lean in dB: positive is right, negative is left. */
function lean(s: Stereo): number {
  let l = 0;
  let r = 0;
  for (let i = 0; i < s.l.length; i++) {
    l += s.l[i]! ** 2;
    r += s.r[i]! ** 2;
  }
  return 10 * Math.log10(Math.max(r, 1e-18) / Math.max(l, 1e-18));
}

/** Zero-crossing spectral brightness proxy, Hz. */
function brightness(s: Stereo, sr = SR): number {
  let cross = 0;
  for (let i = 1; i < s.l.length; i++) {
    const a = s.l[i - 1]! + s.r[i - 1]!;
    const b = s.l[i]! + s.r[i]!;
    if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) cross++;
  }
  return (cross * sr) / (2 * Math.max(1, s.l.length));
}

/** Time for a decaying hit to fall 30 dB under its early RMS, seconds. */
function ringTime(s: Stereo, sr = SR): number {
  const win = Math.round(0.015 * sr);
  const top = Math.max(...Array.from({ length: Math.floor(s.l.length / win) }, (_, k) => rms(s, k * win, (k + 1) * win)));
  const floor = top * 10 ** (-30 / 20);
  let last = 0;
  for (let k = 0; (k + 1) * win <= s.l.length; k++) {
    if (rms(s, k * win, (k + 1) * win) >= floor) last = (k + 1) * win;
  }
  return last / sr;
}

function render(notes: ScoreNote[], seconds: number, sound: SoundSet = SOUND, sr = SR): Stereo {
  const out = stereo(Math.ceil(seconds * sr));
  const prev = new Map<string, ScoreNote>();
  for (const n of notes) {
    const k = n.part ?? n.role;
    renderSynthNote(out, n, sr, ID, prev.get(k), true, sound);
    prev.set(k, n);
  }
  return out;
}

function play(patch: string, role: Role, keys: number[], dur: number, seconds: number, pos = 0, vel = 100, gesture?: ScoreNote["gesture"]): Stereo {
  const program = corpus.instruments.find((i) => i.role === role)!.program;
  return render(
    keys.map((key) => ({ t: 0.01, dur, key, vel, ch: 0, role, program, patch, beat: BEAT, pos, ...(gesture && { gesture }) })),
    seconds,
  );
}

// --- The corpus --------------------------------------------------------------

test("the corpus is valid with no warnings, and is a full Claudia style with unique kit and patches", () => {
  const v = validateCorpus(JSON.parse(readFileSync("styles/french_electro/corpus.json", "utf8")));
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  assert.deepEqual(v.warnings, []);
  const parts = corpus.parts!;
  assert.equal(parts.length, 15);
  assert.ok(parts.some((p) => p.roll && p.lanes?.[0] === "clap") && corpus.moves?.build === 1, "clap roll before every drop");
  assert.ok(corpus.moves!.stutter >= 0.14 && corpus.moves!.sweep >= 0.5 && corpus.moves!.drift >= 0.5);
  const a = corpus.arrangement!;
  assert.ok(a.most! < MINIMAL.corpus.arrangement!.most! && a.groups!.line! <= 3 && a.groups!.perc! <= 2 && a.groups!.noise! <= 2);
  assert.equal(parts.filter((p) => p.group === "noise").length, 2);
  for (const p of parts) if (p.role !== "drums" && p.role !== "bass" && p.role !== "pad") assert.equal(p.group, "line", p.id);
  for (const p of parts) if (p.role !== "drums") assert.ok(corpus.patches!.some((x) => x.id === p.patch), p.id);
  for (const other of OTHERS) {
    for (const p of corpus.patches!) for (const q of other.corpus.patches ?? []) {
      assert.notDeepEqual({ ...p, id: "" }, { ...q, id: "" }, `${p.id} duplicates ${other.id}'s ${q.id}`);
    }
    assert.notDeepEqual(KIT, other.corpus.synthKit);
  }
  assert.ok(!KIT.rumble && KIT.kick.sub && KIT.perc!.filter((p) => p.tuned).length === 3);
  for (const f of corpus.forms) {
    assert.ok(f.sections.every((s) => s.bars === 16 || s.bars === 32), f.id);
    assert.ok(f.sections.some((s) => !s.roles.includes("bass") && s.roles.includes("pad")), `${f.id} has a breakdown with pad`);
    assert.ok(f.sections.some((s) => s.intensity >= 0.9 && s.roles.includes("lead")), `${f.id} has a peak with neon lead`);
    assert.ok(f.sections.reduce((n, s) => n + s.bars, 0) >= 128, f.id);
    assert.deepEqual([f.sections[0]!.bars, f.sections.at(-1)!.bars], [16, 16], f.id);
    assert.deepEqual([f.sections[0]!.intensity, f.sections.at(-1)!.intensity], [0.3, 0.3], f.id);
    assert.ok(f.sections.at(-2)!.intensity >= 0.72 && f.sections.at(-2)!.roles.includes("drums") && f.sections.at(-2)!.roles.includes("bass"), `${f.id} holds a hot body into blends`);
  }
});

test("keys and progressions: pure aeolian harmony compatible with every Claudia style", () => {
  assert.deepEqual(corpus.tempo, { min: 122, max: 130 });
  assert.equal(corpus.beatsPerBar, 4);
  const toKey = (k: { tonic: string; mode: string }) => ({ tonic: pitchClass(k.tonic), mode: k.mode as ModeName });
  const mine = corpus.keys.map(toKey);
  assert.ok(mine.every((k) => k.mode === "aeolian"));
  for (const other of OTHERS) {
    const theirs = other.corpus.keys.map(toKey);
    for (const k of mine) assert.ok(theirs.some((t) => keysCompatible(k, t)), `${JSON.stringify(k)} has no neighbour in ${other.id}`);
  }
  // Every chord tone (including tensions) of every progression stays inside aeolian.
  const aeolian = new Set<number>(MODES.aeolian);
  for (const p of corpus.progressions) {
    for (const slot of p.chords) {
      const pcs = chordPitchClasses(0, parseRoman(slot.symbol), true);
      for (const pc of pcs) assert.ok(aeolian.has(mod(pc, 12)), `${p.id}: ${slot.symbol} pitch class ${pc} outside aeolian`);
    }
  }
});

test("grooves and lines: four-on-the-floor punch, continuous slap bass, tied slides and safe arp for overlaps", () => {
  const grooves = corpus.drums.filter((d) => d.kind === "groove" && d.material === undefined);
  assert.ok(grooves.length >= 6);
  for (const g of grooves) {
    for (const i of [0, 4, 8, 12]) assert.equal(g.lanes.kick[i], "X", `${g.id} four-on-the-floor kick at ${i}`);
    assert.equal(g.lanes.snare[4], "X", `${g.id} snare on beat 2`);
    assert.equal(g.lanes.snare[12], "X", `${g.id} snare on beat 4`);
  }
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
      if (n.g) assert.ok(n.d >= 0.2, `${m.id}[${i}]: gesture needs d >= 0.2`);
      if (n.g === "slide") {
        const prev = m.notes[i - 1]!;
        assert.ok(prev && Math.abs(prev.t + prev.d - n.t) < 1e-9, `${m.id}[${i}]: slide must touch note before`);
      }
    });
  }
  // Untagged arp (coolest running line, played during blends) stays strictly on {0, 3, 4, 7}.
  const safe = new Set([0, 3, 4, 7]);
  const arp = corpus.motifs.filter((m) => m.role === "arp" && m.material === undefined);
  assert.ok(arp.length >= 5);
  for (const m of arp) {
    assert.equal(m.anchor, "key", m.id);
    for (const n of m.notes) assert.ok(safe.has(n.deg), `${m.id}: degree ${n.deg} outside {0,3,4,7}`);
  }
  // Acid saw motifs have tied slides and barking accents.
  const acid = corpus.motifs.filter((m) => m.material === "acid");
  assert.ok(acid.length >= 5);
  for (const m of acid) {
    assert.ok(m.notes.some((n) => n.g === "slide") && m.notes.some((n) => n.g === "accent"), m.id);
    m.notes.forEach((n, i) => {
      if (n.g) assert.ok(n.d >= 0.2, `${m.id}[${i}]: gesture needs d >= 0.2`);
      if (n.g === "slide") {
        const prev = m.notes[i - 1]!;
        assert.ok(prev && Math.abs(prev.t + prev.d - n.t) < 1e-9, `${m.id}[${i}]: acid slide touches note before`);
      }
    });
  }
});

// --- Acoustic checks on kit and all seven patches ----------------------------

test("kit: punchy club kick without rumble, fat LinnDrum snare, sizzling hats and tuned Simmons toms", () => {
  const hit = (key: number, vel = 110, tonic = 9, dur = 0.25) =>
    render([{ t: 0.01, dur, key, vel, ch: 9, role: "drums", program: 0, tonic }], 1.4);
  const kick = hit(36);
  const snare = hit(38);
  const hat = hit(42);
  const open = hit(46);
  const clap = hit(39);
  const tomA = hit(45, 110, 9);
  const tomC = hit(45, 110, 0);
  const rimA = hit(37, 110, 9);

  const m = (numbers.kit = {
    kickSub120: round(bandShare(kick, SR, 0, 120), 3),
    kickRing: round(ringTime(kick), 3),
    kickLowCorr: round(lowCorrelation(kick, SR), 3),
    kickPeak: round(peak(kick), 3),
    snareMid2k: round(bandShare(snare, SR, 120, 2000), 3),
    snareRing: round(ringTime(snare), 3),
    hatHigh5k: round(bandShare(hat, SR, 5000, Infinity), 3),
    openRing: round(ringTime(open), 3),
    clapRing: round(ringTime(clap), 3),
    tomBrightA: round(brightness(cut(tomA, 0.04, 0.16)), 0),
    tomBrightC: round(brightness(cut(tomC, 0.04, 0.16)), 0),
    rimPeak: round(peak(rimA), 3),
  });
  assert.ok(m.kickSub120 > 0.72 && m.kickRing < 0.55 && m.kickLowCorr > 0.99 && m.kickPeak < 0.98, JSON.stringify(m));
  assert.ok(m.snareMid2k > 0.2 && m.snareRing > 0.18 && m.snareRing < 0.75, JSON.stringify(m));
  assert.ok(m.hatHigh5k > 0.8 && m.openRing > 0.22 && m.clapRing > 0.12, JSON.stringify(m));
  assert.ok(m.tomBrightC > m.tomBrightA * 1.1, `tuned Simmons tom follows tonic: ${m.tomBrightA} vs ${m.tomBrightC} Hz`);
  for (const [name, s] of [["kick", kick], ["snare", snare], ["hat", hat], ["open", open], ["clap", clap], ["tom", tomA], ["rim", rimA]] as const) {
    assert.ok(peak(s) > 0.05 && peak(s) < 1, `${name}: peak ${peak(s)}`);
  }
});

test("slap_bass and acid_saw: mono driven slap low end, tied slides without re-attack, barking accents", () => {
  const bassPlain = play("slap_bass", "bass", [33], 0.5 * BEAT, 1.0, 0, 100);
  const bassAccent = play("slap_bass", "bass", [33], 0.5 * BEAT, 1.0, 0, 115, "accent");
  const bassTied = render([
    { t: 0.01, dur: 0.5 * BEAT, key: 33, vel: 105, ch: 0, role: "bass", program: 38, patch: "slap_bass", beat: BEAT, pos: 0 },
    { t: 0.01 + 0.5 * BEAT, dur: 0.5 * BEAT, key: 45, vel: 95, ch: 0, role: "bass", program: 38, patch: "slap_bass", beat: BEAT, pos: 0.5, gesture: "slide" },
  ], 1.2);
  const acidPlain = play("acid_saw", "arp", [45], 0.5 * BEAT, 1.0, 0, 100);
  const acidAccent = play("acid_saw", "arp", [45], 0.5 * BEAT, 1.0, 0, 115, "accent");
  const acidTied = render([
    { t: 0.01, dur: 0.5 * BEAT, key: 45, vel: 100, ch: 0, role: "arp", program: 81, patch: "acid_saw", beat: BEAT, pos: 0 },
    { t: 0.01 + 0.5 * BEAT, dur: 0.5 * BEAT, key: 57, vel: 95, ch: 0, role: "arp", program: 81, patch: "acid_saw", beat: BEAT, pos: 0.5, gesture: "slide" },
  ], 1.2);
  const acidStruck = render([
    { t: 0.01, dur: 0.5 * BEAT, key: 45, vel: 100, ch: 0, role: "arp", program: 81, patch: "acid_saw", beat: BEAT, pos: 0 },
    { t: 0.01 + 0.5 * BEAT, dur: 0.5 * BEAT, key: 57, vel: 95, ch: 0, role: "arp", program: 81, patch: "acid_saw", beat: BEAT, pos: 0.5 },
  ], 1.2);
  const joinAt = 0.01 + 0.5 * BEAT;
  const jumpDb = (s: Stereo) => db(rms(cut(s, joinAt + 0.002, joinAt + 0.04)) / rms(cut(s, joinAt - 0.04, joinAt - 0.002)));

  const m = (numbers.bassAndAcid = {
    bassSub150: round(bandShare(bassPlain, SR, 0, 150), 3),
    bassDriveAbove180: round(bandShare(bassPlain, SR, 180, Infinity), 3),
    bassLowCorr: round(lowCorrelation(bassPlain, SR), 3),
    bassAccentBrightRatio: round(brightness(cut(bassAccent, 0.015, 0.14)) / brightness(cut(bassPlain, 0.015, 0.14)), 2),
    bassPeak: round(peak(bassTied), 3),
    acidBelow180: round(bandShare(acidPlain, SR, 0, 180), 4),
    acidAccentBrightRatio: round(brightness(cut(acidAccent, 0.015, 0.14)) / brightness(cut(acidPlain, 0.015, 0.14)), 2),
    acidTiedJumpDb: round(jumpDb(acidTied), 2),
    acidStruckJumpDb: round(jumpDb(acidStruck), 2),
    acidPeak: round(peak(acidAccent), 3),
  });
  assert.ok(m.bassSub150 > 0.4 && m.bassDriveAbove180 > 0.1 && m.bassLowCorr > 0.99, JSON.stringify(m));
  assert.ok(m.bassAccentBrightRatio > 1.1 && m.bassPeak < 1, JSON.stringify(m));
  assert.ok(m.acidBelow180 < 0.04 && m.acidAccentBrightRatio > 1.25 && m.acidPeak < 1, JSON.stringify(m));
  assert.ok(m.acidTiedJumpDb < m.acidStruckJumpDb - 1.5, `tied acid slide smooth across join: ${m.acidTiedJumpDb} vs ${m.acidStruckJumpDb} dB`);
});

test("neon_arp, super_stab, vocoder_choir, neon_lead and pwm_pad: stereo image, formants, sweeps and headroom", () => {
  const arpA = play("neon_arp", "arp", [69], 0.25 * BEAT, 1.0, 1.5);
  const arpB = play("neon_arp", "arp", [69], 0.25 * BEAT, 1.0, 4.5);
  const chord = [57, 60, 64, 67];
  const stabOpen = play("super_stab", "comp", chord, 0.5 * BEAT, 1.2, 4);
  const stabClosed = play("super_stab", "comp", chord, 0.5 * BEAT, 1.2, 12);
  const vocoder = play("vocoder_choir", "comp", chord, 1.0 * BEAT, 1.5, 0);
  const dryVocoderSound: SoundSet = {
    ...SOUND,
    patches: { ...SOUND.patches, vocoder_dry: { ...SOUND.patches!.vocoder_choir!, formants: [] } },
  };
  const vocoderDry = render(
    chord.map((key) => ({ t: 0.01, dur: 1.0 * BEAT, key, vel: 100, ch: 0, role: "comp" as Role, program: 90, patch: "vocoder_dry", beat: BEAT, pos: 0 })),
    1.5,
    dryVocoderSound,
  );
  const lead = play("neon_lead", "lead", [76], 1.5 * BEAT, 2.2, 0);
  const pad = play("pwm_pad", "pad", chord, 5.5, 10, 0);
  const padOpen = cut(play("pwm_pad", "pad", chord, 4, 4.5, 8 - 3 / BEAT), 2.5, 3.5);
  const padDark = cut(play("pwm_pad", "pad", chord, 4, 4.5, 24 - 3 / BEAT), 2.5, 3.5);

  const m = (numbers.voices = {
    arpBelow200: round(bandShare(arpA, SR, 0, 200), 4),
    arpPanSpreadDb: round(Math.abs(lean(arpA) - lean(arpB)), 1),
    stabBelow180: round(bandShare(stabOpen, SR, 0, 180), 4),
    stabCorr: round(correlation(stabOpen), 2),
    stabBrightOpen: round(brightness(cut(stabOpen, 0.02, 0.22)), 0),
    stabBrightClosed: round(brightness(cut(stabClosed, 0.02, 0.22)), 0),
    vocoderBelow200: round(bandShare(vocoder, SR, 0, 200), 4),
    vocoderVocalBand: round(bandShare(vocoder, SR, 300, 3600), 3),
    vocoderFormantLiftDb: round(db((rms(vocoder) * Math.sqrt(bandShare(vocoder, SR, 600, 3000))) / (rms(vocoderDry) * Math.sqrt(bandShare(vocoderDry, SR, 600, 3000)))), 1),
    vocoderCorr: round(correlation(vocoder), 2),
    leadBelow200: round(bandShare(lead, SR, 0, 200), 4),
    leadCorr: round(correlation(lead), 2),
    padBelow180: round(bandShare(cut(pad, 2.5, 5.5), SR, 0, 180), 4),
    padAttackDb: round(db(rms(cut(pad, 0.01, 0.16)) / rms(cut(pad, 2.5, 5.5))), 1),
    padRelease: round(ringTime(cut(pad, 5.5, 10)), 2),
    padCorr: round(correlation(cut(pad, 2.5, 5.5)), 2),
    padBrightOpen: round(brightness(padOpen), 0),
    padBrightDark: round(brightness(padDark), 0),
  });
  assert.ok(m.arpBelow200 < 0.02 && m.arpPanSpreadDb > 3, JSON.stringify(m));
  assert.ok(m.stabBelow180 < 0.04 && m.stabCorr < 0.92 && m.stabBrightOpen > m.stabBrightClosed * 1.25, JSON.stringify(m));
  assert.ok(m.vocoderBelow200 < 0.03 && m.vocoderVocalBand > 0.7 && m.vocoderFormantLiftDb > 4 && m.vocoderCorr < 0.92, JSON.stringify(m));
  assert.ok(m.leadBelow200 < 0.03 && m.leadCorr < 0.95, JSON.stringify(m));
  assert.ok(m.padBelow180 < 0.03 && m.padAttackDb < -8 && m.padRelease > 0.7 && m.padCorr < 0.92 && m.padBrightOpen > m.padBrightDark * 1.3, JSON.stringify(m));
  for (const [name, s] of [["arp", arpA], ["stab", stabOpen], ["vocoder", vocoder], ["lead", lead], ["pad", pad]] as const) {
    assert.ok(peak(s) > 0.04 && peak(s) < 1, `${name}: peak ${peak(s).toFixed(3)}`);
  }
  console.log("measured french_electro:", JSON.stringify(numbers, null, 1));
});

// --- Seven-style set travel & overlap safety ---------------------------------

test("the seven-style set reaches French Electro, obeys tempo/key rules, and prefers neon_arp when non-dominant", () => {
  const seen = new Set<string>();
  const links = new Set<string>();
  let overlapBars = 0;
  let arpInOverlap = 0;
  let acidOrLeadInOverlap = 0;
  for (const seed of ["neon-set-1", "neon-set-2", "neon-set-3", "neon-set-4"]) {
    const set = new SetConductor(claudia, seed, EXPRESSION);
    let before: { style: string; bpm: number; key: { tonic: number; mode: ModeName } } | undefined;
    let last = -1;
    for (let i = 0; i < 3000; i++) {
      const slice = set.nextSlice();
      const dom = slice.decks.find((d) => d.deck === slice.dominant)!.bar;
      const other = slice.decks.find((d) => d.deck !== slice.dominant)?.bar;
      seen.add(dom.info.styleId);
      if (other && other.info.styleId === ID) {
        overlapBars++;
        const ps = other.info.parts ?? [];
        if (ps.includes("arp")) arpInOverlap++;
        if (ps.includes("acid") || ps.includes("lead")) acidOrLeadInOverlap++;
      }
      if (last !== dom.info.pieceIndex) {
        const now = { style: dom.info.styleId, bpm: set.trackPlan(dom.info.pieceIndex)!.bpm, key: { tonic: dom.info.tonic, mode: dom.info.mode } };
        if (before) {
          assert.ok(Math.abs(now.bpm / before.bpm - 1) <= MAX_TEMPO_STEP + 1e-9);
          assert.ok(keysCompatible(now.key, before.key));
          links.add(`${before.style}>${now.style}`);
        }
        before = now;
        last = dom.info.pieceIndex;
      }
      for (const d of slice.decks) assert.equal(d.bar.bpm, dom.bpm);
      assert.equal(dom.info.pieceBars % PHRASE_BARS, 0);
    }
  }
  console.log(`7-style set travel: ${seen.size} styles, ${links.size} ordered pairs, non-dominant overlap bars ${overlapBars} (arp ${arpInOverlap}, acid/lead ${acidOrLeadInOverlap})`);
  assert.deepEqual([...seen].sort(), claudia.map((s) => s.id).sort());
  assert.ok([...links].some((p) => p.startsWith(`${ID}>`)) && [...links].some((p) => p.endsWith(`>${ID}`)));
  assert.ok(overlapBars > 100 && arpInOverlap > overlapBars * 0.7 && acidOrLeadInOverlap < overlapBars * 0.15);
});

// --- Whole track through the render worker -----------------------------------

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

test("a whole track through the worker: near the other styles' level, mono even low end, stutters and slides, fast render", async () => {
  const bars = ["neon-worker-a", "neon-worker-b", "neon-worker-c", "neon-worker-d", "neon-worker-e", "neon-worker-f"]
    .map((seed) => track(FRENCH, seed))
    .find((t) => t.some((b) => b.info.parts!.includes("lead")) && t.some((b) => b.moves?.some((m) => m.target === "stutter")))!;
  assert.ok(bars, "found a track with neon lead and stutters");
  const t0 = performance.now();
  const mine = await run(FRENCH, bars);
  const ms = (performance.now() - t0) / bars.length;
  const refs = [];
  for (const s of [MINIMAL, BERLIN, PSY, BIG]) {
    const theirBars = track(s, "neon-worker-a");
    refs.push({ style: s, bars: theirBars, heard: await run(s, theirBars) });
  }
  const body = (r: { mix: Stereo; frames: number }, n: number): Stereo => ({
    l: r.mix.l.slice(16 * r.frames, (n - 16) * r.frames),
    r: r.mix.r.slice(16 * r.frames, (n - 16) * r.frames),
  });
  const m = measureWeight(body(mine, bars.length), WSR);
  const was = refs.map((o) => measureWeight(body(o.heard, o.bars.length), WSR));
  const line = (x: typeof m) =>
    `rms ${db(x.rms).toFixed(1)} dB, crest ${x.crest.toFixed(1)} dB, range ${x.range.toFixed(1)} dB, sub ${(x.sub * 100).toFixed(0)}%, low-mid ${(x.lowMid * 100).toFixed(0)}%, low corr ${x.lowCorrelation.toFixed(2)}`;
  const top = peak(mine.mix);
  const on = bars.reduce((a, b) => a + b.info.parts!.length, 0) / bars.length;
  const lowLevels: number[] = [];
  bars.forEach((b, i) => {
    if (b.info.build || !b.info.parts!.includes("kick") || !b.info.parts!.includes("bass") || i < 16 || i >= bars.length - 16) return;
    const c: Stereo = { l: mine.mix.l.slice(i * mine.frames, (i + 1) * mine.frames), r: mine.mix.r.slice(i * mine.frames, (i + 1) * mine.frames) };
    const w = measureWeight(c, WSR);
    lowLevels.push(db(rms(c) * Math.sqrt(w.sub + w.lowMid * 0.3)));
  });
  lowLevels.sort((a, b) => a - b);
  const spread = lowLevels[Math.floor(lowLevels.length * 0.95)]! - lowLevels[Math.floor(lowLevels.length * 0.05)]!;
  const stutters = bars.filter((b) => b.moves?.some((mv) => mv.target === "stutter")).length;
  const slides = bars.reduce((a, b) => a + b.notes.filter((n) => n.gesture === "slide").length, 0);
  console.log(
    `french_electro through the worker (weighted mix, synth, ${WSR} Hz):\n` +
      `  french_electro    ${line(m)} (${bars.length} bars at ${bars[0]!.bpm} bpm, ${on.toFixed(1)} parts avg, peak ${top.toFixed(2)}, ${stutters} stutters, ${slides} slides)\n` +
      refs.map((o, i) => `  ${o.style.id.padEnd(17)} ${line(was[i]!)} (${o.bars.length} bars at ${o.bars[0]!.bpm} bpm, peak ${peak(o.heard.mix).toFixed(2)})\n`).join("") +
      `  low-end 5th-95th spread: ${spread.toFixed(1)} dB | render ${ms.toFixed(0)} ms/bar (bar is ${((mine.frames / WSR) * 1000).toFixed(0)} ms)`,
  );
  for (const s of [mine.mix, ...mine.roles.values()]) for (let i = 0; i < s.l.length; i++) assert.ok(Number.isFinite(s.l[i]) && Number.isFinite(s.r[i]));
  const quietest = Math.min(...bars.map((_, i) => rms(mine.mix, i * mine.frames, (i + 1) * mine.frames)));
  assert.ok(db(quietest) > -55, `quietest bar: ${db(quietest).toFixed(1)} dB`);
  for (const [i, w] of was.entries()) assert.ok(Math.abs(db(m.rms / w.rms)) < 3, `level ${db(m.rms / w.rms).toFixed(1)} dB vs ${refs[i]!.style.id}`);
  assert.ok(m.sub > 0.25 && m.sub < 0.72, `sub share ${m.sub.toFixed(2)}`);
  assert.ok(spread < 5.5, `low end even bar to bar: ${spread.toFixed(1)} dB`);
  assert.ok(m.lowCorrelation > 0.95, `mono low end: ${m.lowCorrelation}`);
  assert.ok(top < 0.85, `peak ${top}`);
  assert.ok(stutters >= 1 && slides >= 20);
  assert.ok(ms < ((mine.frames / WSR) * 1000) / 4, `${ms} ms/bar`);
});
