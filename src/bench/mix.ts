/**
 * The shared mix bus: every stem-based variant (OPL stems included) goes
 * through the same per-style production, so the comparison isolates the
 * instrument sound. Stems are level-matched by their active loudness, then
 * get high-pass cleanup, panning, score-driven sidechain ducking, chorus,
 * tempo-synced delay, a generated reverb, tape/vinyl treatment for lo-fi and
 * a glue compressor.
 */
import type { Role } from "../corpus/constants.js";
import type { Score } from "./score.js";
import { Noise, type Stereo, activeRms } from "./dsp.js";

type PerRole = Partial<Record<Role, number>>;

export interface MixPreset {
  reverb: { seconds: number; predelay: number; bright: number; send: PerRole };
  delay?: { beats: number; feedback: number; send: PerRole };
  chorus?: Role[];
  duck?: { depth: PerRole; release: number };
  lofi?: { drive: number; lowpass: number; wow: number; flutter: number; crackle: number };
  highpass: PerRole;
}

export const PRESETS: Record<string, MixPreset> = {
  minimalist: {
    reverb: { seconds: 2.8, predelay: 0.025, bright: 0.5, send: { lead: 0.32, arp: 0.3, counter: 0.35, pad: 0.45, bass: 0.15 } },
    highpass: { lead: 90, arp: 90, counter: 120, pad: 140 },
  },
  lofi: {
    reverb: { seconds: 1.2, predelay: 0.015, bright: 0.3, send: { lead: 0.25, counter: 0.2, comp: 0.18, pad: 0.3, drums: 0.06 } },
    delay: { beats: 0.75, feedback: 0.3, send: { lead: 0.18, counter: 0.1 } },
    duck: { depth: { pad: 0.35, comp: 0.25 }, release: 0.25 },
    lofi: { drive: 1.6, lowpass: 6500, wow: 0.0014, flutter: 0.00015, crackle: 0.012 },
    highpass: { lead: 150, counter: 150, comp: 120, pad: 180 },
  },
  synthwave: {
    reverb: { seconds: 2.4, predelay: 0.03, bright: 0.65, send: { lead: 0.3, counter: 0.3, arp: 0.22, pad: 0.35, comp: 0.25, drums: 0.12 } },
    delay: { beats: 0.75, feedback: 0.38, send: { lead: 0.25, counter: 0.22, arp: 0.15 } },
    chorus: ["pad", "comp"],
    duck: { depth: { pad: 0.55, comp: 0.45, arp: 0.3, bass: 0.3 }, release: 0.22 },
    highpass: { lead: 120, counter: 150, arp: 150, pad: 150, comp: 150 },
  },
  electro_swing: {
    reverb: { seconds: 1.3, predelay: 0.012, bright: 0.45, send: { lead: 0.2, counter: 0.2, pad: 0.18, comp: 0.12, arp: 0.15, drums: 0.05 } },
    duck: { depth: { pad: 0.45, comp: 0.35, arp: 0.3, bass: 0.35 }, release: 0.18 },
    lofi: { drive: 1.2, lowpass: 12000, wow: 0.0004, flutter: 0.00005, crackle: 0.006 },
    highpass: { lead: 150, counter: 150, comp: 150, pad: 160, arp: 140 },
  },
};

Object.assign(PRESETS, {
  jazz_trio: {
    reverb: { seconds: 1.4, predelay: 0.012, bright: 0.4, send: { lead: 0.18, comp: 0.18, bass: 0.06, drums: 0.12 } },
    highpass: { lead: 70, comp: 70 },
  },
  retro: {
    reverb: { seconds: 0.9, predelay: 0.01, bright: 0.5, send: { lead: 0.12, counter: 0.12, arp: 0.1, comp: 0.1 } },
    delay: { beats: 0.5, feedback: 0.25, send: { counter: 0.12, arp: 0.1 } },
    highpass: { lead: 120, counter: 150, arp: 150, comp: 150 },
  },
  metroid: {
    reverb: { seconds: 3.6, predelay: 0.04, bright: 0.35, send: { lead: 0.35, counter: 0.4, arp: 0.3, pad: 0.5, drums: 0.15 } },
    delay: { beats: 0.75, feedback: 0.42, send: { lead: 0.2, counter: 0.25, arp: 0.12 } },
    duck: { depth: { pad: 0.2 }, release: 0.3 },
    highpass: { lead: 120, counter: 150, arp: 150, pad: 120 },
  },
  monkey_island: {
    reverb: { seconds: 1.2, predelay: 0.015, bright: 0.45, send: { lead: 0.18, counter: 0.2, arp: 0.15, comp: 0.12, pad: 0.2, drums: 0.08 } },
    highpass: { lead: 120, counter: 150, arp: 120, comp: 150, pad: 150 },
  },
} satisfies Record<string, MixPreset>);

const DEFAULT_PRESET: MixPreset = { reverb: { seconds: 1.8, predelay: 0.02, bright: 0.5, send: { lead: 0.2, pad: 0.3 } }, highpass: {} };

/** Common level for a role whose corpus volume is 1. */
const STEM_REF = 0.32;

