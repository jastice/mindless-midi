/**
 * Approach 1: hand-written synthesis, no downloads. Every GM program family
 * maps to a small physical or subtractive model: modal piano, FM electric
 * piano, modal mallets, Karplus-Strong plucks, PolyBLEP subtractive voices
 * (strings, pads, brass, reeds, leads, synth bass) and an analog-style kit.
 *
 * A style can bring its own sounds instead (a `SoundSet`): patches for the
 * subtractive voice, with tempo-synced movement, and a drum kit. Both are data
 * (corpus/patch.ts), as are the GM families and built-in kits (sound/patches).
 *
 * Voices render a whole note at once into a Stereo (offset by its `base`),
 * so the same code fills an offline clip or a streaming StemWindow.
 */
import { GM_DRUMS, type Role } from "../corpus/constants.js";
import type { Kit, Patch, PatchMod } from "../corpus/patch.js";
import type { ScoreNote } from "./types.js";
import { Noise, OnePole, Osc, type Stereo, Svf, adsr, mtof, stereo, yieldToUi } from "./dsp.js";
import { GM_PATCHES as GM } from "./patches/gm.js";
import { KITS } from "./patches/kits.js";
import { renderShaped } from "./shape.js";

/** Longest a synth note can ring past its onset, seconds (window sizing). */
export const MAX_VOICE_SECONDS = 9;

/** A style's own sounds: patches by name (a note names one in `patch`), and its drum kit. */
export interface SoundSet {
  patches?: Record<string, Patch>;
  kit?: Kit;
}

type Voice = (out: Stereo, n: ScoreNote, sr: number, prev: ScoreNote | undefined, touch: boolean) => void;

/**
 * Render one note (drums included) into `out`. `prev` is the previous note of the same role.
 *
 * With `touch`, velocity is how hard the note is played and not only how loud:
 * subtractive voices open their filter further and close it sooner, and drums
 * get more click, a higher strike and a longer ring. A note's curves (a slide,
 * a swell) are played either way.
 *
 * With `sound`, drums play its kit and a note that names one of its patches
 * plays that; anything else is the built-in kit for `styleId` and the note's
 * GM program, as without it.
 */
export function renderSynthNote(out: Stereo, n: ScoreNote, sr: number, styleId: string, prev?: ScoreNote, touch = false, sound?: SoundSet): void {
  const patch = n.patch !== undefined && n.role !== "drums" ? sound?.patches?.[n.patch] : undefined;
  if (n.role === "drums") drum(out, n, sr, sound?.kit ?? KITS[styleId] ?? KITS.default!, touch);
  else if (patch) renderPatched(out, n, sr, patch, prev, touch);
  // A slide is the note's own glide: don't also glide from the previous note.
  else if (n.curves) renderShaped(out, n, sr, (o, m) => voiceFor(m.program)(o, m, sr, m.curves?.bend ? undefined : prev, touch));
  else voiceFor(n.program)(out, n, sr, prev, touch);
}

/** A note on a declared patch. With `glide` the voice plays a slide itself; a swell (and a slide without glide) is read back along the curve. */
function renderPatched(out: Stereo, n: ScoreNote, sr: number, patch: Patch, prev: ScoreNote | undefined, touch: boolean): void {
  const voice = sub(patch, true);
  const curves = n.curves;
  const glides = patch.glide !== undefined;
  if (!curves || (!curves.level && (glides || !curves.bend))) return voice(out, n, sr, prev, touch);
  const shaped: ScoreNote = glides ? { ...n, curves: { ...(curves.level && { level: curves.level }) } } : n;
  renderShaped(out, shaped, sr, (o) => voice(o, n, sr, glides || !curves.bend ? prev : undefined, touch));
}

/** Whether a note plays one of the style's own sounds: only the synth has those, so it plays the note under the samples engine too. */
export function playsDeclared(n: ScoreNote, sound: SoundSet | undefined): boolean {
  if (!sound) return false;
  return n.role === "drums" ? sound.kit !== undefined : n.patch !== undefined && sound.patches?.[n.patch] !== undefined;
}

/** A style's declared sounds as the synth takes them. Undefined for a style with none, which is every style of the other apps. */
export function styleSound(corpus: { patches?: (Patch & { id: string })[] | undefined; synthKit?: Kit | undefined }): SoundSet | undefined {
  if (!corpus.patches?.length && !corpus.synthKit) return undefined;
  return {
    ...(corpus.patches?.length && { patches: Object.fromEntries(corpus.patches.map((p) => [p.id, p])) }),
    ...(corpus.synthKit && { kit: corpus.synthKit }),
  };
}

/** Offline: every note of a clip, one stem per role. */
export async function renderSynthStems(notes: ScoreNote[], frames: number, styleId: string, sr: number, onProgress?: (f: number) => void, sound?: SoundSet): Promise<Map<Role, Stereo>> {
  const stems = new Map<Role, Stereo>();
  const prevByRole = new Map<Role, ScoreNote>();
  let done = 0;
  for (const n of notes) {
    let out = stems.get(n.role);
    if (!out) stems.set(n.role, (out = stereo(frames)));
    renderSynthNote(out, n, sr, styleId, prevByRole.get(n.role), false, sound);
    prevByRole.set(n.role, n);
    if (++done % 64 === 0) {
      onProgress?.(done / notes.length);
      await yieldToUi();
    }
  }
  return stems;
}

