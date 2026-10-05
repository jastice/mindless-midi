/**
 * Render generated music to a WAV file (and optionally the MIDI) offline.
 *
 *   bazel run //tools/render -- --styles lofi,jazz_trio --seconds 120 --out /tmp/mix.wav [--seed abc] [--midi /tmp/mix.mid] [--raw 1]
 *
 * Output goes through the same gain/AGC/limiter stage as the browser unless --raw is given.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StyleBundle } from "../../src/corpus/schema.js";
import { barsToMidi } from "../../src/engine/midi_file.js";
import { levels, render, toWav } from "./render_lib.js";

async function main(argv: string[]): Promise<void> {
  const opt: Record<string, string> = { seconds: "60", seed: "render", styles: "" };
  for (let i = 0; i < argv.length; i += 2) opt[argv[i]!.replace(/^--/, "")] = argv[i + 1] ?? "";
  const root = process.env.BUILD_WORKSPACE_DIRECTORY ?? process.cwd();
  const pack = JSON.parse(readFileSync(opt.pack ?? "styles/styles.json", "utf8")) as { styles: StyleBundle[] };
  const ids = opt.styles ? opt.styles.split(",") : pack.styles.map((s) => s.id);
  const styles = pack.styles.filter((s) => ids.includes(s.id));
  if (!styles.length) throw new Error(`no styles matched ${ids.join(",")}; have ${pack.styles.map((s) => s.id).join(",")}`);

  const r = await render(styles, { seconds: Number(opt.seconds), seed: opt.seed!, applyGain: opt.raw === undefined });
  const st = levels(r);
  console.error(
    `rendered ${opt.seconds}s in ${(r.wallMs / 1000).toFixed(2)}s (${((Number(opt.seconds) * 1000) / r.wallMs).toFixed(1)}x realtime); ` +
      `peak ${st.peak.toFixed(3)} rms ${st.rms.toFixed(3)}`,
  );
  for (const b of r.bars.filter((b) => b.info.barInPiece === 0)) {
    console.error(`  piece ${b.info.pieceIndex}: ${b.info.styleTitle}, ${b.info.keyName}, ${b.bpm} bpm, ${b.info.pieceBars} bars`);
  }
  if (opt.out) {
    const out = resolve(root, opt.out);
    writeFileSync(out, toWav(r));
    console.error(`wrote ${out}`);
  }
  if (opt.midi) {
    const out = resolve(root, opt.midi);
    writeFileSync(out, barsToMidi(r.bars));
    console.error(`wrote ${out}`);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
