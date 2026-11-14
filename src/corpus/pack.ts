/**
 * Sample packs: the checked-in manifest every sample source is converted to
 * (`samples/<source>/<pack>/pack.json`), and the drum kit a style builds from
 * them. See docs/sample-format-plan.md.
 *
 * A manifest pins its files to an upstream commit and a sha256 each, and
 * carries its licence as data: a pack without one does not validate. The
 * Bazel extension (//bazel:samples.bzl) turns each sample into a hash-pinned
 * download and a label, `@samples//<pack id>:<sample id>`.
 */
import { z } from "zod";

/** Pack ids are `<source>/<pack>`; sample ids are unique within a pack. Both become Bazel names. */
const PACK_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const SAMPLE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/**
 * Real SPDX ids where one exists, a `LicenseRef-` id for informal claims.
 * Policy (2026-11-14): free licences, non-commercial ones, public domain and
 * "free to use" or "royalty free" declarations are all accepted; the licence
 * block records what the source actually says.
 */
const SPDX = /^(CC0-1\.0|CC-BY(-NC)?(-SA)?-[0-9.]+|MIT|Unlicense|LicenseRef-[A-Za-z0-9.-]+)$/;
/** Audio is kept in upstream's codec, so hashes match upstream. */
const AUDIO = /\.(wav|m4a|ogg|mp3)$/;
/** ASCII only, so the Starlark side never has to encode beyond what the generator wrote. */
const PRINTABLE = /^[\x20-\x7e]+$/;

export const Licence = z.object({
  spdx: z.string().regex(SPDX, "a real SPDX id, or LicenseRef-<name> for an informal claim"),
  note: z.string().min(20).describe("What the source itself says, where, and any doubt about it."),
  attribution: z.string().min(1).nullable().describe("The credit line the page must show, or null when none is required."),
  share_alike: z.boolean(),
  /** Where the licence statement was read. */
  source: z.string().url(),
  read_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD"),
});
export type Licence = z.infer<typeof Licence>;

export const Origin = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
  commit: z.string().regex(HEX40, "a full commit hash"),
  /** Folder in the repo the files sit in, ending in a slash. */
  path: z.string().regex(/^([^/]+\/)*$/, "a folder path ending in /"),
});
export type Origin = z.infer<typeof Origin>;

export const OneShot = z.object({
  /** Upstream file name, relative to `origin.path`. An implementation detail: the id is the public name. */
  file: z.string().regex(PRINTABLE).regex(AUDIO, "an audio file (wav, m4a, ogg, mp3)"),
  /** `origin` + `file`, percent-encoded, as the generator built it. */
  url: z.string().url(),
  sha256: z.string().regex(HEX64),
  bytes: z.number().int().positive(),
  tags: z.array(z.string().regex(/^[a-z0-9-]+$/)),
  /** General MIDI percussion key this sample is the natural default for; kits may put it elsewhere. */
  gm: z.number().int().min(27).max(87).optional(),
});
export type OneShot = z.infer<typeof OneShot>;

export const OneShotPack = z.object({
  id: z.string().regex(PACK_ID, "<source>/<pack>, lower case, digits and dashes"),
  kind: z.literal("oneshots"),
  description: z.string().min(1),
  origin: Origin,
  licence: Licence,
  samples: z.record(z.string().regex(SAMPLE_ID, "lower case, digits, _ and -"), OneShot),
});
export type OneShotPack = z.infer<typeof OneShotPack>;

/** A file of a multisampled instrument. Regions name it by its id. */
export const SampleFile = OneShot.pick({ file: true, url: true, sha256: true, bytes: true });
export type SampleFile = z.infer<typeof SampleFile>;

const KEY = z.number().int().min(0).max(127);
const VEL = z.tuple([KEY, KEY]);

/**
 * One flat region: the global, group and region opcodes of the source
 * resolved, holding everything the sampler reads. Regions it cannot play
 * (CC conditions, keyswitches, release triggers) are left out.
 */
export const Region = z.object({
  /** Id of the file in `samples`. */
  sample: z.string().regex(SAMPLE_ID),
  /** The key the recording sounds at untransposed (pitch_keycenter). */
  root: KEY,
  lo: KEY,
  hi: KEY,
  vel: VEL,
  /** Cents: tune + 100 x transpose. */
  tune: z.number(),
  /** dB: volume + group_volume. */
  volume: z.number(),
  /** Start offset, frames. */
  offset: z.number().int().min(0),
  /** Velocity crossfades in and out, or null. */
  xfin: VEL.nullable(),
  xfout: VEL.nullable(),
  /** Round robin: [length, position], position counting from 1. */
  seq: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  /** Loop opcodes where the source has them. */
  loop: z.object({ mode: z.string(), start: z.number().int().min(0).optional(), end: z.number().int().min(0).optional() }).optional(),
});
export type Region = z.infer<typeof Region>;

export const MultisamplePack = z.object({
  id: z.string().regex(PACK_ID, "<source>/<pack>, lower case, digits and dashes"),
  kind: z.literal("multisample"),
  description: z.string().min(1),
  origin: Origin,
  licence: Licence,
  /** The upstream document the regions were generated from, pinned, for the zone-equivalence test. Nothing else reads it. */
  source: z.object({ path: z.string().regex(PRINTABLE), url: z.string().url(), sha256: z.string().regex(HEX64) }),
  samples: z.record(z.string().regex(SAMPLE_ID, "lower case, digits, _ and -"), SampleFile),
  regions: z.array(Region),
});
export type MultisamplePack = z.infer<typeof MultisamplePack>;

