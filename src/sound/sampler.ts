/**
 * Approach 2: multi-sampled instruments. Which pack plays a General MIDI
 * program is data, `samples/instruments.json`: free SFZ libraries (velocity
 * layers, round robins, crossfades) for piano, electric piano, mallets,
 * upright bass and tenor sax, and a General MIDI soundfont group (a sample per
 * semitone) for every other program the styles use. Drums use per-style kits.
 *
 * Split in two so playback can run in a worker: `SampleLibrary` (main thread:
 * resolves notes to sample zones, downloads and decodes them) and
 * `renderSampleNote` (pure: mixes decoded sample data into a Stereo).
 *
 * Files are named by the path the site serves them at: the table
 * (`instruments.json`), each pack's manifest (`<pack id>/pack.json`, see
 * //src/corpus:pack.ts) and its samples (`<pack id>/<sample id>.<ext>`). The
 * drum kits that are not packs yet still name upstream URLs (until step 3 of
 * docs/sample-format-plan.md). The site serves its own copies of what the
 * styles can play (see `reach` and //tools/samples); the bench reads the
 * audio from each manifest's pinned upstream URL.
 */
import { type InstrumentEntry, type InstrumentTable, type MultisamplePack, type PackManifest, type SampleKit, type Soundfont, packCredit, servedPath } from "../corpus/pack.js";
import type { SoundDeclaration } from "../corpus/sound.js";
import type { ScoreNote } from "./types.js";
import type { Samples, Stereo } from "./dsp.js";
import { renderShaped } from "./shape.js";

export type { Soundfont };

const DANIGB = "https://danigb.github.io/samples/";
const GLEITZ = "https://gleitz.github.io/midi-js-soundfonts/";

/** Where the program table is served, beside the packs. */
export const INSTRUMENTS = "instruments.json";
/** Where a pack's manifest is served. */
export const manifestPath = (pack: string): string => `${pack}/pack.json`;

/**
 * The drum kits not yet moved to packs name their files by upstream URL. The
 * site ships those files itself, laid out as `danigb/<path>` under the same
 * directory as the packs.
 */
export function mirrorPath(url: string): string | undefined {
  if (url.startsWith(DANIGB)) return `danigb/${url.slice(DANIGB.length)}`;
  if (url.startsWith(GLEITZ)) return `gleitz/${url.slice(GLEITZ.length)}`;
  return undefined;
}

/** A path the site serves (a pack file or the table) rather than an upstream URL. Until step 3 of docs/sample-format-plan.md the loader takes both. */
export function isPackSample(ref: string): boolean {
  return !/^https?:\/\//.test(ref);
}

/** Fetches from the sample directory at `base` (ending in a slash) instead of upstream. */
export function mirroredAt(base: string): (ref: string) => string {
  return (ref) => {
    if (isPackSample(ref)) return base + ref;
    const path = mirrorPath(ref);
    if (path === undefined) throw new Error(`not a mirrored sample: ${ref}`);
    return base + path;
  };
}

/** Decoded audio, transferable to a worker. */
export interface SampleData {
  channels: Samples[];
  sampleRate: number;
}

/**
 * Where to fetch a file: from its served path, or, for a pack sample, from
 * `upstream`, the manifest's pinned URL (what the bench does).
 */
export type Locate = (ref: string, upstream?: string) => string;

/** Downloads and decodes sample files once per page; tracks bytes for reports. */
export class SampleCache {
  private readonly buffers = new Map<string, Promise<{ data: SampleData; bytes: number }>>();
  private readonly json = new Map<string, Promise<unknown>>();
  /** Served path -> pinned upstream URL, for every pack sample of a manifest read so far. */
  private readonly upstream = new Map<string, string>();
  /**
   * `ctx` decodes audio (not needed to read the table and manifests);
   * `locate` maps a served path or URL to where to fetch it from (default:
   * as named); `get` fetches (the build reads from disk instead).
   */
  constructor(
    private readonly ctx?: BaseAudioContext,
    private readonly locate: Locate = (ref) => ref,
    private readonly get: (url: string) => Promise<Response> = (url) => fetch(url),
  ) {}

