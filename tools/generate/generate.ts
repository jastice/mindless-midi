/**
 * Regenerate checked-in style corpora with Claude.
 *
 *   bazel run //tools/generate -- styles/metroid styles/lofi
 *   bazel run //tools/generate -- --dry-run styles/metroid
 *
 * Each argument is a workspace-relative directory holding brief.md; the
 * result is written to corpus.json next to it. Credentials are resolved by
 * the SDK (ANTHROPIC_API_KEY or an `ant auth login` profile).
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DEFAULT_MODEL, SYSTEM_PROMPT, formatCorpus, generateCorpus, userPrompt } from "./generate_lib.js";

function main(argv: string[]): Promise<void> | void {
  const root = process.env.BUILD_WORKSPACE_DIRECTORY ?? process.cwd();
  let model = DEFAULT_MODEL;
  let dryRun = false;
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model") model = argv[++i] ?? model;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: generate [--model ID] [--dry-run] <style-dir>...");
      return;
    } else dirs.push(a);
  }
  if (!dirs.length) throw new Error("no style directories given (e.g. styles/metroid)");

  const jobs = dirs.map((d) => {
    const dir = resolve(root, d);
    return { id: basename(dir), dir, brief: readFileSync(join(dir, "brief.md"), "utf8") };
  });

  if (dryRun) {
    console.log(`# model: ${model}\n\n## system\n${SYSTEM_PROMPT}\n`);
    for (const j of jobs) console.log(`## user (${j.id})\n${userPrompt(j.id, j.brief)}\n`);
    return;
  }

  const client = new Anthropic();
  return Promise.all(
    jobs.map(async (j) => {
      const corpus = await generateCorpus(client, j.id, j.brief, { model, log: (m) => console.error(m) });
      const out = join(j.dir, "corpus.json");
      writeFileSync(out, formatCorpus(corpus));
      console.error(`${j.id}: wrote ${out}`);
    }),
  ).then(() => undefined);
}

Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