function voiceFor(program: number): Voice {
  if (program <= 3) return piano;
  if (program <= 5) return epiano;
  if (program <= 7) return pluck({ bright: 0.92, t60: program === 7 ? 0.7 : 1.8, pick: 0.12 });
  if (program <= 15) return mallet(program);
  if (program <= 23) return organ;
  if (program === 28) return pluck({ bright: 0.6, t60: 0.25, pick: 0.2 });
  if (program <= 31) return pluck(program === 24 ? { bright: 0.45, t60: 3, pick: 0.2 } : { bright: 0.72, t60: 2.4, pick: 0.15 });
  if (program <= 37) return pluck({ bright: program === 34 ? 0.5 : 0.28, t60: 2.6, pick: 0.25, thump: 0.5 });
  if (program <= 39) return sub(GM.synth_bass);
  if (program <= 41) return sub(GM.violin);
  if (program === 45) return pluck({ bright: 0.4, t60: 0.5, pick: 0.3 });
  if (program === 46) return pluck({ bright: 0.55, t60: 3.5, pick: 0.1 });
  if (program <= 47) return sub(GM.low_strings);
  if (program <= 51) return sub(program === 49 ? GM.slow_strings : GM.strings);
  if (program <= 55) return sub(GM.choir);
  if (program === 59) return sub(GM.muted_trumpet);
  if (program <= 63) return sub(program === 61 || program === 62 ? GM.synth_brass : GM.brass);
  if (program <= 67) return sub(GM.sax);
  if (program <= 70) return sub(GM.oboe);
  if (program === 71) return sub(GM.clarinet);
  if (program <= 79) return sub(GM.flute);
  if (program === 80) return sub(GM.square_lead);
  if (program <= 87) return sub(GM.saw_lead);
  if (program === 90) return sub(GM.poly);
  if (program === 91) return sub(GM.choir);
  if (program === 98 || program === 112) return mallet(program);
  if (program >= 104 && program <= 107) return pluck({ bright: 0.7, t60: 2, pick: 0.15 });
  if (program >= 113 && program <= 119) return mallet(program);
  if (program === 109) return sub(GM.oboe);
  return sub(GM.pad);
}

// --- Modal piano --------------------------------------------------------

const piano: Voice = (out, n, sr) => {
  const f = mtof(n.key);
  const v = n.vel / 127;
  const B = Math.min(0.004, Math.max(0.00005, 0.0001 * Math.pow(2, (n.key - 48) / 18)));
  const t60 = Math.min(14, Math.max(0.6, 12 * Math.pow(2, -(n.key - 21) / 16)));
  const K = Math.max(1, Math.min(12, Math.floor(9000 / f)));
  const damped = n.key < 89;
  const len = Math.ceil(Math.min(n.dur + (damped ? 0.35 : 1.5), t60, MAX_VOICE_SECONDS) * sr);
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const offFrame = Math.round(n.dur * sr);
  const damp = Math.exp(-6.9 / (0.16 * sr));
  // Per partial: two rotating phasors (detuned strings), two-stage decay.
  type P = { c1: number; s1: number; cw1: number; sw1: number; c2: number; s2: number; cw2: number; sw2: number; amp: number; e1: number; e2: number; d1: number; d2: number };
  const parts: P[] = [];
  for (let k = 1; k <= K; k++) {
    const fk = k * f * Math.sqrt(1 + B * k * k);
    if (fk > sr * 0.45) break;
    const amp = Math.abs(Math.sin(Math.PI * k * 0.13)) / Math.pow(k, 1.7 - 0.9 * v);
    const tk = t60 / (1 + 0.45 * (k - 1));
    const beat = k <= 6 ? 0.35 * Math.sqrt(k) : 0;
    const w1 = (2 * Math.PI * fk * Math.pow(2, beat / 1200)) / sr;
    const w2 = (2 * Math.PI * fk * Math.pow(2, -beat / 1200)) / sr;
    parts.push({
      c1: 1, s1: 0, cw1: Math.cos(w1), sw1: Math.sin(w1),
      c2: 1, s2: 0, cw2: Math.cos(w2), sw2: Math.sin(w2),
      amp, e1: 0.7, e2: 0.3,
      d1: Math.exp(-6.9 / (tk * 0.22 * sr)), d2: Math.exp(-6.9 / (tk * sr)),
    });
  }
  const noise = new Noise(n.key * 7919 + Math.round(n.t * 1000));
  const thump = new OnePole(sr, 400 + 1200 * v);
  const gain = 0.22 * Math.pow(v, 1.3);
  const pan = ((n.key - 64) / 40) * 0.6;
  const gl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const gr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const attack = Math.round(0.002 * sr);
  let rel = 1;
  for (let i = 0; i < len && start + i < out.l.length; i++) {
    let y = 0;
    for (const p of parts) {
      const c1 = p.c1 * p.cw1 - p.s1 * p.sw1;
      p.s1 = p.c1 * p.sw1 + p.s1 * p.cw1;
      p.c1 = c1;
      const c2 = p.c2 * p.cw2 - p.s2 * p.sw2;
      p.s2 = p.c2 * p.sw2 + p.s2 * p.cw2;
      p.c2 = c2;
      y += p.amp * (p.e1 + p.e2) * (p.s1 + p.s2);
      p.e1 *= p.d1;
      p.e2 *= p.d2;
    }
    if ((i & 1023) === 1023) for (const p of parts) renorm(p);
    if (i < 0.02 * sr) y += thump.tick(noise.next()) * 0.6 * v * (1 - i / (0.02 * sr));
    if (i < attack) y *= i / attack;
    if (damped && i > offFrame) rel *= damp;
    const s = y * gain * rel;
    out.l[start + i]! += s * gl;
    out.r[start + i]! += s * gr;
    if (rel < 1e-4) break;
  }
};