  audio(ref: string): Promise<{ data: SampleData; bytes: number }> {
    let p = this.buffers.get(ref);
    if (!p) {
      p = this.get(this.locate(ref, this.upstream.get(ref)))
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${ref}`);
          return r.arrayBuffer();
        })
        .then(async (raw) => {
          if (!this.ctx) throw new Error("no audio context to decode with");
          const bytes = raw.byteLength; // decodeAudioData detaches `raw`
          const b = await this.ctx.decodeAudioData(raw);
          const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice());
          return { bytes, data: { channels, sampleRate: b.sampleRate } };
        });
      this.buffers.set(ref, p);
    }
    return p;
  }

  getJson<T>(ref: string): Promise<T> {
    let p = this.json.get(ref);
    if (!p) {
      p = this.get(this.locate(ref)).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${ref}`);
        return r.json();
      });
      this.json.set(ref, p);
    }
    return p as Promise<T>;
  }

  /** A pack's manifest; also records where each of its samples lives upstream. */
  async pack<T extends PackManifest = PackManifest>(id: string): Promise<T> {
    const pack = await this.getJson<T>(manifestPath(id));
    for (const [sid, s] of Object.entries(pack.samples)) this.upstream.set(servedPath(pack.id, sid, s.file), s.url);
    return pack;
  }

  /** The program table. */
  instruments(): Promise<InstrumentTable> {
    return this.getJson<InstrumentTable>(INSTRUMENTS);
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
  /** Touch: a softer note is duller. Low-pass corner, Hz; absent for full brightness. */
  lowpass?: number;
}

export interface Instrument {
  label: string;
  release: number;
  sustain: boolean;
  /** One recording per note, whatever the velocity (so touch has to shape it). */
  flat: boolean;
  /** `touch`: let velocity choose between recordings where the set has a harder and a softer one. */
  zones(key: number, vel: number, touch?: boolean): Promise<Zone[]>;
  /** Every served path (manifest and audio) that playing any of `keys` can need. */
  required(keys: readonly number[]): Promise<string[]>;
}

// --- Multisampled instruments (pack manifests) ----------------------------

/** An instrument from a multisample pack, as the program table describes it. */
export function packInstrument(pack: MultisamplePack, entry: Pick<InstrumentEntry, "release" | "sustain" | "flat">): Instrument {
  const rr = new Map<number, number>();
  const url = (sample: string) => servedPath(pack.id, sample, pack.samples[sample]!.file);
  return {
    label: packCredit(pack),
    release: entry.release,
    sustain: entry.sustain,
    flat: entry.flat,
    async zones(key, vel) {
      const counter = rr.get(key) ?? 0;
      rr.set(key, counter + 1);
      const out: Zone[] = [];
      for (const r of pack.regions) {
        if (key < r.lo || key > r.hi || vel < r.vel[0] || vel > r.vel[1]) continue;
        if (r.seq[0] > 1 && (counter % r.seq[0]) + 1 !== r.seq[1]) continue;
        let w = 1;
        if (r.xfin) w *= ramp(vel, r.xfin[0], r.xfin[1]);
        if (r.xfout) w *= 1 - ramp(vel, r.xfout[0], r.xfout[1]);
        if (w < 0.02) continue;
        out.push({
          url: url(r.sample),
          rate: Math.pow(2, (key - r.root + r.tune / 100) / 12),
          gain: Math.sqrt(w) * Math.pow(10, r.volume / 20),
          offset: r.offset,
        });
      }
      return out;
    },
    async required(keys) {
      // Any velocity layer or round robin can sound, so take every region the keys reach.
      const urls = pack.regions.filter((r) => keys.some((k) => k >= r.lo && k <= r.hi)).map((r) => url(r.sample));
      return [manifestPath(pack.id), ...new Set(urls)];
    },
  };
}

function ramp(x: number, lo: number, hi: number): number {
  if (hi <= lo) return x >= hi ? 1 : 0;
  return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
}

/** A program the table does not list: silent, and not something a style can declare. */
function unlisted(program: number): Instrument {
  const why = `program ${program} has no entry in samples/${INSTRUMENTS}`;
  let warned = false;
  return {
    label: "",
    release: 0.2,
    sustain: false,
    flat: true,
    async zones() {
      if (!warned) console.warn(why);
      warned = true;
      return [];
    },
    async required() {
      throw new Error(why);
    },
  };
}

