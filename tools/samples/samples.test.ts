import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SampleKit } from "../../src/corpus/pack.js";
import type { SoundDeclaration } from "../../src/corpus/sound.js";
import { type Params, packageSamples } from "./package_lib.js";

// Manifests and the table from //samples:manifests; nothing is copied (out = null), so the files need not exist.
const manifests = (readdirSync("samples", { recursive: true }) as string[]).filter((f) => f.endsWith("pack.json")).map((f) => `samples/${f}`);
const dir = mkdtempSync(join(tmpdir(), "samples-test-"));

const SP = "danigb-samples/sample-pi-drums";
const sp = (id: string) => ({ id: `${SP}:${id}`, path: `${SP}/${id}.m4a` });
/** A kick with a soft variant and a snare, as lofi's. */
const KIT: SampleKit = { hits: { "36": { default: sp("drum_bass_hard"), soft: sp("drum_bass_soft") }, "38": { default: sp("drum_snare_soft") } }, aliases: { "40": 38 } };

/** A style's params entry: its sound declaration and kit, and every file of the packs it declares and the kit names (as fake paths). */
function style(id: string, sound: SoundDeclaration, packs: string[], kit: SampleKit | null = KIT): Params["styles"][number] {
  const file = join(dir, `${id}.sound.json`);
  writeFileSync(file, JSON.stringify({ id, sound, kit: kit ?? undefined }));
  const files: Record<string, string> = {};
  for (const h of Object.values(kit?.hits ?? {})) for (const v of [h.default, h.hard, h.soft]) if (v) files[v.path] = `/fetched/${v.path}`;
  for (const m of manifests) {
    const pack = JSON.parse(readFileSync(m, "utf8")) as { id: string; samples: Record<string, { file: string }> };
    if (!packs.includes(pack.id)) continue;
    for (const [sid, s] of Object.entries(pack.samples)) files[`${pack.id}/${sid}${s.file.slice(s.file.lastIndexOf("."))}`] = `/fetched/${pack.id}/${sid}`;
  }
  return { label: `//styles/${id}:style`, sound: file, files };
}
const params = (...styles: Params["styles"]): Params => ({ rule: "//styles:test_samples", table: "samples/instruments.json", manifests, styles });
const guitar = (range: [number, number]): SoundDeclaration => ({ instruments: [{ role: "lead", program: 24, octave: 4, range }], drums: [36, 38] });
const GUITAR = "gleitz-musyngkite/acoustic-guitar-nylon";

test("a style whose ranges stay inside its packs ships only what they reach", async () => {
  const { written } = await packageSamples(params(style("lofi", guitar([60, 62]), [GUITAR])), null, false);
  assert.deepEqual(written.filter((f) => f.startsWith(GUITAR)), [`${GUITAR}/c4.mp3`, `${GUITAR}/d4.mp3`, `${GUITAR}/db4.mp3`, `${GUITAR}/pack.json`]);
  assert.ok(written.includes("instruments.json"));
  // The kit's hits for the declared keys, with every touch variant, under their pack and its manifest.
  assert.deepEqual(written.filter((f) => f.startsWith(SP)), [`${SP}/drum_bass_hard.m4a`, `${SP}/drum_bass_soft.m4a`, `${SP}/drum_snare_soft.m4a`, `${SP}/pack.json`]);
});

test("a range that reaches a pack the style does not declare fails, naming the style, keys and pack", async () => {
  await assert.rejects(packageSamples(params(style("lofi", guitar([60, 62]), [])), null, false), (e: Error) => {
    assert.match(e.message, /^\/\/styles:test_samples: styles reach samples outside the packs they declare:/);
    assert.match(e.message, /lofi: lead, program 24, keys 60-62: needs gleitz-musyngkite\/acoustic-guitar-nylon/);
    assert.match(e.message, /lofi: "@samples\/\/gleitz-musyngkite\/acoustic-guitar-nylon"/);
    return true;
  });
});

test("a style that declares drum keys and has no kit fails", async () => {
  await assert.rejects(packageSamples(params(style("lofi", guitar([60, 62]), [GUITAR], null)), null, false), /lofi:style: lofi: drums, key 36: the style has no drum kit/);
});

test("a program the table does not list fails with the style and key", async () => {
  const sound: SoundDeclaration = { instruments: [{ role: "pad", program: 127, octave: 4, range: [50, 52] }], drums: [] };
  await assert.rejects(packageSamples(params(style("lofi", sound, [])), null, false), /lofi:style: lofi: pad, program 127, key 50: program 127 has no entry in samples\/instruments.json/);
});

test("the superset is every declared file, with no check", async () => {
  const { written } = await packageSamples(params(style("lofi", guitar([60, 62]), [GUITAR])), null, true);
  assert.equal(written.filter((f) => f.startsWith(`${GUITAR}/`) && f.endsWith(".mp3")).length, 88);
});
