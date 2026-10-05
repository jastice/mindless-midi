/**
 * Approach 2: multi-sampled instruments. Piano, Rhodes, mallets, upright bass
 * and tenor sax come from free SFZ libraries (velocity layers, round robins,
 * crossfades); everything else falls back to a General MIDI soundfont with a
 * sample per semitone. Notes are scheduled into an OfflineAudioContext, one
 * stem per role.
 */
import type { Role } from "../corpus/constants.js";
import type { Score, ScoreNote } from "./score.js";
import { TAIL_SECONDS } from "./synth.js";
import { type Stereo, yieldToUi } from "./dsp.js";

const DANIGB = "https://danigb.github.io/samples/";
const GLEITZ = "https://gleitz.github.io/midi-js-soundfonts/";

export type Soundfont = "MusyngKite" | "FluidR3_GM";

/** Downloads and decodes sample files once per page; tracks bytes for the report. */
export class SampleCache {
  private readonly buffers = new Map<string, Promise<{ buffer: AudioBuffer; bytes: number }>>();
  private readonly json = new Map<string, Promise<unknown>>();
  constructor(private readonly ctx: BaseAudioContext) {}

  audio(url: string): Promise<{ buffer: AudioBuffer; bytes: number }> {
    let p = this.buffers.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${url}`);
          return r.arrayBuffer();
        })
        .then(async (data) => ({ bytes: data.byteLength, buffer: await this.ctx.decodeAudioData(data) }));
      this.buffers.set(url, p);
    }
    return p;
  }

  getJson<T>(url: string): Promise<T> {
    let p = this.json.get(url);
    if (!p) {
      p = fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        return r.json();
      });
      this.json.set(url, p);
    }
    return p as Promise<T>;
  }
}

/** One sample to play for a note. */
interface Zone {
  url: string;
  /** Playback rate (repitching). */
  rate: number;
  gain: number;
  offset: number;
}

interface Instrument {
  label: string;
  release: number;
  /** Sustained sounds loop when a note outlasts its sample. */
  sustain: boolean;
  zones(key: number, vel: number): Promise<Zone[]>;
}

// --- websfz (SFZ as JSON, as published by danigb/samples) ---------------

interface SfzRegion {
  sample: string;
  lokey: number;
  hikey: number;
  lovel: number;
  hivel: number;
  center: number;
  tune: number;
  volume: number;
  offset: number;
  xfin: [number, number] | null;
  xfout: [number, number] | null;
  seqLength: number;
  seqPosition: number;
  prefix: string;
}

const NOTE_INDEX: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function sfzKey(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const m = /^([a-gA-G])([#b]?)(-?\d+)$/.exec(v.trim());
  if (!m) return Number(v);
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]!.toLowerCase()]! + acc;
}

type Opcodes = Record<string, unknown>;

/** Conditions we don't model (pedal, CC switches, keyswitches, release triggers): skip the region. */
function playable(o: Opcodes): boolean {
  for (const k of Object.keys(o)) {
    if (/^(lo|hi)cc\d+$/.test(k) || k.startsWith("sw_") || (k === "trigger" && o[k] !== "attack")) return false;
  }
  return true;
}

async function loadSfz(cache: SampleCache, url: string): Promise<{ base: string; regions: SfzRegion[] }> {
  const doc = await cache.getJson<{ meta: { baseUrl?: string }; global?: Opcodes; groups: (Opcodes & { regions: Opcodes[]; control?: Opcodes })[] }>(url);
  const regions: SfzRegion[] = [];
  for (const g of doc.groups) {
    const { regions: rs, control, ...groupOps } = g;
    const prefix = String(control?.prefix_sfz_path ?? "");
    for (const r of rs) {
      const o: Opcodes = { ...(doc.global ?? {}), ...groupOps, ...r };
      if (!playable(o) || typeof o.sample !== "string") continue;
      const lokey = sfzKey(o.lokey ?? o.key) ?? 0;
      const hikey = sfzKey(o.hikey ?? o.key) ?? 127;
      const pair = (a: unknown, b: unknown): [number, number] | null => (a === undefined && b === undefined ? null : [Number(a ?? 0), Number(b ?? 127)]);
      regions.push({
        sample: o.sample,
        lokey,
        hikey,
        lovel: Number(o.lovel ?? 0),
        hivel: Number(o.hivel ?? 127),
        center: sfzKey(o.pitch_keycenter ?? o.key) ?? lokey,
        tune: Number(o.tune ?? 0) + 100 * Number(o.transpose ?? 0),
        volume: Number(o.volume ?? 0) + Number(o.group_volume ?? 0),
        offset: Number(o.offset ?? 0),
        xfin: pair(o.xfin_lovel, o.xfin_hivel),
        xfout: pair(o.xfout_lovel, o.xfout_hivel),
        seqLength: Number(o.seq_length ?? 1),
        seqPosition: Number(o.seq_position ?? 1),
        prefix: String(control?.prefix_sfz_path ?? prefix),
      });
    }
  }
  return { base: doc.meta.baseUrl ?? url.slice(0, url.lastIndexOf("/") + 1), regions };
}

function sfzInstrument(cache: SampleCache, label: string, url: string, release: number, sustain = false): Instrument {
  const loaded = loadSfz(cache, url);
  const rr = new Map<number, number>();
  return {
    label,
    release,
    sustain,
    async zones(key, vel) {
      const { base, regions } = await loaded;
      const counter = rr.get(key) ?? 0;
      rr.set(key, counter + 1);
      const out: Zone[] = [];
      for (const r of regions) {
        if (key < r.lokey || key > r.hikey || vel < r.lovel || vel > r.hivel) continue;
        if (r.seqLength > 1 && (counter % r.seqLength) + 1 !== r.seqPosition) continue;
        let w = 1;
        if (r.xfin) w *= ramp(vel, r.xfin[0], r.xfin[1]);
        if (r.xfout) w *= 1 - ramp(vel, r.xfout[0], r.xfout[1]);
        if (w < 0.02) continue;
        out.push({
          url: encodeURI(`${base}${r.prefix}${r.sample}.m4a`).replace(/#/g, "%23"),
          rate: Math.pow(2, (key - r.center + r.tune / 100) / 12),
          gain: Math.sqrt(w) * Math.pow(10, r.volume / 20),
          offset: r.offset,
        });
      }
      return out;
    },
  };
}

function ramp(x: number, lo: number, hi: number): number {
  if (hi <= lo) return x >= hi ? 1 : 0;
  return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
}

// --- General MIDI soundfont (one file per semitone) ---------------------

const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

function gmInstrument(cache: SampleCache, font: Soundfont, program: number, sustain: boolean, release: number): Instrument {
  const names = cache.getJson<string[]>(`${GLEITZ}${font}/names.json`);
  return {
    label: `${font} #${program}`,
    release,
    sustain,
    async zones(key) {
      const name = (await names)[program] ?? "acoustic_grand_piano";
      const k = Math.max(21, Math.min(108, key));
      const file = `${FLAT_NAMES[k % 12]}${Math.floor(k / 12) - 1}`;
      return [{ url: `${GLEITZ}${font}/${name}-mp3/${file}.mp3`, rate: Math.pow(2, (key - k) / 12), gain: 1, offset: 0 }];
    },
  };
}