export const PackManifest = z.discriminatedUnion("kind", [OneShotPack, MultisamplePack]);
export type PackManifest = z.infer<typeof PackManifest>;

/** Where a pack's file lives upstream, pinned to the pack's commit. */
export function fileUrl(origin: Origin, file: string): string {
  const path = (origin.path + file).split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${origin.repo}/${origin.commit}/${path}`;
}

/** Where the site serves a sample: named by its ids, in the codec upstream used. */
export function servedPath(pack: string, sample: string, file: string): string {
  return `${pack}/${sample}${file.slice(file.lastIndexOf("."))}`;
}

export type PackResult = { ok: true; pack: PackManifest } | { ok: false; errors: string[] };

/** Structure, licence, and that every URL is the one the origin and file name give. */
export function validatePack(input: unknown, where?: string): PackResult {
  const parsed = PackManifest.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const pack = parsed.data;
  const errors: string[] = [];
  if (where !== undefined && where !== `${pack.id}/pack.json`) errors.push(`id: ${pack.id} should live at samples/${pack.id}/pack.json, not ${where}`);
  const files = new Map<string, string>();
  for (const [id, s] of Object.entries(pack.samples)) {
    const want = fileUrl(pack.origin, s.file);
    if (s.url !== want) errors.push(`samples.${id}.url: expected ${want}`);
    const other = files.get(s.file);
    if (other !== undefined) errors.push(`samples.${id}: same file as ${other}`);
    files.set(s.file, id);
  }
  if (Object.keys(pack.samples).length === 0) errors.push("samples: none");
  if (pack.kind === "multisample") {
    if (pack.regions.length === 0) errors.push("regions: none");
    const used = new Set<string>();
    pack.regions.forEach((r, i) => {
      if (!(r.sample in pack.samples)) errors.push(`regions.${i}.sample: no sample ${r.sample}`);
      used.add(r.sample);
      if (r.lo > r.hi) errors.push(`regions.${i}: lo ${r.lo} above hi ${r.hi}`);
      if (r.vel[0] > r.vel[1]) errors.push(`regions.${i}.vel: ${r.vel[0]} above ${r.vel[1]}`);
      if (r.seq[1] > r.seq[0]) errors.push(`regions.${i}.seq: position ${r.seq[1]} past length ${r.seq[0]}`);
    });
    for (const id of Object.keys(pack.samples)) if (!used.has(id)) errors.push(`samples.${id}: no region plays it`);
    const want = fileUrl({ ...pack.origin, path: "" }, pack.source.path);
    if (pack.source.url !== want) errors.push(`source.url: expected ${want}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, pack };
}

/** The licence as the page names it: "CC0", "CC BY 3.0", "public domain", ... */
export function licenceName(spdx: string): string {
  if (spdx === "CC0-1.0") return "CC0";
  const cc = /^CC-(BY(?:-NC)?(?:-SA)?)-([0-9.]+)$/.exec(spdx);
  if (cc) return `CC ${cc[1]} ${cc[2]}`;
  if (spdx === "LicenseRef-public-domain") return "public domain";
  return spdx.replace(/^LicenseRef-/, "").replace(/-/g, " ");
}

/**
 * How the page credits a pack: its attribution where the licence asks for
 * one (shared by every program of a soundfont), else its description; then
 * the licence. "VCSL marimba (CC0)".
 */
export function packCredit(pack: Pick<PackManifest, "description" | "licence">): string {
  return `${pack.licence.attribution ?? pack.description} (${licenceName(pack.licence.spdx)})`;
}

// --- Instruments --------------------------------------------------------------

export const FONTS = ["MusyngKite", "FluidR3_GM"] as const;
export type Soundfont = (typeof FONTS)[number];

/**
 * Which pack plays a General MIDI program (`samples/instruments.json`, read
 * by the sampler and by //bazel:samples.bzl). Every program names a pack per
 * soundfont: an SFZ library plays the same for both, a GM soundfont program
 * names its own group per font. A program that is not listed has no sound.
 */
export const InstrumentEntry = z.object({
  packs: z.object({ MusyngKite: z.string().regex(PACK_ID), FluidR3_GM: z.string().regex(PACK_ID) }),
  /** Release time, seconds. */
  release: z.number().positive(),
  /** Loop the sample when the note outlasts it. */
  sustain: z.boolean(),
  /** One recording per note whatever the velocity, so touch shapes the tone instead. */
  flat: z.boolean(),
});
export type InstrumentEntry = z.infer<typeof InstrumentEntry>;

export const InstrumentTable = z.object({
  programs: z.record(z.string().regex(/^([0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/, "a GM program, 0-127"), InstrumentEntry),
});
export type InstrumentTable = z.infer<typeof InstrumentTable>;

/** Every pack id the table names, sorted. */
export function tablePacks(table: InstrumentTable): string[] {
  return [...new Set(Object.values(table.programs).flatMap((e) => Object.values(e.packs)))].sort();
}

// --- Kits -------------------------------------------------------------------

/** A sample in a kit: its id (`<pack id>:<sample id>`, as in the label) and where the site serves it. */
export interface KitSample {
  id: string;
  path: string;
}

/** One drum key: the recording it plays, and with touch, a harder and a softer one where the kit has them. */
export interface KitHit {
  default: KitSample;
  hard?: KitSample;
  soft?: KitSample;
}

/**
 * A style's drum kit, written by `sample_kit` (//bazel:samples.bzl) and
 * carried in the style's bundle. Keys are General MIDI percussion keys.
 */
export interface SampleKit {
  hits: Record<string, KitHit>;
  /** Keys played as another key (35 as 36, 40 as 38, ...). */
  aliases: Record<string, number>;
}
