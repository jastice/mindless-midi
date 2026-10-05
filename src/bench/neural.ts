/**
 * Approach 3: neural timbre for the melody. Google Magenta's DDSP models
 * (violin, flute, tenor sax, trumpet; ~4-7 MB each) turn pitch and loudness
 * curves into audio. The curves are performed from the score: attacks,
 * tonguing vs slurs, glides, scoops, delayed vibrato, phrase swells. Runs on
 * WebGL via TensorFlow.js; the accompaniment stays sampled.
 */
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-webgl";
import { type GraphModel, loadGraphModel, registerOp } from "@tensorflow/tfjs-converter";
import type { LeadId, ScoreNote } from "./score.js";
import { Noise, type Stereo } from "./dsp.js";

const CHECKPOINTS = "https://storage.googleapis.com/magentadata/js/checkpoints/ddsp/";
const FPS = 250;
const MODEL_SR = 16000;
const HOP = MODEL_SR / FPS;
const SILENT = -120;

interface Settings {
  averageMaxLoudness: number;
  meanLoudness: number;
  postGain: number;
  modelMaxFrameLength: number;
}

interface Performance {
  attack: number;
  release: number;
  vibRate: number;
  vibCents: number;
  scoop: number;
}

const STYLE: Record<LeadId, Performance> = {
  violin: { attack: 0.07, release: 0.12, vibRate: 5.8, vibCents: 24, scoop: 0 },
  flute: { attack: 0.05, release: 0.1, vibRate: 5.0, vibCents: 14, scoop: -10 },
  tenor_saxophone: { attack: 0.035, release: 0.09, vibRate: 5.3, vibCents: 18, scoop: -35 },
  trumpet: { attack: 0.03, release: 0.08, vibRate: 5.5, vibCents: 12, scoop: -25 },
};

let opsRegistered = false;
const models = new Map<LeadId, Promise<{ model: GraphModel; settings: Settings; bytes: number }>>();

function load(id: LeadId): Promise<{ model: GraphModel; settings: Settings; bytes: number }> {
  let p = models.get(id);
  if (!p) {
    p = (async () => {
      if (!opsRegistered) {
        // The checkpoints use tf.roll, which TF.js lacks; this is the half-roll the graph needs.
        registerOp("Roll", (node) => {
          const [a, b] = tf.split(node.inputs[0]!, 2, 2);
          const out = tf.concat([b!, a!], 2);
          a!.dispose();
          b!.dispose();
          return out;
        });
        tf.env().set("WEBGL_PACK", false);
        tf.env().set("WEBGL_CONV_IM2COL", false);
        await tf.setBackend("webgl");
        await tf.ready();
        opsRegistered = true;
      }
      let bytes = 0;
      const counting = async (input: RequestInfo | URL, init?: RequestInit) => {
        const r = await fetch(input, init);
        bytes += (await r.clone().arrayBuffer()).byteLength;
        return r;
      };
      const settings = (await counting(`${CHECKPOINTS}${id}/settings.json`).then((r) => r.json())) as Settings;
      const model = await loadGraphModel(`${CHECKPOINTS}${id}/model.json`, { fetchFunc: counting });
      return { model, settings, bytes };
    })();
    models.set(id, p);
  }
  return p;
}