export async function mixStems(stems: Map<Role, Stereo>, score: Score, sr: number): Promise<Stereo> {
  const preset = PRESETS[score.style.id] ?? DEFAULT_PRESET;
  const frames = [...stems.values()][0]?.l.length ?? 0;
  const ctx = new OfflineAudioContext(2, frames, sr);
  const master = ctx.createGain();

  const reverbIn = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = reverbIr(ctx, preset.reverb.seconds, preset.reverb.predelay, preset.reverb.bright);
  reverbIn.connect(conv).connect(master);

  let delayIn: GainNode | null = null;
  if (preset.delay) {
    delayIn = ctx.createGain();
    const t = (60 / score.bpm) * preset.delay.beats;
    // Ping-pong: left echo feeds right and back, darkening each pass.
    const dl = ctx.createDelay(4);
    const dr = ctx.createDelay(4);
    dl.delayTime.value = t;
    dr.delayTime.value = t;
    const fb = ctx.createGain();
    fb.gain.value = preset.delay.feedback;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 3500;
    const merger = ctx.createChannelMerger(2);
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = "explicit";
    delayIn.connect(mono).connect(dl);
    dl.connect(merger, 0, 0);
    dl.connect(dr);
    dr.connect(merger, 0, 1);
    dr.connect(tone).connect(fb).connect(dl);
    merger.connect(master);
    merger.connect(reverbIn);
  }

  for (const [role, stem] of stems) {
    const inst = score.instruments.get(role);
    const rms = activeRms(stem, sr);
    if (rms < 1e-6) continue;
    const buf = ctx.createBuffer(2, frames, sr);
    buf.copyToChannel(stem.l, 0);
    buf.copyToChannel(stem.r, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const level = ctx.createGain();
    level.gain.value = ((inst?.volume ?? 0.5) * STEM_REF) / rms;
    let node: AudioNode = src.connect(level);
    const hp = preset.highpass[role];
    if (hp) {
      const f = ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = hp;
      f.Q.value = 0.6;
      node = node.connect(f);
    }
    if (preset.chorus?.includes(role)) node = chorus(ctx, node);
    const depth = preset.duck?.depth[role];
    if (depth) {
      const duck = ctx.createGain();
      for (const k of score.kicks) {
        duck.gain.setTargetAtTime(1 - depth, k, 0.004);
        duck.gain.setTargetAtTime(1, k + 0.03, preset.duck!.release / 3);
      }
      node = node.connect(duck);
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, inst?.pan ?? 0));
    node = node.connect(pan);
    node.connect(master);
    const rv = preset.reverb.send[role];
    if (rv) node.connect(gain(ctx, rv)).connect(reverbIn);
    const dv = preset.delay?.send[role];
    if (dv && delayIn) node.connect(gain(ctx, dv)).connect(delayIn);
    src.start();
  }

  let out: AudioNode = master;
  if (preset.lofi) {
    const lf = preset.lofi;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * lf.drive) / Math.tanh(lf.drive);
    }
    shaper.curve = curve;
    shaper.oversample = "2x";
    const pre = gain(ctx, 0.6);
    const post = gain(ctx, 1 / 0.6);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = lf.lowpass;
    lp.Q.value = 0.5;
    // Tape wow and flutter: a slowly modulated short delay.
    const wow = ctx.createDelay(0.05);
    wow.delayTime.value = 0.01;
    for (const [rate, depth] of [[0.55, lf.wow], [6.5, lf.flutter]] as const) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const amt = gain(ctx, depth);
      lfo.connect(amt).connect(wow.delayTime);
      lfo.start();
    }
    out = out.connect(pre).connect(shaper).connect(post).connect(lp).connect(wow);
  }
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.ratio.value = 2.5;
  comp.knee.value = 8;
  comp.attack.value = 0.02;
  comp.release.value = 0.25;
  out.connect(comp).connect(ctx.destination);
  if (preset.lofi) {
    const crackle = ctx.createBufferSource();
    crackle.buffer = vinyl(ctx, frames, preset.lofi.crackle);
    crackle.connect(ctx.destination);
    crackle.start();
  }
  const r = await ctx.startRendering();
  return { l: r.getChannelData(0), r: r.getChannelData(1) };
}

function gain(ctx: BaseAudioContext, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function chorus(ctx: BaseAudioContext, input: AudioNode): AudioNode {
  const out = ctx.createGain();
  input.connect(out);
  const merger = ctx.createChannelMerger(2);
  [0.012, 0.019].forEach((base, ch) => {
    const d = ctx.createDelay(0.05);
    d.delayTime.value = base;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.31 + ch * 0.12;
    lfo.connect(gain(ctx, 0.003)).connect(d.delayTime);
    lfo.start();
    input.connect(d).connect(gain(ctx, 0.5)).connect(merger, 0, ch);
  });
  merger.connect(out);
  return out;
}

/** A generated stereo room: sparse early reflections, then a darkening exponential tail. */
function reverbIr(ctx: BaseAudioContext, seconds: number, predelay: number, bright: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.ceil((seconds * 1.2 + predelay) * sr);
  const ir = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    const noise = new Noise(1234 + ch * 777);
    const pre = Math.round(predelay * sr);
    for (let k = 0; k < 10; k++) {
      const at = pre + Math.round((0.004 + noise.next() * 0.5 * 0.06 + 0.03) * sr);
      if (at < len) d[at] = (d[at] ?? 0) + (noise.next() * 0.6) * (1 - k / 12);
    }
    let y = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const cutoff = 1500 + bright * 9000 * Math.exp(-t / (seconds * 0.35));
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
      y += a * (noise.next() - y);
      d[i]! += y * Math.exp((-6.9 * t) / seconds) * Math.min(1, t / 0.01);
    }
  }
  return ir;
}

/** Vinyl surface: soft hiss plus sparse, filtered clicks. */
function vinyl(ctx: BaseAudioContext, frames: number, level: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = ctx.createBuffer(2, frames, sr);
  const noise = new Noise(99);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let hiss = 0;
    let click = 0;
    for (let i = 0; i < frames; i++) {
      hiss += 0.08 * (noise.next() - hiss);
      if (Math.abs(noise.next()) > 0.99985) click = (noise.next() > 0 ? 1 : -1) * (0.3 + Math.abs(noise.next()));
      click *= 0.6;
      d[i] = (hiss * 0.5 + click) * level;
    }
  }
  return b;
}