// --- Drum kits ----------------------------------------------------------

const SP = `${DANIGB}sample-pi/drums/one-shots/`;
const LM2 = `${DANIGB}drum-machines/LM-2/`;
const TR808 = `${DANIGB}drum-machines/TR-808/`;

const KITS: Record<string, Record<number, string>> = {
  lofi: {
    36: `${SP}kick/drum_bass_hard.m4a`, 38: `${SP}snare/drum_snare_soft.m4a`, 37: `${SP}percussion/perc_snap.m4a`,
    39: `${SP}percussion/perc_snap2.m4a`, 42: `${SP}cymbal/drum_cymbal_closed.m4a`, 46: `${SP}cymbal/drum_cymbal_open.m4a`,
    51: `${SP}cymbal/drum_cymbal_soft.m4a`, 49: `${SP}other/drum_splash_hard.m4a`, 45: `${SP}tom/drum_tom_lo_soft.m4a`,
    50: `${SP}tom/drum_tom_hi_soft.m4a`, 70: `${LM2}cabasa.m4a`,
  },
  synthwave: {
    36: `${LM2}kick.m4a`, 38: `${LM2}snare-m.m4a`, 37: `${LM2}stick-m.m4a`, 39: `${LM2}clap.m4a`, 42: `${LM2}hhclosed.m4a`,
    46: `${LM2}hhopen.m4a`, 51: `${LM2}ride.m4a`, 49: `${LM2}crash.m4a`, 45: `${LM2}tom-l.m4a`, 50: `${LM2}tom-h.m4a`, 70: `${LM2}cabasa.m4a`,
  },
  electro_swing: {
    36: `${SP}kick/bd_haus.m4a`, 38: `${SP}snare/sn_generic.m4a`, 37: `${LM2}stick-h.m4a`, 39: `${LM2}clap.m4a`,
    42: `${TR808}hihat-close/ch.m4a`, 46: `${TR808}hihat-open/oh25.m4a`, 51: `${LM2}ride.m4a`, 49: `${LM2}crash.m4a`,
    45: `${LM2}tom-l.m4a`, 50: `${LM2}tom-h.m4a`, 70: `${LM2}tambourine.m4a`,
  },
};