/** Pitch (Hz) and loudness (dB) curves at the model's 250 Hz frame rate. */
export function performCurves(line: ScoreNote[], seconds: number, id: LeadId, s: Settings): { f0: Float32Array; ld: Float32Array } {
  const perf = STYLE[id];
  const frames = Math.ceil((seconds + 1) * FPS);
  const midi = new Float32Array(frames).fill(NaN);
  const ld = new Float32Array(frames).fill(SILENT);
  const noise = new Noise(4242);
  let drift = 0;
  let prevLevel = SILENT;
  for (let i = 0; i < line.length; i++) {
    const n = line[i]!;
    const prev = line[i - 1];
    const slurredIn = !!prev?.legato && Math.abs(prev.t + prev.dur - n.t) < 0.03;
    const v = n.vel / 127;
    const peak = Math.min(s.averageMaxLoudness, s.meanLoudness + 5 + (v - 0.6) * 14);
    const start = Math.round(n.t * FPS);
    const end = Math.round((n.t + n.dur) * FPS);
    // Tongued repeated notes dip harder than slurs between steps.
    const step = prev ? Math.abs(n.key - prev.key) : 99;
    const from = slurredIn ? prevLevel - (step === 0 ? 8 : step <= 2 ? 1.5 : 4) : SILENT + 40;
    const attack = (slurredIn ? 0.02 : perf.attack) * FPS;
    for (let f = start; f < Math.min(frames, end); f++) {
      const t = (f - start) / FPS;
      let level: number;
      if (f - start < attack) level = from + ((peak - from) * (f - start)) / attack;
      else level = peak - 2.5 * (1 - Math.exp(-(t - attack / FPS) / 0.3));
      if (n.dur > 1) level += 2 * Math.sin((Math.PI * t) / n.dur);
      ld[f] = level;
      prevLevel = level;
      // Pitch: glide in from a slurred note, scoop into a tongued one, delayed vibrato, slow drift.
      let m = n.key;
      if (slurredIn) m += (prev!.key - n.key) * Math.exp(-t / 0.035);
      else m += (perf.scoop / 100) * Math.exp(-t / 0.03);
      if (n.dur > 0.4 && t > 0.25) {
        const depth = perf.vibCents * Math.min(1, (t - 0.25) / 0.35);
        m += (depth / 100) * Math.sin(2 * Math.PI * perf.vibRate * t);
      }
      drift = 0.995 * drift + 0.02 * noise.next();
      midi[f] = m + drift * 0.04;
    }
    if (!n.legato) {
      const rel = perf.release * FPS;
      for (let f = end; f < Math.min(frames, end + rel); f++) {
        ld[f] = prevLevel + ((SILENT + 30 - prevLevel) * (f - end)) / rel;
        midi[f] = n.key;
      }
    }
  }
  // Rests hold the upcoming pitch so onsets start clean; the tail holds the last one.
  let next = line[line.length - 1]?.key ?? 60;
  for (let f = frames - 1; f >= 0; f--) {
    if (Number.isNaN(midi[f]!)) midi[f] = next;
    else next = midi[f]!;
  }
  const f0 = new Float32Array(frames);
  for (let f = 0; f < frames; f++) f0[f] = 440 * Math.pow(2, (midi[f]! - 69) / 12);
  return { f0, ld };
}

export interface NeuralReport {
  bytes: number;
  inferMs: number;
  /** First inference on this page (pays for WebGL shader compilation). */
  cold: boolean;
}

let warmed = false;

/** Synthesize the lead line; returns a mono stem at `sr`. */
export async function renderNeuralLead(line: ScoreNote[], seconds: number, id: LeadId, sr: number, onProgress?: (f: number) => void): Promise<{ stem: Stereo; report: NeuralReport }> {
  const { model, settings, bytes } = await load(id);
  const { f0, ld } = performCurves(line, seconds, id, settings);
  const win = settings.modelMaxFrameLength;
  const overlap = FPS;
  const hop = win - overlap;
  const total = f0.length;
  const audio = new Float32Array(total * HOP);
  const t0 = performance.now();
  for (let start = 0; start < total; start += hop) {
    const f0c = new Float32Array(win);
    const ldc = new Float32Array(win).fill(SILENT);
    for (let i = 0; i < win; i++) {
      f0c[i] = f0[Math.min(total - 1, start + i)]!;
      if (start + i < total) ldc[i] = ld[start + i]!;
    }
    const out = tf.tidy(() => model.predict({ f0_hz: tf.tensor1d(f0c), loudness_db: tf.tensor1d(ldc) }) as tf.Tensor);
    const chunk = (await out.data()) as Float32Array;
    out.dispose();
    // Linear crossfade over the overlap with the previous chunk.
    const base = start * HOP;
    const fade = start === 0 ? 0 : overlap * HOP;
    for (let i = 0; i < chunk.length && base + i < audio.length; i++) {
      const s = chunk[i]! * settings.postGain;
      audio[base + i] = i < fade ? audio[base + i]! * (1 - i / fade) + s * (i / fade) : s;
    }
    onProgress?.(Math.min(1, (start + hop) / total));
    if (start + win >= total) break;
  }
  const inferMs = performance.now() - t0;
  const cold = !warmed;
  warmed = true;

  // Resample 16 kHz -> sr with the browser's resampler.
  const frames = Math.ceil((audio.length / MODEL_SR) * sr);
  const ctx = new OfflineAudioContext(1, frames, sr);
  const buf = ctx.createBuffer(1, audio.length, MODEL_SR);
  buf.copyToChannel(audio, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const mono = (await ctx.startRendering()).getChannelData(0);
  return { stem: { l: mono, r: mono.slice() }, report: { bytes, inferMs, cold } };
}
