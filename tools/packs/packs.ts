/**
 * Writes a sample pack manifest (`samples/<pack id>/pack.json`) from an
 * upstream repo, pinned to a commit. Run by hand when a pack is added or
 * bumped; the build never reads upstream's own metadata.
 *
 *   bazel run //tools/packs -- sampled DM/TR-909/Detroit danigb-sampled/tr909-detroit [--commit SHA]
 *     One-shots from danigb/sampled: the set's `samples/` folder.
 *   bazel run //tools/packs -- samples drum-machines/TR-808 danigb-samples/tr-808 [--commit SHA] [--ext m4a]
 *     One-shots from danigb/samples: every file with the extension under `audio/<folder>/`.
 *   bazel run //tools/packs -- websfz "vcsl/Struck Idiophones/marimba.websfz.json" danigb-samples/vcsl-marimba [--sample-path Samples/] [--commit SHA]
 *     A multisampled instrument from a websfz document in danigb/samples: its
 *     regions flattened (tools/packs/websfz.ts), and every file they play.
 *     --sample-path is the folder the samples sit in relative to the document,
 *     where the document does not say (the Wurlitzer's `Samples/`).
 *   bazel run //tools/packs -- gm MusyngKite 24 25 ... [--commit SHA]
 *     General MIDI soundfont programs from gleitz/midi-js-soundfonts, one
 *     pack per program (`gleitz-musyngkite/<name>`): a region per file, the
 *     edge files stretched to the ends of the keyboard as the sampler did.
 *     The licence is the font's, written below. Add the programs to
 *     samples/instruments.json by hand.
 *
 * Without --commit, the repo's default branch head is pinned. Every file is
 * downloaded once from the pinned URL for its sha256 and size.
 *
 * The licence block, the description and each sample's tags and GM key are
 * kept from an existing manifest, since they are checked or chosen by hand.
 * A new pack gets a licence placeholder that fails validation until someone
 * reads the source's terms and fills it in.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type MultisamplePack, type OneShot, type OneShotPack, type Region, type SampleFile, type Soundfont, FONTS, fileUrl, validatePack } from "../../src/corpus/pack.js";
import { type WebsfzDoc, parseWebsfz, regionFile } from "./websfz.js";

const workspace = process.env.BUILD_WORKSPACE_DIRECTORY ?? process.cwd();
const CONCURRENCY = 8;
const GLEITZ_REPO = "gleitz/midi-js-soundfonts";

async function getJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

async function headCommit(repo: string): Promise<string> {
  const { default_branch } = await getJson<{ default_branch: string }>(`https://api.github.com/repos/${repo}`);
  const { sha } = await getJson<{ sha: string }>(`https://api.github.com/repos/${repo}/commits/${default_branch}`);
  return sha;
}

/** Blob paths under `prefix` at `commit`, relative to it. */
async function listFiles(repo: string, commit: string, prefix: string): Promise<{ path: string; size: number }[]> {
  // gleitz/midi-js-soundfonts is too big for one recursive listing; list the folder's own tree there.
  const folder = prefix.replace(/\/$/, "");
  const url = folder && repo === GLEITZ_REPO ? `https://api.github.com/repos/${repo}/git/trees/${commit}:${folder.split("/").map(encodeURIComponent).join("/")}` : `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`;
  const tree = await getJson<{ truncated: boolean; tree: { path: string; type: string; size?: number }[] }>(url);
  if (tree.truncated) throw new Error(`${repo}: tree listing truncated`);
  const strip = url.includes("?recursive") ? prefix : "";
  return tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(strip)).map((e) => ({ path: e.path.slice(strip.length), size: e.size ?? 0 }));
}

async function rawText(repo: string, commit: string, path: string): Promise<string | undefined> {
  const r = await fetch(fileUrl({ repo, commit, path: "" }, path));
  return r.ok ? r.text() : undefined;
}

