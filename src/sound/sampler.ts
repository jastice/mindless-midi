/**
 * Approach 2: multi-sampled instruments. Piano, electric piano, mallets,
 * upright bass and tenor sax come from free SFZ libraries (velocity layers,
 * round robins, crossfades); everything else falls back to a General MIDI
 * soundfont with a sample per semitone; drums use per-style kits.
 *
 * Split in two so playback can run in a worker: `SampleLibrary` (main thread:
 * resolves notes to sample zones, downloads and decodes them) and
 * `renderSampleNote` (pure: mixes decoded sample data into a Stereo).
 */
import type { ScoreNote } from "./types.js";
import type { Samples, Stereo } from "./dsp.js";

const DANIGB = "https://danigb.github.io/samples/";
const GLEITZ = "https://gleitz.github.io/midi-js-soundfonts/";

export type Soundfont = "MusyngKite" | "FluidR3_GM";

/** Decoded audio, transferable to a worker. */
export interface SampleData {
  channels: Samples[];
  sampleRate: number;
}

/** Downloads and decodes sample files once per page; tracks bytes for reports. */
export class SampleCache {
  private readonly buffers = new Map<string, Promise<{ data: SampleData; bytes: number }>>();
  private readonly json = new Map<string, Promise<unknown>>();
  constructor(private readonly ctx: BaseAudioContext) {}

