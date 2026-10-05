/**
 * The mix bus: per-style production for every stem-based engine. Each role
 * gets high-pass cleanup, optional chorus, kick-driven ducking, panning and
 * sends to a tempo-synced ping-pong delay and a generated reverb; the master
 * has an optional tape/vinyl chain, glue compression and a limiter.
 *
 * Every per-style setting is an AudioParam change scheduled at a time, so a
 * live stream can switch styles exactly at a piece boundary. The same class
 * renders offline clips in the bench.
 */
import { ROLES, type Role } from "../corpus/constants.js";
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


export function presetFor(styleId: string): MixPreset {
  return PRESETS[styleId] ?? DEFAULT_PRESET;
}

/** Level of a role with corpus volume 1 entering the bus (RMS while sounding). */
export const STEM_REF = 0.05;
const DRIVE_CURVE = 1.6;
const NO_HIGHPASS = 10;

interface RoleChain {
  input: GainNode;
  hp: BiquadFilterNode;
  chorus: GainNode;
  duck: GainNode;
  pan: StereoPannerNode;
  reverb: GainNode;
  delay: GainNode;
}

export class Bus {
  readonly output: GainNode;
  /** Master trim before the compressor, for a live loudness AGC. */
  readonly trim: GainNode;
  /** Taps the bus output (pre-volume) for that AGC. */
  readonly meter: AnalyserNode;
  private readonly roles = new Map<Role, RoleChain>();
  private readonly reverbs: { input: GainNode; conv: ConvolverNode; style: string | null }[] = [];
  private active = 0;
  private readonly delayL: DelayNode;
  private readonly delayR: DelayNode;
  private readonly feedback: GainNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly drivePre: GainNode;
  private readonly drivePost: GainNode;
  private readonly tone: BiquadFilterNode;
  private readonly wow: GainNode[] = [];
  private readonly crackle: GainNode;
  private readonly irCache = new Map<string, AudioBuffer>();