function renorm(p: { c1: number; s1: number; c2: number; s2: number }): void {
  const m1 = 1 / Math.hypot(p.c1, p.s1);
  p.c1 *= m1;
  p.s1 *= m1;
  const m2 = 1 / Math.hypot(p.c2, p.s2);
  p.c2 *= m2;
  p.s2 *= m2;
}

// --- FM electric piano --------------------------------------------------

const epiano: Voice = (out, n, sr) => {
  const f = mtof(n.key);
  const v = n.vel / 127;
  const t60 = Math.min(6, Math.max(0.8, 4 * Math.pow(2, -(n.key - 60) / 24)));
  const len = Math.ceil(Math.min(n.dur + 0.2, t60) * sr);
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const off = n.dur;
  const dt = 1 / sr;
  const gain = 0.2 * Math.pow(v, 1.1);
  for (let i = 0; i < len && start + i < out.l.length; i++) {
    const t = i * dt;
    const index = 0.4 + 2.2 * v * Math.exp(-t / 0.5);
    const mod = Math.sin(2 * Math.PI * f * t) * index;
    const bell = Math.sin(2 * Math.PI * f * 14 * t) * 0.25 * v * Math.exp(-t / 0.03);
    let env = Math.exp((-6.9 * t) / t60);
    if (t > off) env *= Math.exp((-6.9 * (t - off)) / 0.12);
    const y = (Math.sin(2 * Math.PI * f * t + mod) + bell) * env * gain * Math.min(1, t / 0.001);
    // Suitcase-style tremolo/autopan.
    const trem = Math.sin(2 * Math.PI * 4.6 * (n.t + t));
    out.l[start + i]! += y * (1 + 0.35 * trem);
    out.r[start + i]! += y * (1 - 0.35 * trem);
  }
};

// --- Modal mallets ------------------------------------------------------

function mallet(program: number): Voice {
  const spec =
    program === 12
      ? { ratios: [1, 3.93, 9.2], t60: [1.0, 0.22, 0.06], amps: [1, 0.35, 0.12], trem: 0, damp: false }
      : program === 11
        ? { ratios: [1, 3.99, 9.4], t60: [3.2, 0.9, 0.25], amps: [1, 0.22, 0.08], trem: 5.6, damp: true }
        : program === 13
          ? { ratios: [1, 3.0, 6.3], t60: [0.5, 0.18, 0.08], amps: [1, 0.4, 0.2], trem: 0, damp: false }
          : program === 114
            ? { ratios: [1, 2, 3.01, 4.02], t60: [1.1, 0.6, 0.3, 0.15], amps: [1, 0.55, 0.3, 0.12], trem: 0, damp: false }
            : program >= 115
              ? { ratios: [1, 1.6, 2.3], t60: [0.25, 0.1, 0.05], amps: [1, 0.5, 0.3], trem: 0, damp: false }
          : { ratios: [1, 2.76, 5.4, 8.93], t60: [2.0, 0.8, 0.4, 0.2], amps: [1, 0.4, 0.2, 0.1], trem: 0, damp: false };
  return (out, n, sr) => {
    const f = mtof(n.key);
    const v = n.vel / 127;
    const reg = Math.pow(2, -(n.key - 60) / 24);
    const maxT = spec.t60[0]! * reg;
    const len = Math.ceil((spec.damp ? Math.min(n.dur + 0.3, maxT) : maxT) * sr);
    const start = Math.round(n.t * sr) - (out.base ?? 0);
    const noise = new Noise(n.key * 31 + 7);
    const click = new Svf(sr);
    click.set(Math.min(8000, f * 6), 1.2);
    const gain = 0.25 * Math.pow(v, 1.2);
    for (let i = 0; i < len && start + i < out.l.length; i++) {
      const t = i / sr;
      let y = 0;
      for (let m = 0; m < spec.ratios.length; m++) {
        const fm = f * spec.ratios[m]!;
        if (fm > sr * 0.45) break;
        y += spec.amps[m]! * (0.6 + 0.6 * v * (m > 0 ? 1 : 0)) * Math.sin(2 * Math.PI * fm * t) * Math.exp((-6.9 * t) / (spec.t60[m]! * reg));
      }
      if (i < 0.006 * sr) y += click.tick(noise.next()) * 0.5 * v;
      if (spec.trem) y *= 1 - 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * spec.trem * (n.t + t)));
      if (spec.damp && t > n.dur) y *= Math.exp((-6.9 * (t - n.dur)) / 0.3);
      out.l[start + i]! += y * gain;
      out.r[start + i]! += y * gain;
    }
  };
}

