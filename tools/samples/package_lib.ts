/** The packaging step behind samples.ts; see there. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type PackCredit, type PackManifest, type SampleKit, licenceName, packCredit } from "../../src/corpus/pack.js";
import type { SoundDeclaration } from "../../src/corpus/sound.js";
import { CREDITS, INSTRUMENTS, type Reach, SampleCache, manifestPath, reach } from "../../src/sound/sampler.js";

export interface Params {
  rule: string;
  table: string;
  manifests: string[];
  styles: { label: string; sound: string; files: Record<string, string> }[];
}

/** Which pack a served path belongs to. */
function packOf(packs: Map<string, PackManifest>, ref: string): string | undefined {
  const m = /^([^/]+\/[^/]+)\//.exec(ref);
  return m && packs.has(m[1]!) ? m[1] : undefined;
}

/** "40-52, 55" from sorted keys. */
function spans(keys: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < keys.length; ) {
    let j = i;
    while (j + 1 < keys.length && keys[j + 1] === keys[j]! + 1) j++;
    out.push(i === j ? `${keys[i]}` : `${keys[i]}-${keys[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/**
 * Checks and writes the samples for `params` (see samples.ts). `p` resolves
 * a path from the params; `out` null checks without writing. Throws with the
 * reach problems, if any. Resolves with the one-line summary and the report.
 */
export async function packageSamples(params: Params, out: string | null, superset: boolean, p: (f: string) => string = (f) => f): Promise<{ summary: string; report: string; written: string[] }> {
  const packs = new Map<string, PackManifest>();
  const manifestFile = new Map<string, string>();
  for (const f of params.manifests) {
    const m = JSON.parse(readFileSync(p(f), "utf8")) as PackManifest;
    packs.set(m.id, m);
    manifestFile.set(manifestPath(m.id), f);
  }
  // The sampler reads the table and manifests through its cache, from disk here.
  const disk = new Map<string, string>([[INSTRUMENTS, params.table], ...manifestFile]);
  const cache = new SampleCache(undefined, (ref) => ref, async (ref) => {
    const f = disk.get(ref);
    return f === undefined ? new Response("", { status: 404 }) : new Response(readFileSync(p(f)));
  });

  /** Served path -> source file, for what gets written. */
  const write = new Map<string, string>([[INSTRUMENTS, params.table]]);
  const used = new Set<string>();
  const add = (served: string, from: string, pack: string | undefined) => {
    write.set(served, from);
    if (pack) {
      used.add(pack);
      write.set(manifestPath(pack), manifestFile.get(manifestPath(pack))!);
    }
  };

  if (superset) {
    for (const s of params.styles) for (const [served, from] of Object.entries(s.files)) add(served, from, packOf(packs, served));
  } else {
    const problems: { style: string; part: string; keys: number[]; pack: string }[] = [];
    for (const s of params.styles) {
      const style = JSON.parse(readFileSync(p(s.sound), "utf8")) as { id: string; sound: SoundDeclaration; kit?: SampleKit };
      let reached: Reach[];
      try {
        reached = await reach(cache, style);
      } catch (e) {
        throw new Error(`${params.rule}: ${s.label}: ${e instanceof Error ? e.message : e}`);
      }
      const missing = new Map<string, { part: string; keys: Set<number>; pack: string }>();
      for (const r of reached) {
        for (const ref of r.files) {
          if (ref.endsWith("/pack.json")) continue; // Comes with the pack's samples.
          const from = s.files[ref];
          const pack = packOf(packs, ref);
          if (from === undefined) {
            const name = pack ?? ref;
            const k = `${r.part}|${name}`;
            const m = missing.get(k) ?? { part: r.part, keys: new Set<number>(), pack: name };
            m.keys.add(r.key);
            missing.set(k, m);
            continue;
          }
          add(ref, from, pack);
        }
      }
      for (const m of missing.values()) problems.push({ style: style.id, part: m.part, keys: [...m.keys].sort((a, b) => a - b), pack: m.pack });
    }
    if (problems.length) {
      const byStyle = new Map<string, Set<string>>();
      for (const q of problems) (byStyle.get(q.style) ?? byStyle.set(q.style, new Set()).get(q.style)!).add(q.pack);
      throw new Error(
        [
          `${params.rule}: styles reach samples outside the packs they declare:`,
          ...problems.map((q) => `  ${q.style}: ${q.part}, key${q.keys.length > 1 ? "s" : ""} ${spans(q.keys)}: needs ${q.pack}`),
          "Declare the packs in the style's music_style(packs = [...]) (styles/<id>/BUILD.bazel), or narrow the corpus's range:",
          ...[...byStyle].map(([style, ps]) => `  ${style}: ${[...ps].sort().map((x) => `"@samples//${x}"`).join(", ")}`),
        ].join("\n"),
      );
    }
  }

  const written = [...write.keys()].sort();
  const summaryOf = (n: number, bytes: number) => `${n} files from ${used.size} packs, ${(bytes / 1e6).toFixed(1)} MB${superset ? " (every declared file)" : ""}, for ${params.styles.map((s) => s.label).join(", ")}`;
  if (out === null) return { summary: summaryOf(written.length, 0), report: "", written };
  mkdirSync(out, { recursive: true });
  let bytes = 0;
  const sizes: [string, number][] = [];
  for (const served of written) {
    const file = join(out, served);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(p(write.get(served)!), file);
    const n = readFileSync(file).byteLength;
    bytes += n;
    sizes.push([served, n]);
  }
  const credits = [...used].sort().map((id): PackCredit => {
    const pack = packs.get(id)!;
    return { pack: id, credit: packCredit(pack), licence: licenceName(pack.licence.spdx), spdx: pack.licence.spdx, attribution: pack.licence.attribution, share_alike: pack.licence.share_alike, source: pack.licence.source };
  });
  writeFileSync(join(out, CREDITS), JSON.stringify(credits, null, 1) + "\n");
  const summary = summaryOf(sizes.length, bytes);
  return { summary, report: [summary, ...sizes.map(([rel, n]) => `${String(n).padStart(9)}  ${rel}`)].join("\n") + "\n", written };
}