/** What a file name says it is: a tag, and the GM key it is the natural default for. First match wins. */
const RULES: [RegExp, string, number | undefined][] = [
  [/open|\/oh\d|hhopen/, "hat-open", 46],
  [/clos|hhclosed|\/ch$|pedal/, "hat-closed", 42],
  [/ride/, "ride", 51],
  [/crash|splash|cymbal|\/cy\d/, "cymbal", 49],
  [/kick|(^|\/)bd|drum_bass/, "kick", 36],
  [/snare|\/sd\d|(^|\/)sn_/, "snare", 38],
  [/rim|\/rs$|stick/, "rim", 37],
  [/clap|\/cp$/, "clap", 39],
  [/conga/, "conga", undefined],
  [/tom.?l|\/lt\d/, "tom-low", 45],
  [/mid.?tom|tom.?m|\/mt\d/, "tom-mid", 47],
  [/tom.?h|\/ht\d/, "tom-high", 50],
  [/maraca|\/ma$|cabasa|shaker/, "shaker", 70],
  [/tambourine/, "tambourine", 54],
  [/cowbell|\/cb$/, "cowbell", 56],
  [/clave|\/cl$/, "clave", 75],
];

function classify(rel: string): Pick<OneShot, "tags" | "gm"> {
  const name = rel.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  const tags: string[] = [];
  let gm: number | undefined;
  for (const [re, tag, key] of RULES) {
    if (!re.test(name)) continue;
    tags.push(tag);
    gm = key;
    break;
  }
  if (/[_-]hard\b|_hard$/.test(name)) tags.push("hard");
  if (/[_-]soft\b|_soft$/.test(name)) tags.push("soft");
  return gm === undefined ? { tags } : { tags, gm };
}

