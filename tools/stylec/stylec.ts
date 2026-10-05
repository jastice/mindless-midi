/**
 * Build-time style compiler, driven by the `music_style` / `style_pack`
 * rules in //bazel:music.bzl.
 *
 *   stylec bundle --corpus C --id ID --bank N --color HEX --out OUT [--report R]
 *     Validate a corpus (failing the build on errors), attach metadata and
 *     calibrate loudness by rendering through the real synth.
 *   stylec pack --out OUT BUNDLE...
 *     Merge style bundles into the single styles.json the app loads.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { StyleBundle } from "../../src/corpus/schema.js";
import { validateCorpus } from "../../src/corpus/validate.js";
import { calibrate } from "../render/calibrate_lib.js";

// js_binary runs actions from the output tree; inputs are execroot-relative.
const execroot = process.env.JS_BINARY__EXECROOT ?? process.cwd();
const p = (f: string) => (isAbsolute(f) ? f : join(execroot, f));

function flags(argv: string[]): { opts: Record<string, string>; rest: string[] } {
  const opts: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) opts[a.slice(2)] = argv[++i] ?? "";
    else rest.push(a);
  }
  return { opts, rest };
}

function need(opts: Record<string, string>, k: string): string {
  const v = opts[k];
  if (v === undefined || v === "") throw new Error(`missing --${k}`);
  return v;
}

async function bundle(opts: Record<string, string>): Promise<void> {
  const corpusPath = need(opts, "corpus");
  const result = validateCorpus(JSON.parse(readFileSync(p(corpusPath), "utf8")));
  for (const w of result.warnings) console.error(`${corpusPath}: warning: ${w}`);
  if (!result.ok) {
    throw new Error(`${corpusPath}: invalid style corpus:\n  ${result.errors.join("\n  ")}`);
  }
  const out: StyleBundle = {
    id: need(opts, "id"),
    bank: Number(need(opts, "bank")),
    color: need(opts, "color"),
    corpus: result.corpus,
  };
  const cal = await calibrate(out);
  out.mixer = cal.mixer;
  if (Object.keys(cal.formMixers).length) out.formMixers = cal.formMixers;
  out.gain = cal.gain;
  writeFileSync(p(need(opts, "out")), JSON.stringify(out));
  if (opts.report) writeFileSync(p(opts.report), cal.report.join("\n") + "\n");
}

function pack(opts: Record<string, string>, inputs: string[]): void {
  const styles = inputs.map((f) => JSON.parse(readFileSync(p(f), "utf8")) as StyleBundle);
  const ids = new Set<string>();
  for (const s of styles) {
    if (ids.has(s.id)) throw new Error(`duplicate style id ${s.id}`);
    ids.add(s.id);
  }
  writeFileSync(p(need(opts, "out")), JSON.stringify({ styles }));
}

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  const { opts, rest } = flags(argv);
  if (cmd === "bundle") await bundle(opts);
  else if (cmd === "pack") pack(opts, rest);
  else throw new Error(`unknown command ${cmd}; expected bundle | pack`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
