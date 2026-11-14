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
/** Real SPDX ids where one exists, a `LicenseRef-` id for informal claims. */
const SPDX = /^(CC0-1\.0|CC-BY-[0-9.]+|CC-BY-SA-[0-9.]+|MIT|Unlicense|LicenseRef-[A-Za-z0-9.-]+)$/;
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

export const PackManifest = z.object({
  id: z.string().regex(PACK_ID, "<source>/<pack>, lower case, digits and dashes"),
  kind: z.literal("oneshots"),
  description: z.string().min(1),
  origin: Origin,
  licence: Licence,
  samples: z.record(z.string().regex(SAMPLE_ID, "lower case, digits, _ and -"), OneShot),
});
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
  return errors.length ? { ok: false, errors } : { ok: true, pack };
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