// --- Drawbar organ ------------------------------------------------------

const organ: Voice = (out, n, sr) => {
  const f = mtof(n.key);
  const draw = [1, 0.8, 0.5, 0.35, 0, 0.2, 0, 0.15];
  const len = Math.ceil((n.dur + 0.06) * sr);
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const gain = 0.12 * (n.vel / 127);
  for (let i = 0; i < len && start + i < out.l.length; i++) {
    const t = i / sr;
    let y = 0;
    for (let h = 0; h < draw.length; h++) if (draw[h] && f * (h + 1) < sr * 0.45) y += draw[h]! * Math.sin(2 * Math.PI * f * (h + 1) * t);
    const env = adsr(t, n.dur, 0.008, 0.01, 1, 0.05);
    const leslie = Math.sin(2 * Math.PI * 6.2 * (n.t + t));
    out.l[start + i]! += y * env * gain * (1 + 0.2 * leslie);
    out.r[start + i]! += y * env * gain * (1 - 0.2 * leslie);
  }
};

// --- Karplus-Strong pluck ----------------------------------------------

interface PluckSpec {
  /** 0 = dark, 1 = bright. */
  bright: number;
  t60: number;
  pick: number;
  thump?: number;
}

function pluck(spec: PluckSpec): Voice {
  return (out, n, sr) => {
    const f = mtof(n.key);
    const v = n.vel / 127;
    const L = sr / f;
    const S = 0.5 - 0.45 * spec.bright * (0.7 + 0.3 * v);
    const N = Math.floor(L - S);
    const frac = L - S - N;
    const ap = (1 - frac) / (1 + frac);
    const loss = Math.pow(10, -3 / (f * spec.t60 * Math.pow(2, -(n.key - 50) / 36)));
    const releaseLoss = Math.pow(10, -3 / (f * 0.08));
    const buf = new Float32Array(N + 2);
    const noise = new Noise(n.key * 104729 + Math.round(n.t * 977));
    const exc = new OnePole(sr, 800 + 7000 * spec.bright * v);
    // Excite: filtered noise with a pick-position comb.
    const pickAt = Math.max(1, Math.round(N * spec.pick));
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) raw[i] = exc.tick(noise.next());
    for (let i = 0; i < N; i++) buf[i] = raw[i]! - 0.9 * (raw[i - pickAt] ?? 0);
    const len = Math.ceil(Math.min(n.dur + 0.15, spec.t60 * 1.2) * sr);
    const start = Math.round(n.t * sr) - (out.base ?? 0);
    const offFrame = Math.round(n.dur * sr);
    const gain = 0.5 * Math.pow(v, 1.1);
    let idx = 0;
    let last = 0;
    let apState = 0;
    let apIn = 0;
    for (let i = 0; i < len && start + i < out.l.length; i++) {
      const a = buf[idx]!;
      const b = buf[(idx + 1) % N]!;
      const lp = (1 - S) * a + S * b;
      // First-order allpass for the fractional part of the loop delay.
      const y = ap * lp + apIn - ap * apState;
      apIn = lp;
      apState = y;
      const g = i > offFrame ? releaseLoss : loss;
      buf[idx] = y * g;
      idx = (idx + 1) % N;
      let s = a;
      if (spec.thump && i < 0.04 * sr) s += spec.thump * v * Math.sin(2 * Math.PI * f * (i / sr)) * (1 - i / (0.04 * sr));
      last = s * gain;
      out.l[start + i]! += last;
      out.r[start + i]! += last;
    }
  };
}

// --- Subtractive voices -------------------------------------------------

/** Beat length assumed for a patch's modulators when a note carries no tempo, seconds. */
const DEFAULT_BEAT = 0.5;
/** Share of a modulator's period over which a square or saw edge, or a new random value, is reached (no clicks). */
const EDGE = 0.02;