/** The instrument the program table names for a program in this soundfont. */
export async function instrumentFor(cache: SampleCache, font: Soundfont, program: number): Promise<Instrument> {
  const entry = (await cache.instruments()).programs[String(program)];
  if (!entry) return unlisted(program);
  const pack = await cache.pack(entry.packs[font]);
  if (pack.kind !== "multisample") throw new Error(`${pack.id}: program ${program} names a ${pack.kind} pack`);
  return packInstrument(pack, entry);
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
  },  disco: {
    36: `${SP}kick/bd_haus.m4a`, 38: `${SP}snare/drum_snare_hard.m4a`, 37: `${LM2}stick-h.m4a`, 39: `${LM2}clap.m4a`,
    42: `${SP}cymbal/drum_cymbal_closed.m4a`, 46: `${SP}cymbal/drum_cymbal_open.m4a`, 51: `${LM2}ride.m4a`,
    49: `${LM2}crash.m4a`, 45: `${LM2}tom-l.m4a`, 50: `${LM2}tom-h.m4a`, 70: `${LM2}cabasa.m4a`,
  },
  // Kettledrums only.
  baroque: {
    36: `${SP}kick/drum_bass_soft.m4a`, 49: `${SP}other/drum_splash_soft.m4a`,
    45: `${SP}tom/drum_tom_lo_hard.m4a`, 50: `${SP}tom/drum_tom_mid_soft.m4a`,
  },
  midnight_platform: {
    36: `${SP}kick/drum_bass_soft.m4a`, 38: `${SP}snare/drum_snare_soft.m4a`, 37: `${LM2}stick-m.m4a`,
    42: `${SP}cymbal/drum_cymbal_pedal.m4a`, 51: `${LM2}ride.m4a`, 49: `${SP}other/drum_splash_soft.m4a`,
    45: `${SP}tom/drum_tom_lo_soft.m4a`, 50: `${SP}tom/drum_tom_hi_soft.m4a`,
  },
  // Dum on the kick, tek on the stick, slap on the tom, zills on the cabasa.
  courtyard_nine: {
    36: `${SP}kick/drum_bass_soft.m4a`, 37: `${LM2}stick-h.m4a`, 49: `${SP}other/drum_splash_soft.m4a`,
    45: `${SP}tom/drum_tom_lo_hard.m4a`, 50: `${SP}tom/drum_tom_hi_soft.m4a`, 70: `${LM2}cabasa.m4a`,
  },
  // Soft kick, a stick for the rare tick, cabasa for the shaker.
  low_log: {
    36: `${SP}kick/drum_bass_soft.m4a`, 37: `${LM2}stick-m.m4a`, 49: `${SP}other/drum_splash_soft.m4a`,
    45: `${SP}tom/drum_tom_lo_soft.m4a`, 70: `${LM2}cabasa.m4a`,
  },
};

/**
 * Sonic Pi's kit has a hard and a soft recording of some drums. A kit names
 * one; with touch, a hard hit takes the hard one and a light hit the soft one.
 * (Both are among the files the site already serves: every one is some kit's default.)
 */
const HARD_SOFT: [string, string][] = [
  [`${SP}kick/drum_bass_hard.m4a`, `${SP}kick/drum_bass_soft.m4a`],
  [`${SP}snare/drum_snare_hard.m4a`, `${SP}snare/drum_snare_soft.m4a`],
  [`${SP}tom/drum_tom_lo_hard.m4a`, `${SP}tom/drum_tom_lo_soft.m4a`],
  [`${SP}tom/drum_tom_hi_hard.m4a`, `${SP}tom/drum_tom_hi_soft.m4a`],
  [`${SP}cymbal/drum_cymbal_hard.m4a`, `${SP}cymbal/drum_cymbal_soft.m4a`],
  [`${SP}other/drum_splash_hard.m4a`, `${SP}other/drum_splash_soft.m4a`],
];
const HARDER = new Map(HARD_SOFT.map(([hard, soft]) => [soft, hard]));
const SOFTER = new Map(HARD_SOFT.map(([hard, soft]) => [hard, soft]));
/** Velocities from which a hit counts as hard, and up to which as light. */
const HARD_FROM = 100;
const SOFT_TO = 52;