/** Sample ids from file names: the stem where that is unique, else the whole relative path. */
function sampleIds(rels: string[]): Map<string, string> {
  const clean = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const stems = rels.map((r) => clean(r.slice(r.lastIndexOf("/") + 1)));
  const counts = new Map<string, number>();
  for (const s of stems) counts.set(s, (counts.get(s) ?? 0) + 1);
  const ids = new Map<string, string>();
  rels.forEach((r, i) => ids.set(r, counts.get(stems[i]!)! > 1 ? clean(r.replace(/\//g, "-")) : stems[i]!));
  if (new Set(ids.values()).size !== rels.length) throw new Error("sample ids collide");
  return ids;
}

async function hashAll(urls: string[]): Promise<Map<string, { sha256: string; bytes: number }>> {
  const out = new Map<string, { sha256: string; bytes: number }>();
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const data = new Uint8Array(await r.arrayBuffer());
      // A Git LFS pointer is a small text file; the hash would pin the pointer, not the audio.
      if (data.byteLength < 512 && new TextDecoder().decode(data).startsWith("version https://git-lfs")) throw new Error(`${url} is a Git LFS pointer`);
      out.set(url, { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

const PLACEHOLDER = {
  spdx: "LicenseRef-unchecked",
  note: "TODO",
  attribution: null,
  share_alike: false,
  source: "",
  read_on: "",
};

async function writeOneShots(id: string, repo: string, commit: string, path: string, rels: string[], description: string): Promise<void> {
  const file = join(workspace, "samples", id, "pack.json");
  const old = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as OneShotPack) : undefined;
  const origin = { repo, commit, path };
  const ids = sampleIds(rels);
  const urls = rels.map((r) => fileUrl(origin, r));
  console.error(`hashing ${urls.length} files from ${repo}@${commit.slice(0, 7)}/${path}`);
  const hashes = await hashAll(urls);
  const samples: Record<string, OneShot> = {};
  for (const [i, rel] of rels.entries()) {
    const sid = ids.get(rel)!;
    const prev = old?.samples[sid];
    const { sha256, bytes } = hashes.get(urls[i]!)!;
    if (prev && prev.sha256 !== sha256) console.error(`changed upstream: ${sid} (${rel})`);
    const guess = classify(rel);
    const s: OneShot = { file: rel, url: urls[i]!, sha256, bytes, tags: prev?.tags ?? guess.tags };
    const gm = prev ? prev.gm : guess.gm;
    if (gm !== undefined) s.gm = gm;
    samples[sid] = s;
  }
  for (const sid of Object.keys(old?.samples ?? {})) if (!(sid in samples)) console.error(`gone upstream: ${sid}`);
  const sorted = Object.fromEntries(Object.entries(samples).sort(([a], [b]) => (a < b ? -1 : 1)));
  const pack = { id, kind: "oneshots", description: old?.description ?? description, origin, licence: old?.licence ?? PLACEHOLDER, samples: sorted };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(pack, null, 2) + "\n");
  const check = validatePack(pack, `${id}/pack.json`);
  console.error(`wrote ${file}: ${rels.length} samples`);
  if (!check.ok) console.error(`not valid yet (fill in the licence by hand if it is new):\n  ${check.errors.join("\n  ")}`);
}

// --- Multisamples -------------------------------------------------------------

/** Sample ids for a multisample's files: the stem (with # as s) where that is unique, else the whole relative path. */
function fileIds(rels: string[]): Map<string, string> {
  const clean = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/#/g, "s").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const stems = rels.map((r) => clean(r.slice(r.lastIndexOf("/") + 1)));
  const counts = new Map<string, number>();
  for (const s of stems) counts.set(s, (counts.get(s) ?? 0) + 1);
  const ids = new Map<string, string>();
  rels.forEach((r, i) => ids.set(r, counts.get(stems[i]!)! > 1 ? clean(r.replace(/\//g, "-")) : stems[i]!));
  if (new Set(ids.values()).size !== rels.length) throw new Error("sample ids collide");
  return ids;
}

/** Pretty JSON, but a sample or region per line: a piano has hundreds of each, a soundfont 88 per program. */
function formatMultisample(pack: Record<string, unknown>): string {
  const lines = ["{"];
  const entries = Object.entries(pack);
  entries.forEach(([k, v], i) => {
    const comma = i < entries.length - 1 ? "," : "";
    if (k === "samples") {
      const ss = Object.entries(v as Record<string, unknown>);
      lines.push(`  "samples": {`, ...ss.map(([sid, s], j) => `    ${JSON.stringify(sid)}: ${JSON.stringify(s)}${j < ss.length - 1 ? "," : ""}`), `  }${comma}`);
    } else if (k === "regions") {
      const rs = v as unknown[];
      lines.push(`  "regions": [`, ...rs.map((r, j) => `    ${JSON.stringify(r)}${j < rs.length - 1 ? "," : ""}`), `  ]${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, "\n  ")}${comma}`);
    }
  });
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** Writes a multisample manifest, keeping the hand-written parts (licence, description) of an existing one. */
function writeMultisample(pack: Omit<MultisamplePack, "licence" | "description"> & { description: string }, licence?: MultisamplePack["licence"]): void {
  const file = join(workspace, "samples", pack.id, "pack.json");
  const old = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as MultisamplePack) : undefined;
  for (const [sid, s] of Object.entries(pack.samples)) {
    const prev = old?.samples[sid];
    if (prev && prev.sha256 !== s.sha256) console.error(`changed upstream: ${sid} (${s.file})`);
  }
  const out = {
    id: pack.id,
    kind: "multisample",
    description: old?.description ?? pack.description,
    origin: pack.origin,
    licence: licence ?? old?.licence ?? PLACEHOLDER,
    source: pack.source,
    samples: Object.fromEntries(Object.entries(pack.samples).sort(([a], [b]) => (a < b ? -1 : 1))),
    regions: pack.regions,
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatMultisample(out));
  const check = validatePack(out, `${pack.id}/pack.json`);
  console.error(`wrote ${file}: ${Object.keys(pack.samples).length} files, ${pack.regions.length} regions`);
  if (!check.ok) console.error(`not valid yet (fill in the licence by hand if it is new):\n  ${check.errors.join("\n  ")}`);
}

/**
 * A websfz instrument from danigb/samples. Files are matched to the commit's
 * tree; where only the case differs, the hosted name wins (the Splendid
 * piano's documents say `MF-` where the repo has `Mf-`). A region whose file
 * is not hosted at all fails the run.
 */
async function websfz(docPath: string, id: string, commitOpt: string | undefined, samplePath: string): Promise<void> {
  const repo = "danigb/samples";
  const commit = commitOpt ?? (await headCommit(repo));
  const folder = `audio/${docPath.slice(0, docPath.lastIndexOf("/") + 1)}`;
  const sourcePath = `audio/${docPath}`;
  const sourceUrl = fileUrl({ repo, commit, path: "" }, sourcePath);
  const r = await fetch(sourceUrl);
  if (!r.ok) throw new Error(`${r.status} ${sourceUrl}`);
  const text = await r.text();
  const doc = JSON.parse(text) as WebsfzDoc;
  const regions = parseWebsfz(doc, samplePath);
  const hosted = (await listFiles(repo, commit, folder)).map((f) => f.path);
  const exact = new Set(hosted);
  const folded = new Map(hosted.map((h) => [h.toLowerCase(), h]));
  const fileOf = new Map<string, string>();
  for (const reg of regions) {
    const want = regionFile(reg);
    const got = exact.has(want) ? want : folded.get(want.toLowerCase());
    if (got === undefined) throw new Error(`${want}: named by ${sourcePath} but not in ${repo}@${commit.slice(0, 7)}`);
    if (got !== want) console.error(`hosted as ${got}: ${want}`);
    fileOf.set(want, got);
  }
  const rels = [...new Set(fileOf.values())].sort();
  const ids = fileIds(rels);
  const origin = { repo, commit, path: folder };
  const urls = rels.map((rel) => fileUrl(origin, rel));
  console.error(`hashing ${urls.length} files from ${repo}@${commit.slice(0, 7)}/${folder}`);
  const hashes = await hashAll(urls);
  const samples: Record<string, SampleFile> = {};
  rels.forEach((rel, i) => (samples[ids.get(rel)!] = { file: rel, url: urls[i]!, ...hashes.get(urls[i]!)! }));
  const flat: Region[] = regions.map((reg) => {
    const out: Region = {
      sample: ids.get(fileOf.get(regionFile(reg))!)!,
      root: reg.center,
      lo: reg.lokey,
      hi: reg.hikey,
      vel: [reg.lovel, reg.hivel],
      tune: reg.tune,
      volume: reg.volume,
      offset: reg.offset,
      xfin: reg.xfin,
      xfout: reg.xfout,
      seq: [reg.seqLength, reg.seqPosition],
    };
    if (reg.loop) out.loop = reg.loop;
    return out;
  });
  const meta = doc.meta ?? {};
  writeMultisample({
    id,
    kind: "multisample",
    description: String(meta.name ?? docPath),
    origin,
    source: { path: sourcePath, url: sourceUrl, sha256: createHash("sha256").update(text).digest("hex") },
    samples,
    regions: flat,
  });
}

/** What gleitz/midi-js-soundfonts' README says each font is released under, read 2026-11-14. */
const GM_LICENCES: Record<Soundfont, MultisamplePack["licence"]> = {
  MusyngKite: {
    spdx: "CC-BY-SA-3.0",
    note: "gleitz/midi-js-soundfonts' README says the Musyng Kite soundfont (rendered from Musyng.sfpack) is released under the Creative Commons Attribution Share-Alike 3.0 license. The repo's LICENSE.txt is MIT, for its code.",
    attribution: "MusyngKite GM soundfont",
    share_alike: true,
    source: "https://github.com/gleitz/midi-js-soundfonts/blob/044fab8e1456bfafc5776e86dfd6bb8697149aef/README.md",
    read_on: "2026-11-14",
  },
  FluidR3_GM: {
    spdx: "CC-BY-3.0",
    note: "gleitz/midi-js-soundfonts' README says the Fluid soundfont (rendered from FluidR3_GM.sf2) is released under the Creative Commons Attribution 3.0 license. The repo's LICENSE.txt is MIT, for its code; the sampler used to credit the font as MIT.",
    attribution: "FluidR3 GM soundfont",
    share_alike: false,
    source: "https://github.com/gleitz/midi-js-soundfonts/blob/044fab8e1456bfafc5776e86dfd6bb8697149aef/README.md",
    read_on: "2026-11-14",
  },
};

const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
/** The soundfonts have a file per key from A0 to C8; keys outside play the edge file, repitched. */
const GM_LOW = 21;
const GM_HIGH = 108;

function gmPackId(font: Soundfont, name: string): string {
  return `gleitz-${font === "MusyngKite" ? "musyngkite" : "fluidr3-gm"}/${name.replace(/_/g, "-")}`;
}

async function gm(font: Soundfont, programs: number[], commitOpt: string | undefined): Promise<void> {
  if (!FONTS.includes(font)) throw new Error(`unknown font ${font}; expected ${FONTS.join(" | ")}`);
  if (!programs.length || programs.some((p) => !Number.isInteger(p) || p < 0 || p > 127)) throw new Error("name the GM programs, 0-127");
  const repo = GLEITZ_REPO;
  const commit = commitOpt ?? (await headCommit(repo));
  const sourcePath = `${font}/names.json`;
  const sourceUrl = fileUrl({ repo, commit, path: "" }, sourcePath);
  const r = await fetch(sourceUrl);
  if (!r.ok) throw new Error(`${r.status} ${sourceUrl}`);
  const text = await r.text();
  const names = JSON.parse(text) as string[];
  const source = { path: sourcePath, url: sourceUrl, sha256: createHash("sha256").update(text).digest("hex") };
  for (const program of programs) {
    const name = names[program];
    if (!name) throw new Error(`${sourcePath} has no program ${program}`);
    const folder = `${font}/${name}-mp3/`;
    const hosted = new Set((await listFiles(repo, commit, folder)).map((f) => f.path));
    const origin = { repo, commit, path: folder };
    const keys = Array.from({ length: GM_HIGH - GM_LOW + 1 }, (_, i) => GM_LOW + i);
    const fileFor = (k: number) => `${FLAT_NAMES[k % 12]}${Math.floor(k / 12) - 1}.mp3`;
    const missing = keys.filter((k) => !hosted.has(fileFor(k)));
    if (missing.length) throw new Error(`${folder}: no file for keys ${missing.join(", ")}`);
    const urls = keys.map((k) => fileUrl(origin, fileFor(k)));
    console.error(`program ${program} (${name}): hashing ${urls.length} files`);
    const hashes = await hashAll(urls);
    const samples: Record<string, SampleFile> = {};
    const regions: Region[] = [];
    keys.forEach((k, i) => {
      const sid = fileFor(k).replace(/\.mp3$/, "").toLowerCase();
      samples[sid] = { file: fileFor(k), url: urls[i]!, ...hashes.get(urls[i]!)! };
      regions.push({ sample: sid, root: k, lo: k === GM_LOW ? 0 : k, hi: k === GM_HIGH ? 127 : k, vel: [0, 127], tune: 0, volume: 0, offset: 0, xfin: null, xfout: null, seq: [1, 1] });
    });
    writeMultisample(
      { id: gmPackId(font, name), kind: "multisample", description: `${font} GM soundfont: ${name.replace(/_+/g, " ")} (program ${program})`, origin, source, samples, regions },
      GM_LICENCES[font],
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith("--")) opts[argv[i]!.slice(2)] = argv[++i] ?? "";
    else rest.push(argv[i]!);
  }
  const [source, folder, id] = rest;
  if (source === "gm") return gm(folder as Soundfont, rest.slice(2).map(Number), opts.commit);
  if (!source || !folder || !id) throw new Error("usage: packs (sampled|samples|websfz) <upstream folder or document> <pack id> [--commit SHA] [--ext m4a] [--sample-path DIR]; packs gm <font> <program>...");
  const trimmed = folder.replace(/^\/+|\/+$/g, "");
  if (source === "sampled") {
    const repo = "danigb/sampled";
    const commit = opts.commit ?? (await headCommit(repo));
    const path = `${trimmed}/samples/`;
    const rels = (await listFiles(repo, commit, path)).map((f) => f.path).filter((r) => !r.includes("/") && /\.(wav|m4a|ogg|mp3)$/.test(r));
    const meta = await rawText(repo, commit, `${trimmed}/sampled.json`);
    const m = meta ? (JSON.parse(meta) as { name?: string; description?: string }) : {};
    await writeOneShots(id, repo, commit, path, rels.sort(), [m.name, m.description].filter(Boolean).join(": ") || trimmed);
  } else if (source === "samples") {
    const repo = "danigb/samples";
    const commit = opts.commit ?? (await headCommit(repo));
    const ext = opts.ext ?? "m4a";
    const path = `audio/${trimmed}/`;
    const rels = (await listFiles(repo, commit, path)).map((f) => f.path).filter((r) => r.endsWith(`.${ext}`));
    await writeOneShots(id, repo, commit, path, rels.sort(), `${trimmed} from danigb/samples`);
  } else if (source === "websfz") {
    await websfz(trimmed, id, opts.commit, opts["sample-path"] ?? "");
  } else {
    throw new Error(`unknown source ${source}; expected sampled | samples | websfz | gm`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