function drumKit(styleId: string): Instrument {
  const kit = KITS[styleId] ?? KITS.synthwave!;
  const alias: Record<number, number> = { 35: 36, 40: 38, 44: 42, 57: 49, 59: 51, 47: 45, 48: 50 };
  return {
    label: `${styleId} kit`,
    release: 0.05,
    sustain: false,
    async zones(key) {
      const url = kit[alias[key] ?? key];
      return url ? [{ url, rate: 1, gain: 1, offset: 0 }] : [];
    },
  };
}

// --- Instrument choice --------------------------------------------------

const SUSTAINED = (p: number) => (p >= 16 && p <= 23) || (p >= 40 && p <= 95 && p !== 45 && p !== 46 && p !== 47);

function instrumentFor(cache: SampleCache, font: Soundfont, n: ScoreNote): Instrument {
  const p = n.program;
  if (p <= 2) return sfzInstrument(cache, "Splendid Grand (PD)", `${DANIGB}splendid-grand-piano/websfz.json`, 0.35);
  if (p === 4 || p === 5) return sfzInstrument(cache, "jRhodes3 (CC BY-NC)", `${DANIGB}jlearman/rhodes-mki/jrhodes3dst.websfz.json`, 0.25);
  if (p === 11) return sfzInstrument(cache, "VCSL vibraphone (CC0)", `${DANIGB}vcsl/Struck Idiophones/vibraphone-soft-mallets.websfz.json`, 0.6);
  if (p === 12) return sfzInstrument(cache, "VCSL marimba (CC0)", `${DANIGB}vcsl/Struck Idiophones/marimba.websfz.json`, 0.4);
  if (p === 32) return sfzInstrument(cache, "Smolken double bass (CC0)", `${DANIGB}dsmolken/double-bass/dsmolkenrubnerbasspizz.websfz.json`, 0.15);
  if (p === 66) return sfzInstrument(cache, "VCSL tenor sax (CC0)", `${DANIGB}vcsl/Reed Aerophones/tenor-saxophone-vibrato.websfz.json`, 0.12, true);
  return gmInstrument(cache, font, p, SUSTAINED(p), SUSTAINED(p) ? 0.4 : 0.2);
}

export interface SamplerReport {
  bytes: number;
  files: number;
  instruments: string[];
}

/**
 * Render one stem per role. `skip` leaves roles out (the neural backend
 * replaces the lead).
 */