/** Upstream URLs of the recordings touch can swap in, for checking that the site serves them. */
export const TOUCH_SAMPLES: readonly string[] = HARD_SOFT.flat();

/** Low-pass corner for a note of this velocity: about 2 kHz at a whisper, open from a firm touch up. */
function brightness(vel: number): number | undefined {
  const hz = 700 * Math.pow(2, (4.9 * vel) / 127);
  return hz < 16000 ? hz : undefined;
}

/** A kit from sample packs (`sample_kit`), with its own touch variants and key aliases. */
function sampleKit(kit: SampleKit): Instrument {
  const hit = (key: number) => kit.hits[String(key)] ?? kit.hits[String(kit.aliases[String(key)] ?? key)];
  return {
    label: "drum machine kits",
    release: 0.05,
    sustain: false,
    flat: true,
    async zones(key, vel, touch) {
      const h = hit(key);
      if (!h) return [];
      const s = (touch && vel >= HARD_FROM ? h.hard : touch && vel <= SOFT_TO ? h.soft : undefined) ?? h.default;
      return [{ url: s.path, rate: 1, gain: 1, offset: 0 }];
    },
    async required(keys) {
      // Every variant touch can pick, so the shipped set never depends on another kit having it.
      return [...new Set(keys.flatMap((k) => { const h = hit(k); return h ? [h.default, h.hard, h.soft].flatMap((v) => (v ? [v.path] : [])) : []; }))];
    },
  };
}

function drumKit(styleId: string, own?: SampleKit): Instrument {
  if (own) return sampleKit(own);
  const kit = KITS[styleId] ?? KITS.synthwave!;
  const alias: Record<number, number> = { 35: 36, 40: 38, 44: 42, 57: 49, 59: 51, 47: 45, 48: 50 };
  return {
    label: "drum machine & Sonic Pi kits",
    release: 0.05,
    sustain: false,
    flat: true,
    async zones(key, vel, touch) {
      let url = kit[alias[key] ?? key];
      if (url && touch) url = (vel >= HARD_FROM ? HARDER.get(url) : vel <= SOFT_TO ? SOFTER.get(url) : undefined) ?? url;
      return url ? [{ url, rate: 1, gain: 1, offset: 0 }] : [];
    },
    async required(keys) {
      return [...new Set(keys.flatMap((k) => kit[alias[k] ?? k] ?? []))];
    },
  };
}