/** A held random value in [-1, 1) for period `k` of modulator `salt`: the same wherever a note starts. */
function held(k: number, salt: number): number {
  let x = (Math.imul(k | 0, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 2147483648 - 1;
}

/** A modulator's value in [-1, 1] at `at` beats from the start of the track. */
export function modValue(m: PatchMod, at: number, salt = 0): number {
  const ph = at / m.beats + (m.phase ?? 0);
  const k = Math.floor(ph);
  const x = ph - k;
  switch (m.shape) {
    case "sine":
      return Math.sin(2 * Math.PI * x);
    case "saw":
      return x < 1 - EDGE ? (2 * x) / (1 - EDGE) - 1 : 1 - (2 * (x - (1 - EDGE))) / EDGE;
    case "square":
      return Math.max(-1, Math.min(1, Math.sin(2 * Math.PI * x) / (2 * Math.PI * EDGE)));
    case "random": {
      const now = held(k, salt);
      if (x >= EDGE) return now;
      const before = held(k - 1, salt);
      return before + ((now - before) * x) / EDGE;
    }
  }
}

/**
 * One subtractive voice from a patch. `designed` is a patch a style declared:
 * its slides are real glides and its accents open the filter, where a GM
 * family leaves both to the note's curves and velocity.
 *
 * A GM family uses none of the newer parts (modulators, FM, drive, stereo,
 * band and high-pass), and each is skipped outright when absent, so those
 * render the samples they always did.
 */
function sub(spec: Patch, designed = false): Voice {
  const { osc: so, filter: sf, amp: sa } = spec;
  const wave = so.wave;
  const pw0 = so.pw ?? 0.5;
  const mods = spec.mod?.length ? spec.mod : undefined;
  return (out, n, sr, prev, touch) => {
    const v = n.vel / 127;
    const f = mtof(n.key);
    // How far velocity opens the filter envelope, where the filter rests, and how fast it closes.
    const open = touch ? 0.12 + 1.2 * Math.pow(v, 1.6) : 0.4 + 0.6 * v;
    const rest = touch ? sf.cutoff * (0.6 + 0.6 * v) : sf.cutoff;
    const track = touch ? sf.keytrack * (0.6 + 0.6 * v) : sf.keytrack;
    const fD = touch ? sf.d * (1.35 - 0.7 * v) : sf.d;
    let fromKey = spec.glide && prev?.legato && Math.abs(prev.t + prev.dur - n.t) < 0.03 ? prev.key : n.key;
    // A slide on a designed patch glides in from the note before (or, with none, from where its curve starts).
    if (designed && spec.glide && n.gesture === "slide") fromKey = prev && prev.key !== n.key ? prev.key : n.key + (n.curves?.bend?.[0]?.[1] ?? -1);
    const accent = designed && n.gesture === "accent" ? spec.accent : undefined;
    const envAmt = accent ? sf.env + accent.cutoff : sf.env;
    const q = accent ? sf.q + accent.q : sf.q;
    const len = Math.ceil((n.dur + sa.r) * sr);
    const start = Math.round(n.t * sr) - (out.base ?? 0);
    const oscs = Array.from({ length: so.voices }, (_, i) => new Osc((i * 0.37 + n.key * 0.01) % 1));
    const subOsc = new Osc();
    const filt = new Svf(sr);
    const forms = (spec.formants ?? []).map(({ freq, q }) => {
      const s = new Svf(sr);
      s.set(freq, q);
      return s;
    });
    const hp = spec.hp ? new Svf(sr) : null;
    hp?.set(spec.hp!, 0.7);
    const breathFilt = new Svf(sr);
    breathFilt.set(Math.min(9000, f * 2.5), 1.5);
    const noise = new Noise(n.key * 15485863 + Math.round(n.t * 1000));
    const gain = spec.level * Math.pow(v, 1.2);
    const vib = spec.vibrato;
    const vibPhase = (n.t * 1.7) % 1;
    // The newer parts.
    const hiss = wave === "noise" ? new Noise(n.key * 7919 + Math.round(n.t * 1000) + 17) : null;
    const fm = so.fm && wave !== "noise" ? so.fm : undefined;
    let fmPhase = 0;
    const lowpass = sf.type === "low";
    const band = sf.type === "band";
    const drive = spec.drive ? 1 + spec.drive : 0;
    // Stereo: the unison's side signal runs through a filter of its own and is added left, taken away right.
    const spread = so.spread && (so.voices > 1 || hiss) ? so.spread : 0;
    const sideFilt = spread ? new Svf(sr) : null;
    const sideHiss = spread && hiss ? new Noise(n.key * 104729 + Math.round(n.t * 1000) + 29) : null;
    // Modulators run on the track's beat clock: where the note starts in beats, and how long a beat is.
    const beat = n.beat ?? DEFAULT_BEAT;
    const pos = n.pos ?? n.t / beat;
    let mCut = 0;
    let mPitch = 0;
    let mPw = 0;
    let mAmp = 0;
    let mPan = 0;
    let mWidth = 0;
    for (let i = 0; i < len && start + i < out.l.length; i++) {
      const t = i / sr;
      if (mods) {
        const at = pos + t / beat;
        mCut = mPitch = mPw = mAmp = mPan = mWidth = 0;
        for (let k = 0; k < mods.length; k++) {
          const m = mods[k]!;
          const x = m.depth * modValue(m, at, k);
          if (m.target === "cutoff") mCut += x;
          else if (m.target === "pitch") mPitch += x;
          else if (m.target === "pw") mPw += x;
          else if (m.target === "amp") mAmp += x;
          else if (m.target === "pan") mPan += x;
          else mWidth += x;
        }
      }
      // Pitch: glide from the previous note, onset scoop, delayed vibrato.
      let key = n.key;
      if (fromKey !== n.key) key = n.key + (fromKey - n.key) * Math.exp(-t / spec.glide!);
      if (mods) key += mPitch;
      let cents = 0;
      if (spec.scoop && fromKey === n.key) cents += spec.scoop * Math.exp(-t / 0.03);
      if (vib && t > vib.delay) {
        const depth = vib.depth * Math.min(1, (t - vib.delay) / 0.3);
        cents += depth * Math.sin(2 * Math.PI * (vib.rate * t + vibPhase));
      }
      const hz = mtof(key + cents / 100);
      let y = 0;
      let side = 0;
      if (hiss) {
        y = hiss.next();
        if (sideHiss) side = sideHiss.next();
      } else {
        const pw = mods ? Math.max(0.05, Math.min(0.95, pw0 + mPw)) : pw0;
        let bent = 0;
        if (fm) {
          fmPhase += (hz * fm.ratio) / sr;
          if (fmPhase >= 1) fmPhase -= Math.floor(fmPhase);
          bent = (fm.decay ? fm.amount * Math.exp(-t / fm.decay) : fm.amount) * Math.sin(2 * Math.PI * fmPhase);
        }
        for (let o = 0; o < oscs.length; o++) {
          const at = oscs.length > 1 ? (o / (oscs.length - 1)) * 2 - 1 : 0;
          const det = oscs.length > 1 ? at * so.detune : 0;
          let dt = (hz * Math.pow(2, det / 1200)) / sr;
          const osc = oscs[o]!;
          let w: number;
          if (wave === "sine") {
            // Phase modulation: the classic FM operator pair.
            const p = osc.phase;
            osc.phase += dt;
            if (osc.phase >= 1) osc.phase -= 1;
            w = Math.sin(2 * Math.PI * p + bent);
          } else {
            // Other shapes are band-limited by their step size: the operator bends the frequency instead.
            if (fm) dt = Math.min(0.45, Math.max(0, dt * (1 + bent)));
            w = wave === "saw" ? osc.saw(dt) : wave === "pulse" ? osc.pulse(dt, pw) : tri(osc, dt);
          }
          y += w;
          if (spread) side += at * w;
        }
        y /= Math.sqrt(oscs.length);
        if (spread) side /= Math.sqrt(oscs.length);
      }
      if (so.sub) y += so.sub * subOsc.pulse(hz / 2 / sr);
      if (spec.breath) y += spec.breath * breathFilt.tick(noise.next()) * 4;
      const fenv = adsr(t, n.dur, sf.a, fD, sf.s, sf.r);
      let cutoff = rest + track * hz + envAmt * fenv * open;
      if (mods) cutoff = Math.max(20, cutoff * Math.pow(2, mCut));
      filt.set(cutoff, q);
      let s: number;
      if (lowpass) s = filt.tick(y);
      else {
        filt.tick(y);
        s = band ? filt.bp / q : filt.hp;
      }
      for (let k = 0; k < forms.length; k++) s += forms[k]!.tick(y) * spec.formants![k]!.gain;
      if (hp) {
        hp.tick(s);
        s = hp.hp;
      }
      if (drive) s = Math.tanh(s * drive);
      let env = adsr(t, n.dur, sa.a, sa.d, sa.s, sa.r) * gain;
      if (mods && mAmp !== 0) env *= Math.max(0, 1 + mAmp);
      s *= env;
      if (!sideFilt && !mods) {
        out.l[start + i]! += s;
        out.r[start + i]! += s;
        continue;
      }
      let l = s;
      let r = s;
      if (sideFilt) {
        sideFilt.set(cutoff, q);
        sideFilt.tick(side);
        const width = mods ? spread * Math.max(0, 1 + mWidth) : spread;
        const e = (lowpass ? sideFilt.lp : band ? sideFilt.bp / q : sideFilt.hp) * width * env;
        l += e;
        r -= e;
      }
      if (mPan !== 0) {
        const p = Math.max(-1, Math.min(1, mPan));
        l *= 1 - p;
        r *= 1 + p;
      }
      out.l[start + i]! += l;
      out.r[start + i]! += r;
    }
  };
}

function tri(osc: Osc, dt: number): number {
  const t = osc.phase;
  osc.phase += dt;
  if (osc.phase >= 1) osc.phase -= 1;
  return 4 * Math.abs(t - 0.5) - 1;
}

// --- Drum kit -----------------------------------------------------------

const HAT_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800];

/**
 * The rumble under a kick: the kick through a small reverb (four combs), low-passed, driven and
 * low-passed again, swelling in behind the hit. Returns the wet signal alone, longer than `dry`.
 */
function rumble(dry: Float32Array, sr: number, spec: NonNullable<Kit["rumble"]>): Float32Array {
  const out = new Float32Array(dry.length + Math.ceil((spec.decay + 0.1) * sr));
  const delays = [0.0297, 0.0371, 0.0411, 0.0437].map((s) => Math.max(1, Math.round(s * sr)));
  const lines = delays.map((d) => new Float32Array(d));
  const feedback = delays.map((d) => Math.pow(10, (-3 * d) / sr / spec.decay));
  const at = delays.map(() => 0);
  const first = new Svf(sr);
  first.set(spec.cutoff, 0.7);
  const second = new Svf(sr);
  second.set(spec.cutoff, 0.7);
  const dc = new OnePole(sr, 25);
  const duck = spec.duck ?? 0.08;
  const fade = Math.round(0.05 * sr);
  for (let i = 0; i < out.length; i++) {
    const x = i < dry.length ? dry[i]! : 0;
    let y = 0;
    for (let c = 0; c < lines.length; c++) {
      const line = lines[c]!;
      const d = line[at[c]!]!;
      line[at[c]!] = x + d * feedback[c]!;
      at[c] = (at[c]! + 1) % line.length;
      y += d;
    }
    let s = Math.tanh(first.tick(y * 0.5) * 2);
    s = second.tick(s);
    s -= dc.tick(s);
    const left = out.length - i;
    out[i] = s * spec.level * (1 - Math.exp(-i / sr / duck)) * (left < fade ? left / fade : 1);
  }
  return out;
}

function drum(out: Stereo, n: ScoreNote, sr: number, kit: Kit, touch: boolean): void {
  const v = Math.pow(n.vel / 127, 1.4);
  // Touch: a harder hit has more click, starts higher and rings longer. (All 1 without it.)
  const hit = n.vel / 127;
  const snap = touch ? 0.35 + 1.5 * hit : 1;
  const strike = touch ? 0.8 + 0.35 * hit : 1;
  const ring = touch ? 0.75 + 0.4 * hit : 1;
  // A choked note (an open hi-hat closing) stops at the end of its written length.
  const cut = n.gesture === "choke" ? n.dur : Infinity;
  const choke = (t: number) => (t > cut ? Math.exp(-(t - cut) / 0.012) : 1);
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const noise = new Noise(n.key * 2654435761 + Math.round(n.t * 1000));
  const write = (len: number, pan: number, fn: (t: number, i: number) => number) => {
    const gl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const gr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const frames = Math.ceil(len * sr);
    for (let i = 0; i < frames && start + i < out.l.length; i++) {
      const s = fn(i / sr, i) * v;
      out.l[start + i]! += s * gl;
      out.r[start + i]! += s * gr;
    }
  };
  const metal = (decay: number, hpHz: number, pan: number, level: number) => {
    const oscs = HAT_FREQS.map((_, i) => new Osc(i * 0.13));
    const bp = new Svf(sr);
    bp.set(10000, 1);
    const hp = new Svf(sr);
    hp.set(hpHz, 0.7);
    write(decay * 5, pan, (t) => {
      let y = 0;
      for (let k = 0; k < oscs.length; k++) y += oscs[k]!.pulse((HAT_FREQS[k]! * kit.hatScale * 1.7) / sr);
      y = y * 0.5 + noise.next() * 0.4;
      bp.tick(y);
      hp.tick(bp.bp);
      return hp.hp * Math.exp(-t / (decay * ring)) * level * choke(t);
    });
  };
  // A declared hat: noise (and the metal's squares, to taste) through its own band and a steep high-pass.
  const hat = (h: NonNullable<Kit["hat"]>, decay: number, level: number) => {
    const oscs = h.metal > 0 ? HAT_FREQS.map((_, i) => new Osc(i * 0.13)) : [];
    const bp = new Svf(sr);
    bp.set(h.tone, h.q);
    const hp1 = new Svf(sr);
    hp1.set(h.hp, 0.54);
    const hp2 = new Svf(sr);
    hp2.set(h.hp, 1.31);
    write(decay * 6, 0.3, (t) => {
      let y = noise.next() * (1 - h.metal);
      if (oscs.length) {
        let m = 0;
        for (let k = 0; k < oscs.length; k++) m += oscs[k]!.pulse((HAT_FREQS[k]! * kit.hatScale * 1.7) / sr);
        y += m * 0.4 * h.metal;
      }
      bp.tick(y);
      hp1.tick(bp.bp);
      hp2.tick(hp1.hp);
      return hp2.hp * Math.exp(-t / (decay * ring)) * level * choke(t);
    });
  };
  // Tuned percussion takes over its lane.
  const perc = kit.perc?.find((p) => GM_DRUMS[p.lane] === n.key);
  if (perc) {
    let ph = 0;
    let mph = 0;
    write(perc.decay * 5, perc.pan, (t) => {
      const f = perc.freq * strike * Math.pow(2, (perc.bend * Math.exp(-t / perc.sweep)) / 12);
      ph += f / sr;
      let angle = 2 * Math.PI * ph;
      if (perc.fm) {
        mph += (f * perc.fm.ratio) / sr;
        angle += perc.fm.amount * Math.exp(-t / perc.decay) * Math.sin(2 * Math.PI * mph);
      }
      let y = Math.sin(angle) * Math.exp(-t / (perc.decay * ring));
      if (perc.noise && t < 0.006) y += noise.next() * perc.noise * snap * (1 - t / 0.006);
      return y * perc.level;
    });
    return;
  }
  switch (n.key) {
    case 35:
    case 36: {
      const k = kit.kick;
      const tail = k.sub;
      let ph = 0;
      const kick = !tail
        ? (t: number) => {
            const f = k.f1 + (k.f0 * strike - k.f1) * Math.exp(-t / k.sweep);
            ph += f / sr;
            const body = Math.sin(2 * Math.PI * ph) * Math.exp(-t / (k.decay * ring));
            const click = t < 0.004 ? noise.next() * (k.click * snap) * (1 - t / 0.004) : 0;
            return Math.tanh((body + click) * k.drive) * 0.8;
          }
        : (t: number) => {
            // The same sweep, with a clean tail that rises as the driven body falls and outlasts it.
            const f = k.f1 + (k.f0 * strike - k.f1) * Math.exp(-t / k.sweep);
            ph += f / sr;
            const sine = Math.sin(2 * Math.PI * ph);
            const click = t < 0.004 ? noise.next() * (k.click * snap) * (1 - t / 0.004) : 0;
            const under = sine * tail.level * (1 - Math.exp(-t / k.decay)) * Math.exp(-t / (tail.decay * ring));
            return (Math.tanh((sine * Math.exp(-t / (k.decay * ring)) + click) * k.drive) + under) * 0.8;
          };
      const length = tail ? Math.max(k.decay * 3, tail.decay * 5) : k.decay * 3;
      if (!kit.rumble) {
        write(length, 0, kick);
        break;
      }
      const dry = new Float32Array(Math.ceil(length * sr));
      for (let i = 0; i < dry.length; i++) dry[i] = kick(i / sr);
      const wet = rumble(dry, sr, kit.rumble);
      write(wet.length / sr, 0, (_, i) => (i < dry.length ? dry[i]! : 0) + (wet[i] ?? 0));
      break;
    }
    case 38:
    case 40: {
      const s = kit.snare;
      const hp = new Svf(sr);
      hp.set(s.noiseHp, 0.8);
      write(0.6, 0.05, (t) => {
        const tone = (Math.sin(2 * Math.PI * (s.tone * strike) * t) + 0.5 * Math.sin(2 * Math.PI * (s.tone * strike) * 1.73 * t)) * Math.exp(-t / s.toneDecay);
        hp.tick(noise.next());
        const nz = hp.hp * Math.exp(-t / (s.noiseDecay * ring));
        return (tone * (1 - s.mix) + nz * s.mix) * 0.7;
      });
      break;
    }
    case 37: {
      const bp = new Svf(sr);
      bp.set(1700, 3);
      write(0.08, 0.1, (t) => {
        bp.tick(noise.next());
        return (bp.bp * 2 + Math.sin(2 * Math.PI * 820 * t)) * Math.exp(-t / 0.012) * 0.5;
      });
      break;
    }
    case 39: {
      const c = kit.clap;
      const bp = new Svf(sr);
      if (!c) {
        bp.set(1200, 1.5);
        write(0.4, -0.1, (t) => {
          bp.tick(noise.next());
          const bursts = t < 0.03 ? Math.exp(-(t % 0.01) / 0.003) : Math.exp(-(t - 0.03) / 0.12);
          return bp.bp * bursts * 1.6;
        });
        break;
      }
      const pre = (c.bursts - 1) * 0.01;
      bp.set(c.tone, c.q);
      write(pre + c.decay * 5, -0.1, (t) => {
        bp.tick(noise.next());
        const bursts = t < pre ? Math.exp(-(t % 0.01) / 0.003) : Math.exp(-(t - pre) / (c.decay * ring));
        return bp.bp * bursts * 1.6;
      });
      break;
    }
    case 42:
    case 44:
      if (kit.hat) hat(kit.hat, kit.hat.decay, 0.5);
      else metal(kit.hatDecay, 7000, 0.3, 0.55);
      break;
    case 46:
      if (kit.hat) hat(kit.hat, kit.hat.open, 0.42);
      else metal(0.28, 7000, 0.3, 0.45);
      break;
    case 51:
    case 59:
      if (kit.ride) metal(kit.ride.decay, kit.ride.hp, -0.35, kit.ride.level);
      else metal(0.9, 4500, -0.35, 0.3);
      break;
    case 49:
    case 57:
      metal(1.4, 3500, -0.4, 0.45);
      break;
    case 45:
    case 47:
    case 48:
    case 50: {
      const f0 = n.key >= 48 ? (kit.toms?.high ?? 190) : (kit.toms?.low ?? 120);
      let ph = 0;
      write(0.8, n.key >= 48 ? 0.25 : -0.25, (t) => {
        ph += (f0 * (1 + 0.5 * Math.exp(-t / 0.03))) / sr;
        return Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.22) * 0.7;
      });
      break;
    }
    default: {
      // Shaker and anything else: a short swell of high noise.
      const hp = new Svf(sr);
      hp.set(6000, 0.7);
      write(0.12, 0.4, (t) => {
        hp.tick(noise.next());
        return hp.hp * Math.min(1, t / 0.015) * Math.exp(-t / 0.04) * 0.4;
      });
    }
  }
}