  audio(url: string): Promise<{ data: SampleData; bytes: number }> {
    let p = this.buffers.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${url}`);
          return r.arrayBuffer();
        })
        .then(async (raw) => {
          const bytes = raw.byteLength; // decodeAudioData detaches `raw`
          const b = await this.ctx.decodeAudioData(raw);
          const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice());
          return { bytes, data: { channels, sampleRate: b.sampleRate } };
        });
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
export interface Zone {
  url: string;
  /** Playback rate (repitching). */
  rate: number;
  gain: number;
  /** Start offset, frames of the decoded sample. */
  offset: number;
}

/** Everything the renderer needs for one note. */
export interface PlannedNote {
  zones: Zone[];
  release: number;
  /** Loop the sample when the note outlasts it. */
  sustain: boolean;
  drum: boolean;
  /** Drums: stop at this time (open hi-hat choked by a closed one), seconds. */
  cut?: number;
}

interface Instrument {
  label: string;
  release: number;
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

async function loadSfz(cache: SampleCache, url: string, samplePath = ""): Promise<{ base: string; regions: SfzRegion[] }> {
  const doc = await cache.getJson<{ meta: { baseUrl?: string }; global?: Opcodes; groups: (Opcodes & { regions: Opcodes[]; control?: Opcodes })[] }>(url);
  const regions: SfzRegion[] = [];
  // A <control> header applies to every group after it, not just its own.
  let prefix = "";
  for (const g of doc.groups) {
    const { regions: rs, control, ...groupOps } = g;
    if (control?.prefix_sfz_path !== undefined) prefix = String(control.prefix_sfz_path);
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
        prefix: samplePath + prefix,
      });
    }
  }
  return { base: doc.meta.baseUrl ?? url.slice(0, url.lastIndexOf("/") + 1), regions };
}

function sfzInstrument(cache: SampleCache, label: string, url: string, release: number, sustain = false, samplePath = ""): Instrument {
  const loaded = loadSfz(cache, url, samplePath);
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
    label: font === "MusyngKite" ? "MusyngKite GM soundfont (CC BY-SA 3.0)" : "FluidR3 GM soundfont (MIT)",
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
const RZ1 = `${DANIGB}drum-machines/Casio-RZ1/`;

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
  jazz_trio: {
    36: `${SP}kick/drum_bass_soft.m4a`, 38: `${SP}snare/drum_snare_soft.m4a`, 37: `${SP}percussion/perc_snap.m4a`,
    42: `${SP}cymbal/drum_cymbal_pedal.m4a`, 46: `${SP}cymbal/drum_cymbal_open.m4a`, 51: `${LM2}ride.m4a`,
    49: `${SP}other/drum_splash_hard.m4a`, 45: `${SP}tom/drum_tom_lo_soft.m4a`, 50: `${SP}tom/drum_tom_hi_soft.m4a`,
  },
  retro: {
    36: `${RZ1}kick.m4a`, 38: `${RZ1}snare.m4a`, 37: `${RZ1}clave.m4a`, 39: `${RZ1}clap.m4a`, 42: `${RZ1}hihat-closed.m4a`,
    46: `${RZ1}hihat-open.m4a`, 51: `${RZ1}ride.m4a`, 49: `${RZ1}crash.m4a`, 45: `${RZ1}tom-3.m4a`, 50: `${RZ1}tom-1.m4a`,
    70: `${LM2}cabasa.m4a`,
  },
  metroid: {
    36: `${TR808}kick/bd2525.m4a`, 38: `${TR808}snare/sd2525.m4a`, 37: `${TR808}rimshot/rs.m4a`, 39: `${TR808}clap/cp.m4a`,
    42: `${TR808}hihat-close/ch.m4a`, 46: `${TR808}hihat-open/oh25.m4a`, 51: `${TR808}cymbal/cy2525.m4a`,
    49: `${TR808}cymbal/cy2525.m4a`, 45: `${TR808}tom-low/lt25.m4a`, 50: `${TR808}tom-hi/ht25.m4a`, 70: `${TR808}maraca/ma.m4a`,
  },
  monkey_island: {
    36: `${SP}kick/drum_bass_soft.m4a`, 38: `${TR808}conga-hi/hc25.m4a`, 37: `${TR808}clave/cl.m4a`,
    70: `${TR808}maraca/ma.m4a`, 45: `${TR808}conga-low/lc25.m4a`, 50: `${TR808}conga-mid/mc25.m4a`,
    42: `${LM2}cabasa.m4a`, 49: `${LM2}crash.m4a`,
  },
  bossa_nova: {
    36: `${SP}kick/drum_bass_soft.m4a`, 38: `${SP}snare/drum_snare_soft.m4a`, 37: `${LM2}stick-m.m4a`, 39: `${LM2}clap.m4a`,
    42: `${SP}cymbal/drum_cymbal_pedal.m4a`, 46: `${SP}cymbal/drum_cymbal_open.m4a`, 51: `${LM2}ride.m4a`,
    49: `${SP}other/drum_splash_soft.m4a`, 45: `${SP}tom/drum_tom_lo_soft.m4a`, 50: `${SP}tom/drum_tom_hi_soft.m4a`, 70: `${LM2}cabasa.m4a`,
  },
  funk: {
    36: `${SP}kick/drum_bass_hard.m4a`, 38: `${SP}snare/drum_snare_hard.m4a`, 37: `${LM2}stick-h.m4a`, 39: `${LM2}clap.m4a`,
    42: `${SP}cymbal/drum_cymbal_closed.m4a`, 46: `${SP}cymbal/drum_cymbal_open.m4a`, 51: `${LM2}ride.m4a`,
    49: `${SP}cymbal/drum_cymbal_hard.m4a`, 45: `${SP}tom/drum_tom_lo_hard.m4a`, 50: `${SP}tom/drum_tom_hi_hard.m4a`, 70: `${LM2}tambourine.m4a`,
  },
  western: {
    36: `${SP}kick/drum_bass_soft.m4a`, 38: `${SP}snare/drum_snare_soft.m4a`, 37: `${LM2}stick-h.m4a`, 39: `${SP}percussion/perc_snap2.m4a`,
    45: `${SP}tom/drum_tom_lo_hard.m4a`, 50: `${SP}tom/drum_tom_hi_hard.m4a`, 70: `${TR808}maraca/ma.m4a`,
    49: `${SP}other/drum_splash_soft.m4a`,
  },
  celtic: {
    36: `${SP}kick/drum_bass_soft.m4a`, 38: `${SP}snare/drum_snare_hard.m4a`, 37: `${LM2}stick-m.m4a`,
    45: `${SP}tom/drum_tom_mid_soft.m4a`, 50: `${SP}tom/drum_tom_hi_soft.m4a`, 70: `${TR808}maraca/ma.m4a`,
  },
  musette: {
    36: `${SP}kick/drum_bass_soft.m4a`, 38: `${SP}snare/drum_snare_soft.m4a`, 37: `${LM2}stick-m.m4a`, 70: `${LM2}cabasa.m4a`,
  },
  liquid_dnb: {
    36: `${SP}kick/drum_bass_hard.m4a`, 38: `${SP}snare/drum_snare_hard.m4a`, 37: `${LM2}stick-h.m4a`, 39: `${LM2}clap.m4a`,
    42: `${SP}cymbal/drum_cymbal_closed.m4a`, 46: `${SP}cymbal/drum_cymbal_open.m4a`, 51: `${SP}cymbal/drum_cymbal_soft.m4a`,
    49: `${SP}other/drum_splash_hard.m4a`, 45: `${SP}tom/drum_tom_lo_soft.m4a`, 50: `${SP}tom/drum_tom_hi_soft.m4a`, 70: `${LM2}cabasa.m4a`,
  },
  castlevania: {
    36: `${SP}kick/drum_heavy_kick.m4a`, 38: `${SP}snare/drum_snare_hard.m4a`, 37: `${LM2}stick-h.m4a`, 39: `${LM2}clap.m4a`,
    42: `${SP}cymbal/drum_cymbal_closed.m4a`, 46: `${SP}cymbal/drum_cymbal_open.m4a`, 51: `${LM2}ride.m4a`,
    49: `${SP}cymbal/drum_cymbal_hard.m4a`, 45: `${SP}tom/drum_tom_lo_hard.m4a`, 50: `${SP}tom/drum_tom_hi_hard.m4a`, 70: `${LM2}cabasa.m4a`,
  },
  jrpg: {
    36: `${SP}kick/drum_bass_hard.m4a`, 38: `${SP}snare/drum_snare_soft.m4a`, 37: `${LM2}stick-m.m4a`, 39: `${LM2}clap.m4a`,
    42: `${SP}cymbal/drum_cymbal_closed.m4a`, 46: `${SP}cymbal/drum_cymbal_open.m4a`, 51: `${LM2}ride.m4a`,
    49: `${SP}cymbal/drum_cymbal_hard.m4a`, 45: `${SP}tom/drum_tom_lo_hard.m4a`, 50: `${SP}tom/drum_tom_mid_soft.m4a`, 70: `${TR808}maraca/ma.m4a`,
  },
};

function drumKit(styleId: string): Instrument {
  const kit = KITS[styleId] ?? KITS.synthwave!;
  const alias: Record<number, number> = { 35: 36, 40: 38, 44: 42, 57: 49, 59: 51, 47: 45, 48: 50 };
  return {
    label: "drum machine & Sonic Pi kits",
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

function instrumentFor(cache: SampleCache, font: Soundfont, program: number): Instrument {
  const p = program;
  if (p <= 2) return sfzInstrument(cache, "Splendid Grand Piano (public domain)", `${DANIGB}splendid-grand-piano/websfz.json`, 0.35);
  if (p === 4 || p === 5) return sfzInstrument(cache, "Greg Sullivan Wurlitzer EP200 (CC BY 3.0)", `${DANIGB}gs-e-pianos/Wurlitzer EP200/wurlitzer-ep200.websfz.json`, 0.25, false, "Samples/");
  if (p === 11) return sfzInstrument(cache, "VCSL vibraphone (CC0)", `${DANIGB}vcsl/Struck Idiophones/vibraphone-soft-mallets.websfz.json`, 0.6);
  if (p === 12) return sfzInstrument(cache, "VCSL marimba (CC0)", `${DANIGB}vcsl/Struck Idiophones/marimba.websfz.json`, 0.4);
  if (p === 32) return sfzInstrument(cache, "D. Smolken double bass (CC0)", `${DANIGB}dsmolken/double-bass/dsmolkenrubnerbasspizz.websfz.json`, 0.15);
  if (p === 66) return sfzInstrument(cache, "VCSL tenor sax (CC0)", `${DANIGB}vcsl/Reed Aerophones/tenor-saxophone-vibrato.websfz.json`, 0.12, true);
  return gmInstrument(cache, font, p, SUSTAINED(p), SUSTAINED(p) ? 0.4 : 0.2);
}

/** Resolves notes to zones and makes sure their samples are downloaded. */
export class SampleLibrary {
  private readonly instruments = new Map<string, Instrument>();
  private readonly loaded = new Map<string, SampleData>();
  private readonly failed = new Set<string>();
  /** Download size per sample URL. */
  readonly sizes = new Map<string, number>();
  bytes = 0;
  /** Files asked for vs finished in the current burst of downloads (for progress bars). */
  private queued = 0;
  private finished = 0;

  constructor(
    readonly cache: SampleCache,
    private readonly font: Soundfont = "MusyngKite",
  ) {}

  private instrument(n: ScoreNote, styleId: string): Instrument {
    const id = n.role === "drums" ? `kit:${styleId}` : `${n.program}`;
    let inst = this.instruments.get(id);
    if (!inst) this.instruments.set(id, (inst = n.role === "drums" ? drumKit(styleId) : instrumentFor(this.cache, this.font, n.program)));
    return inst;
  }

  /** Labels of every instrument used so far (for credits and reports). */
  get labels(): string[] {
    return [...new Set([...this.instruments.values()].map((i) => i.label))];
  }

  /** Fraction of the current burst of downloads that has finished (1 when idle). */
  get downloadProgress(): number {
    return this.queued ? this.finished / this.queued : 1;
  }

  sample(url: string): SampleData | undefined {
    return this.loaded.get(url);
  }

  /**
   * Plan notes (in order: round robins advance) and download what they need.
   * Resolves with the plans and the samples that were new to this call.
   */
  async prepare(notes: ScoreNote[], styleId: string, concurrency = 8): Promise<{ plans: PlannedNote[]; fresh: Map<string, SampleData> }> {
    const plans: PlannedNote[] = [];
    for (const n of notes) {
      const inst = this.instrument(n, styleId);
      plans.push({ zones: await inst.zones(n.key, n.vel), release: inst.release, sustain: inst.sustain, drum: n.role === "drums" });
    }
    const cuts = chokes(notes);
    plans.forEach((p, i) => (p.cut = cuts[i]));
    const queue = [...new Set(plans.flatMap((p) => p.zones.map((z) => z.url)))].filter((u) => !this.loaded.has(u) && !this.failed.has(u));
    const fresh = new Map<string, SampleData>();
    if (this.queued === this.finished) this.queued = this.finished = 0;
    this.queued += queue.length;
    const worker = async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        try {
          const { data, bytes } = await this.cache.audio(url);
          // A concurrent prepare() may have claimed it while we waited.
          if (this.loaded.has(url)) continue;
          this.loaded.set(url, data);
          fresh.set(url, data);
          this.bytes += bytes;
          this.sizes.set(url, bytes);
        } catch (err) {
          this.failed.add(url);
          console.warn("sample failed", url, err);
        } finally {
          this.finished++;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { plans, fresh };
  }
}

/** An open hi-hat stops at the next closed hi-hat among the same notes. */
function chokes(notes: ScoreNote[]): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(notes.length);
  let open = -1;
  notes.forEach((n, i) => {
    if (n.role !== "drums") return;
    if (n.key === 46) open = i;
    else if ((n.key === 42 || n.key === 44) && open >= 0) {
      out[open] = n.t;
      open = -1;
    }
  });
  return out;
}

// --- Rendering ------------------------------------------------------------

/** Longest a sampled note can ring past its onset, seconds (window sizing). */
export const MAX_SAMPLE_SECONDS = 12;

const loops = new WeakMap<SampleData, [number, number]>();

/** A loop in the stable middle of a sample, snapped to rising zero crossings (frames). */
function loopPoints(d: SampleData): [number, number] {
  const hit = loops.get(d);
  if (hit) return hit;
  const c = d.channels[0]!;
  const snap = (i: number) => {
    for (let j = i; j < c.length - 1; j++) if (c[j]! <= 0 && c[j + 1]! > 0) return j;
    return i;
  };
  const s = snap(Math.floor(c.length * 0.45));
  const e = snap(Math.floor(c.length * 0.85));
  const pts: [number, number] = e > s + 64 ? [s, e] : [0, c.length - 1];
  loops.set(d, pts);
  return pts;
}

/** Cubic (Catmull-Rom) read at fractional position. */
function read(c: Samples, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  const y0 = c[i - 1] ?? 0;
  const y1 = c[i] ?? 0;
  const y2 = c[i + 1] ?? 0;
  const y3 = c[i + 2] ?? 0;
  return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
}

/** Mix one planned note into `out` (offset by its `base`). */
export function renderSampleNote(out: Stereo, n: ScoreNote, plan: PlannedNote, sample: (url: string) => SampleData | undefined, sr: number): void {
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const vgain = Math.pow(n.vel / 127, 1.8);
  const offFrame = Math.round(n.dur * sr);
  const cutFrame = plan.cut !== undefined ? Math.round((plan.cut - n.t) * sr) : Infinity;
  const relCoef = Math.exp(-1 / ((plan.release / 4) * sr));
  const chokeCoef = Math.exp(-1 / (0.01 * sr));
  const maxFrames = Math.min(out.l.length - start, Math.round(MAX_SAMPLE_SECONDS * sr));
  for (const z of plan.zones) {
    const d = sample(z.url);
    if (!d) continue;
    const L = d.channels[0]!;
    const R = d.channels[1] ?? L;
    const step = (z.rate * d.sampleRate) / sr;
    const loop = plan.sustain && (n.dur + plan.release) * sr * step > (L.length - z.offset) * 0.9 ? loopPoints(d) : null;
    const g = z.gain * vgain;
    const stopAt = plan.drum ? Infinity : offFrame + Math.round(plan.release * 2 * sr);
    let pos = z.offset;
    let env = 1;
    for (let i = 0; i < maxFrames && i < stopAt; i++) {
      if (loop && pos >= loop[1]) pos -= loop[1] - loop[0];
      if (pos >= L.length - 1) break;
      if (plan.drum ? i >= cutFrame : i >= offFrame) env *= plan.drum ? chokeCoef : relCoef;
      if (env < 1e-4) break;
      const k = start + i;
      if (k >= 0) {
        out.l[k]! += read(L, pos) * g * env;
        out.r[k]! += read(R, pos) * g * env;
      }
      pos += step;
    }
  }
}