  constructor(private readonly ctx: BaseAudioContext) {
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    const master = g();
    this.output = g();

    // Reverb: two convolvers; a style change loads the idle one and moves the
    // sends over, so the old tail rings out.
    const reverbIn = g();
    for (let i = 0; i < 2; i++) {
      const input = g(0);
      const conv = ctx.createConvolver();
      reverbIn.connect(input).connect(conv).connect(master);
      this.reverbs.push({ input, conv, style: null });
    }

    // Ping-pong delay, darkened on every pass.
    const delayIn = g();
    const mono = g();
    mono.channelCount = 1;
    mono.channelCountMode = "explicit";
    this.delayL = ctx.createDelay(4);
    this.delayR = ctx.createDelay(4);
    this.feedback = g(0);
    const darken = ctx.createBiquadFilter();
    darken.type = "lowpass";
    darken.frequency.value = 3500;
    const merger = ctx.createChannelMerger(2);
    delayIn.connect(mono).connect(this.delayL);
    this.delayL.connect(merger, 0, 0);
    this.delayL.connect(this.delayR);
    this.delayR.connect(merger, 0, 1);
    this.delayR.connect(darken).connect(this.feedback).connect(this.delayL);
    merger.connect(master);
    merger.connect(reverbIn);

    for (const role of ROLES) {
      const input = g();
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = NO_HIGHPASS;
      hp.Q.value = 0.6;
      const sum = g();
      const chorus = g(0);
      const duck = g();
      const pan = ctx.createStereoPanner();
      input.connect(hp);
      hp.connect(sum);
      // Chorus: two slowly modulated short delays, one per side.
      const wide = ctx.createChannelMerger(2);
      [0.012, 0.019].forEach((base, ch) => {
        const d = ctx.createDelay(0.05);
        d.delayTime.value = base;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.31 + ch * 0.12;
        lfo.connect(g(0.003)).connect(d.delayTime);
        lfo.start();
        hp.connect(d).connect(g(0.5)).connect(wide, 0, ch);
      });
      wide.connect(chorus).connect(sum);
      sum.connect(duck).connect(pan).connect(master);
      const reverb = g(0);
      const delay = g(0);
      pan.connect(reverb).connect(reverbIn);
      pan.connect(delay).connect(delayIn);
      this.roles.set(role, { input, hp, chorus, duck, pan, reverb, delay });
    }

    // Master: dry, or through saturation, a tone filter and tape wow.
    this.dry = g();
    this.wet = g(0);
    this.drivePre = g(0.6);
    this.drivePost = g(1 / 0.6);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * DRIVE_CURVE) / Math.tanh(DRIVE_CURVE);
    }
    shaper.curve = curve;
    shaper.oversample = "2x";
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.Q.value = 0.5;
    const tape = ctx.createDelay(0.05);
    tape.delayTime.value = 0.01;
    for (const rate of [0.55, 6.5]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const depth = g(0);
      lfo.connect(depth).connect(tape.delayTime);
      lfo.start();
      this.wow.push(depth);
    }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 2.5;
    comp.knee.value = 8;
    comp.attack.value = 0.02;
    comp.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    this.trim = g();
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 2048;
    master.connect(this.dry).connect(this.trim);
    master.connect(this.drivePre).connect(shaper).connect(this.drivePost).connect(this.tone).connect(tape).connect(this.wet).connect(this.trim);
    this.trim.connect(comp).connect(limiter).connect(this.output);
    limiter.connect(this.meter);

    this.crackle = g(0);
    const vinylSrc = ctx.createBufferSource();
    vinylSrc.buffer = vinyl(ctx, Math.round(ctx.sampleRate * 7.3));
    vinylSrc.loop = true;
    vinylSrc.connect(this.crackle).connect(this.output);
    vinylSrc.start();
  }

  input(role: Role): AudioNode {
    return this.roles.get(role)!.input;
  }

  /** Switch to a style's production at time `at` (seconds on the context clock). */
  setStyle(styleId: string, bpm: number, pans: Partial<Record<Role, number>>, at: number): void {
    const p = presetFor(styleId);
    const set = (param: AudioParam, v: number) => param.setValueAtTime(v, at);
    // Reverb: reuse the active convolver for the same style, else load the idle one.
    let idx = this.reverbs.findIndex((r) => r.style === styleId);
    if (idx < 0) {
      idx = 1 - this.active;
      const r = this.reverbs[idx]!;
      let ir = this.irCache.get(styleId);
      if (!ir) this.irCache.set(styleId, (ir = reverbIr(this.ctx, p.reverb.seconds, p.reverb.predelay, p.reverb.bright)));
      r.conv.buffer = ir;
      r.style = styleId;
    }
    this.reverbs.forEach((r, i) => set(r.input.gain, i === idx ? 1 : 0));
    this.active = idx;

    const t = p.delay ? (60 / bpm) * p.delay.beats : 0.3;
    set(this.delayL.delayTime, Math.min(3.9, t));
    set(this.delayR.delayTime, Math.min(3.9, t));
    set(this.feedback.gain, p.delay?.feedback ?? 0);
    for (const [role, c] of this.roles) {
      set(c.hp.frequency, p.highpass[role] ?? NO_HIGHPASS);
      set(c.chorus.gain, p.chorus?.includes(role) ? 1 : 0);
      set(c.pan.pan, Math.max(-1, Math.min(1, pans[role] ?? 0)));
      set(c.reverb.gain, p.reverb.send[role] ?? 0);
      set(c.delay.gain, p.delay?.send[role] ?? 0);
    }
    const lf = p.lofi;
    set(this.dry.gain, lf ? 0 : 1);
    set(this.wet.gain, lf ? 1 : 0);
    const drive = (lf?.drive ?? DRIVE_CURVE) / DRIVE_CURVE;
    set(this.drivePre.gain, 0.6 * drive);
    set(this.drivePost.gain, 1 / (0.6 * drive));
    set(this.tone.frequency, lf?.lowpass ?? 20000);
    set(this.wow[0]!.gain, lf?.wow ?? 0);
    set(this.wow[1]!.gain, lf?.flutter ?? 0);
    set(this.crackle.gain, lf?.crackle ?? 0);
  }

  /** Duck the style's ducked roles under each kick (context times). */
  duck(styleId: string, kicks: number[]): void {
    const d = presetFor(styleId).duck;
    if (!d) return;
    for (const [role, c] of this.roles) {
      const depth = d.depth[role];
      if (!depth) continue;
      for (const k of kicks) {
        c.duck.gain.setTargetAtTime(1 - depth, k, 0.004);
        c.duck.gain.setTargetAtTime(1, k + 0.03, d.release / 3);
      }
    }
  }
}

/**
 * Offline mix for the bench: stems are level-matched by their active
 * loudness over the whole clip, then played through a Bus.
 */
export async function mixStems(
  stems: Map<Role, Stereo>,
  sr: number,
  style: { id: string; bpm: number; kicks: number[]; instruments: Map<Role, { volume: number; pan: number }> },
): Promise<Stereo> {
  const frames = [...stems.values()][0]?.l.length ?? 0;
  const ctx = new OfflineAudioContext(2, frames, sr);
  const bus = new Bus(ctx);
  const pans = Object.fromEntries([...style.instruments].map(([r, i]) => [r, i.pan]));
  bus.setStyle(style.id, style.bpm, pans, 0);
  bus.duck(style.id, style.kicks);
  bus.output.connect(ctx.destination);
  for (const [role, stem] of stems) {
    const rms = activeRms(stem, sr);
    if (rms < 1e-6) continue;
    const buf = ctx.createBuffer(2, frames, sr);
    buf.copyToChannel(stem.l, 0);
    buf.copyToChannel(stem.r, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const level = ctx.createGain();
    level.gain.value = ((style.instruments.get(role)?.volume ?? 0.5) * STEM_REF) / rms;
    src.connect(level).connect(bus.input(role));
    src.start();
  }
  const r = await ctx.startRendering();
  return { l: r.getChannelData(0), r: r.getChannelData(1) };
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
function vinyl(ctx: BaseAudioContext, frames: number, level = 1): AudioBuffer {
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
