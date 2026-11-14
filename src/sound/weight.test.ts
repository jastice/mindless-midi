import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ROLES, type Role } from "../corpus/constants.js";
import type { StyleBundle } from "../corpus/schema.js";
import { Conductor } from "../engine/conductor.js";
import { velocityScale } from "../engine/parts.js";
import { DEFAULT_PIECE_OPTIONS } from "../engine/piece.js";
import { BodyLeveler } from "./body_leveler.js";
import { STEM_REF } from "./bus.js";
import { StemWindow, type Stereo, stereo } from "./dsp.js";
import { RoleLeveler } from "./leveler.js";
import { bandShare, lowCorrelation, measureWeight } from "./measure.js";
import { type PlannedNote, type SampleData, TOUCH_SAMPLES, mirrorPath, renderSampleNote } from "./sampler.js";
import { barScore } from "./score.js";
import { renderSynthNote } from "./synth.js";
import type { ScoreNote } from "./types.js";
import { type StemId, WeightedMix, weightFor } from "./weight.js";

const SR = 24000;
const FLOOR = 0.42;
const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };
const db = (x: number) => 20 * Math.log10(x);
const rms = (s: Stereo, start = 0, end = s.l.length) => {
  const from = Math.round(start);
  const to = Math.round(end);
  let e = 0;
  for (let i = from; i < to; i++) e += s.l[i]! ** 2 + s.r[i]! ** 2;
  return Math.sqrt(e / (2 * Math.max(1, to - from)));
};
const tone = (seconds: number, amp: number, hz = 220): Stereo => {
  const s = stereo(Math.round(seconds * SR));
  for (let i = 0; i < s.l.length; i++) s.l[i] = s.r[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return s;
};
const slice = (s: Stereo, from: number, to: number): Stereo => ({ l: s.l.slice(from, to), r: s.r.slice(from, to) });

// --- The leveller --------------------------------------------------------------

test("a short burst above a steady tone does not move the body leveller, and it does move the old one", () => {
  const chunk = SR; // one-second chunks, like bars
  const make = () => {
    const s = tone(8, 0.02);
    // 60 ms, 20 dB up, at 5.0 s.
    for (let i = 5 * SR; i < 5.06 * SR; i++) s.l[i] = s.r[i] = s.l[i]! * 10;
    return s;
  };
  const body = new BodyLeveler(SR, STEM_REF);
  const a = make();
  const gains: number[] = [];
  for (let at = 0; at < a.l.length; at += chunk) {
    body.process([{ l: a.l.subarray(at, at + chunk) as Float32Array<ArrayBuffer>, r: a.r.subarray(at, at + chunk) as Float32Array<ArrayBuffer> }], 1);
    gains.push(body.gain);
  }
  // The tone right after the burst is where it was before it.
  const before = rms(a, 4.5 * SR, 5 * SR);
  assert.ok(Math.abs(db(rms(a, 5.06 * SR, 5.16 * SR) / before)) < 0.3, "within 100 ms");
  assert.ok(Math.abs(db(gains[5]! / gains[4]!)) < 0.5 && Math.abs(db(gains[7]! / gains[4]!)) < 0.5, "and after");
  assert.ok(Math.abs(db(before / STEM_REF)) < 0.5, "at its target level");

  const old = new RoleLeveler(SR, STEM_REF);
  const b = make();
  old.process(b);
  const dropped = db(rms(b, 5.2 * SR, 5.5 * SR) / rms(b, 4.5 * SR, 5 * SR));
  assert.ok(dropped < -3, `the old leveller turns the tone down ${dropped.toFixed(1)} dB after one burst`);
});

test("an instrument is at its level from its first chunk", () => {
  const body = new BodyLeveler(SR, STEM_REF);
  const s = tone(1, 0.3);
  body.process([s], 1);
  assert.ok(Math.abs(db(rms(s, 0, SR / 10) / STEM_REF)) < 0.5);
});

test("a kit's kick and the rest of it are levelled as one", () => {
  const body = new BodyLeveler(SR, STEM_REF);
  const kick = tone(1, 0.4, 60);
  const hats = tone(1, 0.05, 6000);
  const ratio = rms(kick) / rms(hats);
  body.process([hats, kick], 1);
  assert.ok(Math.abs(db(rms(kick) / rms(hats) / ratio)) < 0.01);
});

/** Notes of one role through the synth and a leveller, a bar at a time. Returns the level of each note's first 80 ms, before and after. */
function levelled(notes: ScoreNote[], barSeconds: number, leveller: "body" | "old"): { dry: number[]; out: number[] } {
  const frames = Math.round(barSeconds * SR);
  const bars = Math.ceil((notes[notes.length - 1]!.t + 0.5) / barSeconds);
  const w = new StemWindow(0, 12 * SR);
  const body = new BodyLeveler(SR, STEM_REF);
  const old = new RoleLeveler(SR, STEM_REF);
  const dry = stereo(bars * frames);
  const out = stereo(bars * frames);
  let prev: ScoreNote | undefined;
  for (let b = 0; b < bars; b++) {
    const mine = notes.filter((n) => n.t >= b * barSeconds && n.t < (b + 1) * barSeconds);
    for (const n of mine) {
      renderSynthNote(w, n, SR, "funk", prev);
      prev = n;
    }
    const chunk = w.take(frames);
    dry.l.set(chunk.l, b * frames);
    dry.r.set(chunk.r, b * frames);
    if (leveller === "body") body.process([chunk], mine.length ? 1 : undefined);
    else old.process(chunk);
    out.l.set(chunk.l, b * frames);
    out.r.set(chunk.r, b * frames);
  }
  const at = (s: Stereo) => notes.map((n) => rms(s, Math.round((n.t + 0.01) * SR), Math.round((n.t + 0.09) * SR)));
  return { dry: at(dry), out: at(out) };
}

test("a written two-bar crescendo keeps its shape through the body leveller, and loses it through the old one", () => {
  const parts: [string, Pick<ScoreNote, "role" | "program" | "key">][] = [
    ["synth bass", { role: "bass", program: 38, key: 36 }],
    ["plucked bass", { role: "bass", program: 33, key: 40 }],
    ["saw lead", { role: "lead", program: 81, key: 67 }],
    ["piano", { role: "comp", program: 0, key: 60 }],
    ["kick", { role: "drums", program: 0, key: 36 }],
    ["snare", { role: "drums", program: 0, key: 38 }],
  ];
  const moved: number[] = [];
  for (const [name, part] of parts) {
    // Eight bars of steady playing, then two bars from soft to hard.
    const notes: ScoreNote[] = [];
    for (let i = 0; i < 64; i++) notes.push({ t: i * 0.25, dur: 0.2, vel: 80, ch: 0, ...part });
    for (let i = 0; i < 16; i++) notes.push({ t: 16 + i * 0.25, dur: 0.2, vel: 40 + i * 5, ch: 0, ...part });
    const shape = (r: { dry: number[]; out: number[] }) => {
      const g = r.out.slice(64).map((x, i) => db(x / r.dry[64 + i]!));
      return Math.max(...g) - Math.min(...g);
    };
    const kept = shape(levelled(notes, 2, "body"));
    const lost = shape(levelled(notes, 2, "old"));
    moved.push(lost);
    console.log(`crescendo, ${name}: gain moves ${kept.toFixed(2)} dB through the body leveller, ${lost.toFixed(2)} dB through the old one`);
    assert.ok(kept < 1, `${name}: gain moved ${kept.toFixed(2)} dB across the crescendo`);
    assert.ok(kept < lost, name);
  }
  assert.ok(Math.min(...moved) > 1, "the old leveller moves every one of them by more than 1 dB");
});

// --- The stem mix ----------------------------------------------------------------

test("ducking follows the kick's envelope: a ghost kick moves the pad less than a full one", () => {
  const mix = new WeightedMix(SR);
  const weight = { ...weightFor("synthwave") };
  const kickAt = (amp: number): Stereo => {
    const s = stereo(SR);
    for (let i = 0; i < SR * 0.15; i++) s.l[i + SR / 4] = s.r[i + SR / 4] = amp * Math.sin((2 * Math.PI * 60 * i) / SR) * Math.exp(-i / (SR * 0.05));
    return s;
  };
  const dip = (amp: number) => {
    const pad = tone(1, 0.05);
    const stems = new Map<StemId, Stereo>([["kick", kickAt(amp)], ["pad", pad]]);
    mix.process(stems, weight, 0.5);
    return db(rms(pad, SR / 4 + 200, SR / 4 + 900) / rms(pad, 0, SR / 5));
  };
  const full = dip(0.3);
  const ghost = dip(0.06);
  assert.ok(full < -3, `full kick dips the pad ${full.toFixed(1)} dB`);
  assert.ok(ghost > full + 2, `ghost kick dips it ${ghost.toFixed(1)} dB`);
  // And the pad is back before the next beat.
  const pad = tone(1, 0.05);
  mix.process(new Map<StemId, Stereo>([["kick", kickAt(0.3)], ["pad", pad]]), weight, 0.5);
  assert.ok(db(rms(pad, 0.85 * SR, SR) / rms(pad, 0, SR / 5)) > -0.5);
});

test("the low end comes out mono, the kick comes out inside the kit, and intensity leans in", () => {
  const wide = (): Stereo => {
    const s = stereo(SR);
    for (let i = 0; i < SR; i++) {
      s.l[i] = 0.05 * Math.sin((2 * Math.PI * 55 * i) / SR) + 0.02 * Math.sin((2 * Math.PI * 2000 * i) / SR);
      s.r[i] = -0.05 * Math.sin((2 * Math.PI * 55 * i) / SR + 1) + 0.02 * Math.sin((2 * Math.PI * 2100 * i) / SR);
    }
    return s;
  };
  assert.ok(lowCorrelation(wide(), SR) < 0.2);
  const mix = new WeightedMix(SR);
  const bass = wide();
  const out = mix.process(new Map<StemId, Stereo>([["bass", bass], ["kick", tone(1, 0.2, 60)]]), weightFor("funk"), 0.5);
  assert.ok(lowCorrelation(slice(out.get("bass")!, SR / 2, SR), SR) > 0.97, "mono below the crossover");
  assert.ok(Math.abs(rms({ l: bass.l, r: bass.l }) - rms({ l: bass.r, r: bass.r })) > 0, "the top stays wide");
  assert.deepEqual([...out.keys()].sort(), ["bass", "drums"]);

  // Hits with a quiet ring between them: how far the ring comes up against the hit.
  const ring = (intensity: number) => {
    const m = new WeightedMix(SR);
    let kit = stereo(SR);
    for (let pass = 0; pass < 2; pass++) {
      kit = stereo(SR);
      for (let i = 0; i < SR; i++) kit.l[i] = kit.r[i] = (i % (SR / 4) < 400 ? 0.3 : 0.01) * Math.sin(i * 0.7);
      m.process(new Map<StemId, Stereo>([["drums", kit]]), weightFor("funk"), intensity);
    }
    return db(rms(kit, SR / 4 + 3000, SR / 4 + 5500) / rms(kit, SR / 4, SR / 4 + 400));
  };
  assert.ok(ring(1) > ring(0) + 1, `the compressed copy brings the ring up more in a full section (${ring(0).toFixed(1)} dB, ${ring(1).toFixed(1)} dB under the hit)`);
});

/** A style's music through the synth: the stems summed, by the old path and by the weighted one. */
function mixdown(styleId: string, seed: string, bars: number, weighted: boolean): Stereo & { bars: { intensity: number; from: number; to: number }[] } {
  const style = styles.find((s) => s.id === styleId)!;
  const conductor = new Conductor([style], seed, weighted ? { ...DEFAULT_PIECE_OPTIONS, expression: { gestures: true, velocityFloor: FLOOR } } : DEFAULT_PIECE_OPTIONS);
  const levels = Object.fromEntries(style.corpus.instruments.map((i) => [i.role, i.volume])) as Partial<Record<Role, number>>;
  const windows = new Map<StemId, StemWindow>();
  const old = new Map<Role, RoleLeveler>();
  const bodies = new Map<Role, BodyLeveler>();
  const mix = new WeightedMix(SR);
  const programs = new Map<number, number>();
  const prev = new Map<Role, ScoreNote>();
  const chunks: Stereo[] = [];
  const spans: { intensity: number; from: number; to: number }[] = [];
  let start = 0;
  for (let b = 0; b < bars; b++) {
    const bar = conductor.nextBar();
    const frames = Math.round(((bar.beats * 60) / bar.bpm) * SR);
    const notes = barScore(bar, programs, weighted ? { legato: true, gestures: true } : {}).map((n) => ({ ...n, t: n.t + start / SR }));
    for (const n of notes) {
      const id: StemId = weighted && n.role === "drums" && (n.key === 35 || n.key === 36) ? "kick" : n.role;
      let w = windows.get(id);
      if (!w) windows.set(id, (w = new StemWindow(start, 20 * SR)));
      renderSynthNote(w, n, SR, styleId, prev.get(n.role), weighted);
      prev.set(n.role, n);
    }
    let stems = new Map<StemId, Stereo>();
    for (const [id, w] of windows) stems.set(id, w.take(frames));
    if (weighted) {
      for (const role of ROLES) {
        const group = [stems.get(role), role === "drums" ? stems.get("kick") : undefined].filter((s): s is Stereo => s !== undefined);
        if (!group.length) continue;
        let lv = bodies.get(role);
        if (!lv) bodies.set(role, (lv = new BodyLeveler(SR, STEM_REF)));
        lv.target = (levels[role] ?? 0.5) * STEM_REF;
        lv.process(group, notes.some((n) => n.role === role) ? Math.pow(velocityScale(bar.info.intensity, FLOOR), 1.3) : undefined);
      }
      stems = mix.process(stems, weightFor(styleId), bar.info.intensity);
    } else {
      for (const [role, s] of stems as Map<Role, Stereo>) {
        let lv = old.get(role);
        if (!lv) old.set(role, (lv = new RoleLeveler(SR, STEM_REF)));
        lv.target = (levels[role] ?? 0.5) * STEM_REF;
        lv.process(s);
      }
    }
    const sum = stereo(frames);
    for (const s of stems.values()) {
      for (let i = 0; i < frames; i++) {
        sum.l[i]! += s.l[i]!;
        sum.r[i]! += s.r[i]!;
      }
    }
    chunks.push(sum);
    if (!bar.info.gap) spans.push({ intensity: bar.info.intensity, from: start, to: start + frames });
    start += frames;
  }
  const out = stereo(start);
  let at = 0;
  for (const c of chunks) {
    out.l.set(c.l, at);
    out.r.set(c.r, at);
    at += c.l.length;
  }
  return { ...out, bars: spans };
}

/** Level of the bars of full sections over the bars of sparse ones, dB. */
function contrast(s: ReturnType<typeof mixdown>): number {
  const level = (pick: (i: number) => boolean) => {
    const bars = s.bars.filter((b) => pick(b.intensity) && b.from > 12 * SR);
    return Math.sqrt(bars.reduce((a, b) => a + rms(s, b.from, b.to) ** 2, 0) / Math.max(1, bars.length));
  };
  return db(level((i) => i >= 0.7) / level((i) => i <= 0.45));
}

test("the weighted mix has more sub, a mono low end and more contrast between sections than the plain one, on real pieces", () => {
  for (const id of ["funk", "liquid_dnb", "synthwave"]) {
    // (Past the first bars, where the old leveller is still finding its gains.)
    const body = (s: Stereo) => slice(s, 12 * SR, s.l.length);
    const a = mixdown(id, "weigh", 90, false);
    const b = mixdown(id, "weigh", 90, true);
    const plain = measureWeight(body(a), SR);
    const heavy = measureWeight(body(b), SR);
    console.log(`${id}: full sections over sparse ones, plain ${contrast(a).toFixed(1)} dB, weighted ${contrast(b).toFixed(1)} dB`);
    assert.ok(contrast(b) > contrast(a) + 1, `${id}: section contrast`);
    const line = (m: typeof plain) => `crest ${m.crest.toFixed(1)} dB, range ${m.range.toFixed(1)} dB, sub ${(m.sub * 100).toFixed(1)}%, low-mid ${(m.lowMid * 100).toFixed(1)}%, low corr ${m.lowCorrelation.toFixed(2)}`;
    console.log(`${id}\n  plain    ${line(plain)}\n  weighted ${line(heavy)}`);
    assert.ok(heavy.sub > plain.sub, `${id}: sub share ${plain.sub.toFixed(3)} -> ${heavy.sub.toFixed(3)}`);
    assert.ok(heavy.lowCorrelation > 0.97, `${id}: low end correlation ${heavy.lowCorrelation.toFixed(2)}`);
    assert.ok(heavy.sub < plain.sub + 0.2, `${id}: the low end does not swallow the mix`);
    assert.ok(bandShare(body(b), SR, 0, 30) < 0.1, "no runaway rumble");
  }
});

// --- Touch and gestures --------------------------------------------------------------

/** Share of a note's energy above 1.5 kHz. */
const bright = (n: ScoreNote, touch: boolean) => {
  const s = stereo(SR);
  renderSynthNote(s, n, SR, "funk", undefined, touch);
  return bandShare(s, SR, 1500, Infinity);
};

test("with touch, velocity changes the tone of synth voices and drums, not only their level", () => {
  for (const [name, part] of [["synth bass", { role: "bass", program: 38, key: 36 }], ["saw lead", { role: "lead", program: 81, key: 60 }], ["brass", { role: "lead", program: 61, key: 60 }]] as const) {
    const note = (vel: number): ScoreNote => ({ t: 0, dur: 0.4, vel, ch: 0, ...part });
    const plainSpread = bright(note(120), false) / bright(note(45), false);
    const touchSpread = bright(note(120), true) / bright(note(45), true);
    assert.ok(touchSpread > plainSpread * 1.3, `${name}: hard over soft brightness ${plainSpread.toFixed(2)} without touch, ${touchSpread.toFixed(2)} with`);
  }
  const kick = (vel: number): ScoreNote => ({ t: 0, dur: 0.1, vel, ch: 9, role: "drums", program: 0, key: 36 });
  assert.ok(bright(kick(125), true) / bright(kick(50), true) > 1.5 * (bright(kick(125), false) / bright(kick(50), false)), "a hard kick clicks");
});

test("a slide starts off pitch and arrives, a swell grows, and a plain note is untouched", () => {
  const note: ScoreNote = { t: 0.1, dur: 0.8, key: 57, vel: 100, ch: 0, role: "lead", program: 81 };
  const render = (n: ScoreNote) => {
    const s = stereo(SR * 2);
    renderSynthNote(s, n, SR, "funk");
    return s;
  };
  const crossings = (s: Stereo, from: number, to: number) => {
    let c = 0;
    for (let i = Math.round(from * SR) + 1; i < to * SR; i++) if (s.l[i - 1]! <= 0 && s.l[i]! > 0) c++;
    return c / (to - from);
  };
  const plain = render(note);
  const slid = render({ ...note, gesture: "slide", curves: { bend: [[0, -2], [0.2, 0]] } });
  // Two semitones under at the start (about 11% slower), on pitch by the end of the curve.
  const early = crossings(slid, 0.1, 0.16) / crossings(plain, 0.1, 0.16);
  assert.ok(early > 0.86 && early < 0.95, `starts at ${early.toFixed(3)} of the pitch`);
  const late = crossings(slid, 0.4, 0.8) / crossings(plain, 0.4, 0.8);
  assert.ok(Math.abs(late - 1) < 0.02, `arrives (${late.toFixed(3)})`);

  const swelled = render({ ...note, gesture: "swell", curves: { level: [[0, 0.5], [0.5, 1]] } });
  assert.ok(db(rms(swelled, 0.12 * SR, 0.2 * SR) / rms(plain, 0.12 * SR, 0.2 * SR)) < -8, "starts soft");
  assert.ok(Math.abs(db(rms(swelled, 0.7 * SR, 0.85 * SR) / rms(plain, 0.7 * SR, 0.85 * SR))) < 0.2, "ends at full level");

  const accented = render({ ...note, gesture: "accent" });
  assert.deepEqual(accented.l, plain.l);
});

test("a choked open hi-hat stops where it is cut, in the synth kit and in a sampled one", () => {
  const hat: ScoreNote = { t: 0, dur: 0.12, key: 46, vel: 100, ch: 9, role: "drums", program: 0 };
  const open = stereo(SR);
  const choked = stereo(SR);
  renderSynthNote(open, hat, SR, "funk");
  renderSynthNote(choked, { ...hat, gesture: "choke" }, SR, "funk");
  assert.ok(rms(open, 0.2 * SR, 0.3 * SR) > 0.001);
  assert.ok(rms(choked, 0.2 * SR, 0.3 * SR) < rms(open, 0.2 * SR, 0.3 * SR) / 100);
  assert.deepEqual(choked.l.slice(0, 0.1 * SR), open.l.slice(0, 0.1 * SR));

  const data: SampleData = { channels: [new Float32Array(SR).fill(0.5)], sampleRate: SR };
  const plan: PlannedNote = { zones: [{ url: "x", rate: 1, gain: 1, offset: 0 }], release: 0.05, sustain: false, drum: true };
  const sampled = stereo(SR);
  renderSampleNote(sampled, { ...hat, gesture: "choke" }, plan, () => data, SR);
  assert.ok(rms(sampled, 0.05 * SR, 0.1 * SR) > 0.1 && rms(sampled, 0.25 * SR, 0.3 * SR) < 1e-3);
});

test("a sampled note with a low-pass corner is duller, and the recordings touch swaps in are ones the site serves", () => {
  const data: SampleData = { channels: [new Float32Array(SR)], sampleRate: SR };
  for (let i = 0; i < SR; i++) data.channels[0]![i] = 0.3 * Math.sin(i * 0.03) + 0.3 * Math.sin(i * 1.5);
  const note: ScoreNote = { t: 0, dur: 0.5, key: 60, vel: 127, ch: 0, role: "pad", program: 48 };
  const plan: PlannedNote = { zones: [{ url: "x", rate: 1, gain: 1, offset: 0 }], release: 0.2, sustain: false, drum: false };
  const full = stereo(SR);
  const dull = stereo(SR);
  renderSampleNote(full, note, plan, () => data, SR);
  renderSampleNote(dull, note, { ...plan, lowpass: 900 }, () => data, SR);
  assert.ok(bandShare(dull, SR, 3000, Infinity) < bandShare(full, SR, 3000, Infinity) / 4);

  for (const url of TOUCH_SAMPLES) assert.ok(existsSync(`styles/samples/${decodeURIComponent(mirrorPath(url)!)}`), `${url} is among the samples the site serves`);
});