export async function renderSampleStems(
  score: Score,
  sr: number,
  cache: SampleCache,
  font: Soundfont,
  skip: Role[] = [],
  onProgress?: (f: number) => void,
): Promise<{ stems: Map<Role, Stereo>; report: SamplerReport }> {
  const frames = Math.ceil((score.seconds + TAIL_SECONDS) * sr);
  const instruments = new Map<string, Instrument>();
  const pick = (n: ScoreNote) => {
    const id = n.role === "drums" ? "drums" : `${n.program}`;
    let inst = instruments.get(id);
    if (!inst) instruments.set(id, (inst = n.role === "drums" ? drumKit(score.style.id) : instrumentFor(cache, font, n)));
    return inst;
  };

  // Resolve zones and fetch every sample up front.
  const notes = score.notes.filter((n) => !skip.includes(n.role));
  const planned: { n: ScoreNote; inst: Instrument; zones: Zone[] }[] = [];
  for (const n of notes) {
    const inst = pick(n);
    planned.push({ n, inst, zones: await inst.zones(n.key, n.vel) });
  }
  const urls = [...new Set(planned.flatMap((p) => p.zones.map((z) => z.url)))];
  let loaded = 0;
  const buffers = new Map<string, { buffer: AudioBuffer; bytes: number }>();
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        buffers.set(url, await cache.audio(url));
      } catch (err) {
        console.warn("sample failed", url, err);
      }
      onProgress?.((0.8 * ++loaded) / urls.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const stems = new Map<Role, Stereo>();
  const roles = [...new Set(notes.map((n) => n.role))];
  for (const [ri, role] of roles.entries()) {
    const ctx = new OfflineAudioContext(2, frames, sr);
    let openHat: GainNode | null = null;
    for (const { n, inst, zones } of planned) {
      if (n.role !== role) continue;
      const vgain = Math.pow(n.vel / 127, 1.8);
      if (role === "drums" && (n.key === 42 || n.key === 44) && openHat) {
        openHat.gain.setTargetAtTime(0, n.t, 0.01);
        openHat = null;
      }
      for (const z of zones) {
        const b = buffers.get(z.url);
        if (!b) continue;
        const src = ctx.createBufferSource();
        src.buffer = b.buffer;
        src.playbackRate.value = z.rate;
        const offset = z.offset / b.buffer.sampleRate;
        const natural = (b.buffer.duration - offset) / z.rate;
        if (inst.sustain && n.dur + inst.release > natural * 0.9) {
          const [ls, le] = loopPoints(b.buffer);
          src.loop = true;
          src.loopStart = ls;
          src.loopEnd = le;
        }
        const g = ctx.createGain();
        g.gain.setValueAtTime(z.gain * vgain, n.t);
        if (role !== "drums") g.gain.setTargetAtTime(0, n.t + n.dur, inst.release / 4);
        src.connect(g).connect(ctx.destination);
        src.start(n.t, offset);
        if (role !== "drums") src.stop(n.t + n.dur + inst.release * 2);
        if (role === "drums" && n.key === 46) openHat = g;
      }
    }
    const rendered = await ctx.startRendering();
    stems.set(role, { l: rendered.getChannelData(0), r: rendered.getChannelData(1) });
    onProgress?.(0.8 + (0.2 * (ri + 1)) / roles.length);
    await yieldToUi();
  }
  const bytes = urls.reduce((a, u) => a + (buffers.get(u)?.bytes ?? 0), 0);
  return { stems, report: { bytes, files: buffers.size, instruments: [...new Set([...instruments.values()].map((i) => i.label))] } };
}

const loopCache = new WeakMap<AudioBuffer, [number, number]>();

/** A loop in the stable middle of a sample, snapped to rising zero crossings. */
function loopPoints(b: AudioBuffer): [number, number] {
  const hit = loopCache.get(b);
  if (hit) return hit;
  const d = b.getChannelData(0);
  const snap = (i: number) => {
    for (let j = i; j < d.length - 1; j++) if (d[j]! <= 0 && d[j + 1]! > 0) return j;
    return i;
  };
  const s = snap(Math.floor(d.length * 0.45));
  const e = snap(Math.floor(d.length * 0.85));
  const pts: [number, number] = e > s + 64 ? [s / b.sampleRate, e / b.sampleRate] : [0, b.duration];
  loopCache.set(b, pts);
  return pts;
}
