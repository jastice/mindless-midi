/**
 * Build-time sample fetcher, driven by the `style_samples` rule in
 * //bazel:music.bzl.
 *
 *   samples --out DIR [--report FILE] [--lock FILE] [--emit-lock FILE] SOUND.json...
 *
 * Each SOUND.json is a style's `{ id, sound }` declaration (what instruments
 * and keys it can play). Works out which upstream sample files that needs,
 * downloads them and lays them out as the app's SampleCache expects
 * (`danigb/...`, `gleitz/...`), so the site serves its own samples.
 *
 * --lock pins the downloads: a JSON map of file path to sha256 that every
 * file must match (a changed or unlisted file fails the build).
 * --emit-lock writes the map for what was downloaded, to refresh the pin.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { SoundDeclaration } from "../../src/corpus/sound.js";
import { SampleCache, mirrorPath, requiredSamples } from "../../src/sound/sampler.js";

// js_binary runs actions from the output tree; inputs are execroot-relative.
const execroot = process.env.JS_BINARY__EXECROOT ?? process.cwd();
const p = (f: string) => (isAbsolute(f) ? f : join(execroot, f));

const CONCURRENCY = 16;
const ATTEMPTS = 4;

/**
 * Files upstream's sample documents name differently from how they host them.
 * The page asks for the documented name, so the mirror stores the hosted file there.
 */
const UPSTREAM_RENAMES: [RegExp, string][] = [
  // Splendid Grand Piano: the mezzo-forte layer is documented as MF-* but hosted as Mf-*.
  [/(\/splendid-grand-piano\/)MF-/, "$1Mf-"],
];

/** The file's bytes, or null if upstream has no such file (a failed request is an error). */
async function download(url: string): Promise<Uint8Array | null> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((done) => setTimeout(done, 500 * attempt));
    }
  }
  throw last;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: Record<string, string> = {};
  const inputs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith("--")) opts[argv[i]!.slice(2)] = argv[++i] ?? "";
    else inputs.push(argv[i]!);
  }
  if (!opts.out) throw new Error("missing --out");
  const out = p(opts.out);
  mkdirSync(out, { recursive: true });

  const styles = inputs.map((f) => JSON.parse(readFileSync(p(f), "utf8")) as { id: string; sound: SoundDeclaration });
  const urls = await requiredSamples(new SampleCache(), styles);

  const sizes = new Map<string, number>();
  const hashes = new Map<string, string>();
  // Some regions in upstream's sample documents name files it doesn't have. Playing one fails
  // quietly (as it does against upstream), so list them rather than failing the build; a
  // missing document is another matter, since nothing in the instrument can play without it.
  const missing: string[] = [];
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const rel = mirrorPath(url);
      if (rel === undefined) throw new Error(`no mirror path for ${url}`);
      let data = await download(url);
      for (const [from, to] of UPSTREAM_RENAMES) {
        if (data === null && from.test(url)) data = await download(url.replace(from, to));
      }
      if (data === null) {
        if (/\.(json)$/.test(url)) throw new Error(`404 ${url}`);
        missing.push(rel);
        continue;
      }
      // Upstream URLs are percent-encoded; the mirror holds plain file names the host decodes back to.
      const file = join(out, decodeURIComponent(rel));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
      sizes.set(rel, data.byteLength);
      hashes.set(rel, createHash("sha256").update(data).digest("hex"));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const lock = Object.fromEntries([...hashes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (opts["emit-lock"]) writeFileSync(p(opts["emit-lock"]), JSON.stringify(lock, null, 1) + "\n");
  if (opts.lock) {
    const pinned = JSON.parse(readFileSync(p(opts.lock), "utf8")) as Record<string, string>;
    const unlisted = Object.keys(lock).filter((rel) => pinned[rel] === undefined);
    const changed = Object.keys(lock).filter((rel) => pinned[rel] !== undefined && pinned[rel] !== lock[rel]);
    if (unlisted.length || changed.length) {
      const some = (rels: string[]) => rels.slice(0, 5).join(", ") + (rels.length > 5 ? `, and ${rels.length - 5} more` : "");
      throw new Error(
        [
          `downloads do not match the pin ${opts.lock}:`,
          ...(unlisted.length ? [`  ${unlisted.length} not pinned: ${some(unlisted)}`] : []),
          ...(changed.length ? [`  ${changed.length} changed upstream: ${some(changed)}`] : []),
          "If the styles changed or upstream changed on purpose, refresh the pin with bazel run //styles:samples_lock.",
        ].join("\n"),
      );
    }
  }

  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const lines = [
    `${sizes.size} files, ${(total / 1e6).toFixed(1)} MB, for ${styles.map((s) => s.id).join(", ")}`,
    ...(missing.length ? [`${missing.length} named by upstream's documents but not hosted: ${missing.sort().join(", ")}`] : []),
    ...[...sizes].sort(([a], [b]) => a.localeCompare(b)).map(([rel, n]) => `${String(n).padStart(9)}  ${rel}`),
  ];
  console.error(lines.slice(0, missing.length ? 2 : 1).join("\n"));
  if (opts.report) writeFileSync(p(opts.report), lines.join("\n") + "\n");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