/** Resolves notes to zones and makes sure their samples are downloaded. */
export class SampleLibrary {
  private readonly instruments = new Map<string, Promise<Instrument>>();
  /** The ones that have loaded, for their labels. */
  private readonly ready = new Map<string, Instrument>();
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
    /** Velocity shapes the sound: harder and softer recordings where there are both, else a darker tone when soft. */
    private readonly touch = false,
  ) {}

  private instrument(n: ScoreNote, styleId: string, kit?: SampleKit): Promise<Instrument> {
    const id = n.role === "drums" ? `kit:${styleId}` : `${n.program}`;
    let inst = this.instruments.get(id);
    if (!inst) {
      inst = n.role === "drums" ? Promise.resolve(drumKit(styleId, kit)) : instrumentFor(this.cache, this.font, n.program);
      this.instruments.set(id, inst);
      inst.then((i) => this.ready.set(id, i)).catch(() => {});
    }
    return inst;
  }

  /** Labels of every instrument used so far (for credits and reports). */
  get labels(): string[] {
    return [...new Set([...this.ready.values()].map((i) => i.label).filter((l) => l))];
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
   * `kit` is the style's own drum kit, where its bundle has one.
   * Resolves with the plans and the samples that were new to this call.
   */
  async prepare(notes: ScoreNote[], styleId: string, kit?: SampleKit, concurrency = 8): Promise<{ plans: PlannedNote[]; fresh: Map<string, SampleData> }> {
    const plans: PlannedNote[] = [];
    for (const n of notes) {
      const inst = await this.instrument(n, styleId, kit);
      const plan: PlannedNote = { zones: await inst.zones(n.key, n.vel, this.touch), release: inst.release, sustain: inst.sustain, drum: n.role === "drums" };
      const lowpass = this.touch && inst.flat ? brightness(n.vel) : undefined;
      if (lowpass !== undefined) plan.lowpass = lowpass;
      plans.push(plan);
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

export interface StyleSound {
  id: string;
  sound: SoundDeclaration;
  kit?: SampleKit;
}

/** What one declared key of a style can need: the instrument, the key, and the served paths or URLs. */
export interface Reach {
  /** "lead, program 24" or "drums". */
  part: string;
  program?: number;
  key: number;
  files: string[];
}

/**
 * Every file each key a style declares can sound, through the same
 * instruments `SampleLibrary` plays: each instrument's whole range, and the
 * drum keys through the style's kit (its own `kit` where it has one, with
 * every touch variant). The packaging action trims the site's samples and
 * checks them against the style's declared packs with this.
 */
export async function reach(cache: SampleCache, style: StyleSound, font: Soundfont = "MusyngKite"): Promise<Reach[]> {
  const out: Reach[] = [];
  for (const inst of style.sound.instruments) {
    const instrument = await instrumentFor(cache, font, inst.program);
    const part = `${inst.role}, program ${inst.program}`;
    for (let key = inst.range[0]; key <= inst.range[1]; key++) {
      let files: string[];
      try {
        files = await instrument.required([key]);
      } catch (e) {
        throw new Error(`${style.id}: ${part}, key ${key}: ${e instanceof Error ? e.message : e}`);
      }
      out.push({ part, program: inst.program, key, files });
    }
  }
  const kit = drumKit(style.id, style.kit);
  for (const key of style.sound.drums) out.push({ part: "drums", key, files: await kit.required([key]) });
  return out;
}

/** Every file the styles can play (see `reach`), with the program table. Sorted. */
export async function requiredSamples(cache: SampleCache, styles: StyleSound[], font: Soundfont = "MusyngKite"): Promise<string[]> {
  const urls = new Set<string>([INSTRUMENTS]);
  for (const style of styles) for (const r of await reach(cache, style, font)) for (const f of r.files) urls.add(f);
  return [...urls].sort();
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

/** Mix one planned note into `out` (offset by its `base`), along its curves if it has any. */
export function renderSampleNote(out: Stereo, n: ScoreNote, plan: PlannedNote, sample: (url: string) => SampleData | undefined, sr: number): void {
  if (n.curves) renderShaped(out, n, sr, (o, m) => renderPlain(o, m, plan, sample, sr));
  else renderPlain(out, n, plan, sample, sr);
}

function renderPlain(out: Stereo, n: ScoreNote, plan: PlannedNote, sample: (url: string) => SampleData | undefined, sr: number): void {
  const start = Math.round(n.t * sr) - (out.base ?? 0);
  const vgain = Math.pow(n.vel / 127, 1.8);
  const offFrame = Math.round(n.dur * sr);
  const cutFrame = plan.cut !== undefined ? Math.round((plan.cut - n.t) * sr) : n.gesture === "choke" ? Math.round(n.dur * sr) : Infinity;
  const dull = plan.lowpass !== undefined ? 1 - Math.exp((-2 * Math.PI * plan.lowpass) / sr) : 0;
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
    let yl = 0;
    let yr = 0;
    for (let i = 0; i < maxFrames && i < stopAt; i++) {
      if (loop && pos >= loop[1]) pos -= loop[1] - loop[0];
      if (pos >= L.length - 1) break;
      if (plan.drum ? i >= cutFrame : i >= offFrame) env *= plan.drum ? chokeCoef : relCoef;
      if (env < 1e-4) break;
      const k = start + i;
      if (dull) {
        yl += dull * (read(L, pos) - yl);
        yr += dull * (read(R, pos) - yr);
        if (k >= 0) {
          out.l[k]! += yl * g * env;
          out.r[k]! += yr * g * env;
        }
      } else if (k >= 0) {
        out.l[k]! += read(L, pos) * g * env;
        out.r[k]! += read(R, pos) * g * env;
      }
      pos += step;
    }
  }
}
