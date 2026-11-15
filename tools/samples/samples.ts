/**
 * The offline packaging step for samples, driven by the `style_samples` rule
 * in //bazel:music.bzl. No network: every file comes from a hash-pinned pack
 * (//bazel:samples.bzl) the rule passes in.
 *
 *   samples --params FILE --out DIR [--report FILE] [--superset]
 *
 * The params file is JSON written by the rule:
 *
 *   { "rule": "//styles:samples",
 *     "table": "<path of samples/instruments.json>",
 *     "manifests": ["<path of a pack.json>", ...],      every manifest, declared or not
 *     "styles": [{ "label": "//styles/lofi:style", "sound": "<path of its sound.json>",
 *                  "files": { "<served path>": "<path>", ... } }] }   its packs' and kit's files
 *
 * For each style it runs the sampler's own `reach()` (src/sound/sampler.ts)
 * against the manifests, and fails, naming the style, the keys and the pack,
 * when a declared key needs a file outside the style's packs. Then it writes
 * the files any style can reach to DIR as the page asks for them: the table,
 * each used pack's manifest and samples (`<pack id>/<sample id>.<ext>`), and
 * `credits.json` (one entry per pack, from its licence block).
 *
 * With --superset it skips the trim and the check, and writes every declared
 * file instead: what the dev servers and tests serve.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Params, packageSamples } from "./package_lib.js";

// js_binary runs actions from the output tree; inputs are execroot-relative.
const execroot = process.env.JS_BINARY__EXECROOT ?? process.cwd();
const p = (f: string) => (isAbsolute(f) ? f : join(execroot, f));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--superset") opts.superset = "1";
    else if (argv[i]!.startsWith("--")) opts[argv[i]!.slice(2)] = argv[++i] ?? "";
  }
  if (!opts.params || !opts.out) throw new Error("usage: samples --params FILE --out DIR [--report FILE] [--superset]");
  const params = JSON.parse(readFileSync(p(opts.params), "utf8")) as Params;
  const { summary, report } = await packageSamples(params, p(opts.out), opts.superset === "1", p);
  console.error(summary);
  if (opts.report) writeFileSync(p(opts.report), report);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
