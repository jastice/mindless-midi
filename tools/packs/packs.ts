/**
 * Writes a sample pack manifest (`samples/<pack id>/pack.json`) from an
 * upstream repo, pinned to a commit. Run by hand when a pack is added or
 * bumped; the build never reads upstream's own metadata.
 *
 *   bazel run //tools/packs -- sampled DM/TR-909/Detroit danigb-sampled/tr909-detroit [--commit SHA]
 *     One-shots from danigb/sampled: the set's `samples/` folder.
 *   bazel run //tools/packs -- samples drum-machines/TR-808 danigb-samples/tr-808 [--commit SHA] [--ext m4a]
 *     One-shots from danigb/samples: every file with the extension under `audio/<folder>/`.
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
import { type OneShot, type PackManifest, fileUrl, validatePack } from "../../src/corpus/pack.js";

const workspace = process.env.BUILD_WORKSPACE_DIRECTORY ?? process.cwd();
const CONCURRENCY = 8;

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
  const tree = await getJson<{ truncated: boolean; tree: { path: string; type: string; size?: number }[] }>(
    `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`,
  );
  if (tree.truncated) throw new Error(`${repo}: tree listing truncated`);
  return tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix)).map((e) => ({ path: e.path.slice(prefix.length), size: e.size ?? 0 }));
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

async function write(id: string, repo: string, commit: string, path: string, rels: string[], description: string): Promise<void> {
  const file = join(workspace, "samples", id, "pack.json");
  const old = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PackManifest) : undefined;
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith("--")) opts[argv[i]!.slice(2)] = argv[++i] ?? "";
    else rest.push(argv[i]!);
  }
  const [source, folder, id] = rest;
  if (!source || !folder || !id) throw new Error("usage: packs (sampled|samples) <upstream folder> <pack id> [--commit SHA] [--ext m4a]");
  const trimmed = folder.replace(/^\/+|\/+$/g, "");
  if (source === "sampled") {
    const repo = "danigb/sampled";
    const commit = opts.commit ?? (await headCommit(repo));
    const path = `${trimmed}/samples/`;
    const rels = (await listFiles(repo, commit, path)).map((f) => f.path).filter((r) => !r.includes("/") && /\.(wav|m4a|ogg|mp3)$/.test(r));
    const meta = await rawText(repo, commit, `${trimmed}/sampled.json`);
    const m = meta ? (JSON.parse(meta) as { name?: string; description?: string }) : {};
    await write(id, repo, commit, path, rels.sort(), [m.name, m.description].filter(Boolean).join(": ") || trimmed);
  } else if (source === "samples") {
    const repo = "danigb/samples";
    const commit = opts.commit ?? (await headCommit(repo));
    const ext = opts.ext ?? "m4a";
    const path = `audio/${trimmed}/`;
    const rels = (await listFiles(repo, commit, path)).map((f) => f.path).filter((r) => r.endsWith(`.${ext}`));
    await write(id, repo, commit, path, rels.sort(), `${trimmed} from danigb/samples`);
  } else {
    throw new Error(`unknown source ${source}; expected sampled | samples`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
