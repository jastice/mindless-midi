import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SoundDeclaration } from "../../src/corpus/sound.js";
import { type Params, packageSamples } from "./package_lib.js";

// Manifests and the table from //samples:manifests; nothing is copied (out = null), so the files need not exist.
const manifests = (readdirSync("samples", { recursive: true }) as string[]).filter((f) => f.endsWith("pack.json")).map((f) => `samples/${f}`);
const dir = mkdtempSync(join(tmpdir(), "samples-test-"));

/** A style's params entry: its sound declaration, and every file of the packs it declares (as fake paths). */
function style(id: string, sound: SoundDeclaration, packs: string[]): Params["styles"][number] {
  const file = join(dir, `${id}.sound.json`);
  writeFileSync(file, JSON.stringify({ id, sound }));
  const files: Record<string, string> = {};
  for (const m of manifests) {
    const pack = JSON.parse(readFileSync(m, "utf8")) as { id: string; samples: Record<string, { file: string }> };
    if (!packs.includes(pack.id)) continue;
    for (const [sid, s] of Object.entries(pack.samples)) files[`${pack.id}/${sid}${s.file.slice(s.file.lastIndexOf("."))}`] = `/fetched/${pack.id}/${sid}`;
  }
  return { label: `//styles/${id}:style`, sound: file, files };
}
const params = (...styles: Params["styles"]): Params => ({ rule: "//styles:test_samples", table: "samples/instruments.json", manifests, styles });
const guitar = (range: [number, number]): SoundDeclaration => ({ instruments: [{ role: "lead", program: 24, octave: 4, range }], drums: [36, 38] });
const DRUMS = ["danigb-samples/sample-pi-drums"];
const GUITAR = "gleitz-musyngkite/acoustic-guitar-nylon";

test("a style whose ranges stay inside its packs ships only what they reach", async () => {
  const { written } = await packageSamples(params(style("lofi", guitar([60, 62]), [GUITAR, ...DRUMS])), null, false);
  assert.deepEqual(written.filter((f) => f.startsWith(GUITAR)), [`${GUITAR}/c4.mp3`, `${GUITAR}/d4.mp3`, `${GUITAR}/db4.mp3`, `${GUITAR}/pack.json`]);
  assert.ok(written.includes("instruments.json"));
  // The older kits' drums ship at their mirror path, from the pack that holds the same file.
  assert.ok(written.includes("danigb/sample-pi/drums/one-shots/kick/drum_bass_hard.m4a"), written.join(" "));
});

test("a range that reaches a pack the style does not declare fails, naming the style, keys and pack", async () => {
  await assert.rejects(packageSamples(params(style("lofi", guitar([60, 62]), DRUMS)), null, false), (e: Error) => {
    assert.match(e.message, /^\/\/styles:test_samples: styles reach samples outside the packs they declare:/);
    assert.match(e.message, /lofi: lead, program 24, keys 60-62: needs gleitz-musyngkite\/acoustic-guitar-nylon/);
    assert.match(e.message, /lofi: "@samples\/\/gleitz-musyngkite\/acoustic-guitar-nylon"/);
    return true;
  });
  // Widening the drums to a key the kit plays from another pack (lofi's 70 is an LM-2 cabasa).
  const wider = { ...guitar([60, 62]), drums: [36, 38, 70] };
  await assert.rejects(packageSamples(params(style("lofi", wider, [GUITAR, ...DRUMS])), null, false), /lofi: drums, key 70: needs danigb-samples\/lm-2/);
});

test("a program the table does not list fails with the style and key", async () => {
  const sound: SoundDeclaration = { instruments: [{ role: "pad", program: 127, octave: 4, range: [50, 52] }], drums: [] };
  await assert.rejects(packageSamples(params(style("lofi", sound, DRUMS)), null, false), /lofi:style: lofi: pad, program 127, key 50: program 127 has no entry in samples\/instruments.json/);
});

test("the superset is every declared file, with no check", async () => {
  const { written } = await packageSamples(params(style("lofi", guitar([60, 62]), [GUITAR])), null, true);
  assert.equal(written.filter((f) => f.startsWith(`${GUITAR}/`) && f.endsWith(".mp3")).length, 88);
});
