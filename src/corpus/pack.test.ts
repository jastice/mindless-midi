import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { InstrumentTable, fileUrl, servedPath, tablePacks, validatePack } from "./pack.js";

const manifests = (readdirSync("samples", { recursive: true }) as string[]).filter((f) => f.endsWith("pack.json")).sort();
const load = (f: string) => JSON.parse(readFileSync(`samples/${f}`, "utf8"));

test("every checked-in manifest is valid", () => {
  assert.ok(manifests.length >= 4, `found ${manifests.join(", ")}`);
  for (const f of manifests) {
    const r = validatePack(load(f), f);
    assert.ok(r.ok, `${f}:\n  ${r.ok ? "" : r.errors.join("\n  ")}`);
  }
});

test("a pack without a licence, or with the generator's placeholder, does not validate", () => {
  const pack = load(manifests[0]!);
  const errs = (mutate: (p: any) => void) => {
    const p = structuredClone(pack);
    mutate(p);
    const r = validatePack(p);
    return r.ok ? [] : r.errors;
  };
  assert.ok(errs((p) => delete p.licence).some((e) => e.startsWith("licence")));
  const placeholder = { spdx: "LicenseRef-unchecked", note: "TODO", attribution: null, share_alike: false, source: "", read_on: "" };
  assert.ok(errs((p) => (p.licence = placeholder)).some((e) => e.startsWith("licence.note")));
  assert.ok(errs((p) => (p.licence.spdx = "GPL-ish")).some((e) => e.startsWith("licence.spdx")));
});

test("structural errors carry their path", () => {
  const pack = load(manifests[0]!);
  const id = Object.keys(pack.samples)[0]!;
  const cases: [string, (p: any) => void, RegExp][] = [
    ["short hash", (p) => (p.samples[id].sha256 = "abc"), /sha256/],
    ["branch, not commit", (p) => (p.origin.commit = "main"), /origin\.commit/],
    ["url off the pin", (p) => (p.samples[id].url = p.samples[id].url.replace(p.origin.commit, "main")), /url: expected/],
    ["bad sample id", (p) => (p.samples["Kick!"] = p.samples[id]), /samples\.Kick!/],
    ["not audio", (p) => (p.samples[id].file = "README.md"), /audio file/],
  ];
  for (const [name, mutate, re] of cases) {
    const p = structuredClone(pack);
    mutate(p);
    const r = validatePack(p);
    assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${name}: ${r.ok ? "valid" : r.errors.join(" | ")}`);
  }
});

test("URLs are pinned and percent-encoded; served paths are named by id", () => {
  const origin = { repo: "danigb/samples", commit: "a".repeat(40), path: "audio/vcsl/Struck Idiophones/" };
  assert.equal(fileUrl(origin, "C#4.m4a"), `https://raw.githubusercontent.com/danigb/samples/${"a".repeat(40)}/audio/vcsl/Struck%20Idiophones/C%234.m4a`);
  assert.equal(servedPath("danigb-sampled/tr909-detroit", "kick", "kick.wav"), "danigb-sampled/tr909-detroit/kick.wav");
});

test("multisample manifests: regions name their samples, every file is played, and non-commercial licences are refused", () => {
  const pack = load("danigb-samples/vcsl-marimba/pack.json");
  assert.equal(pack.kind, "multisample");
  const errs = (mutate: (p: any) => void) => {
    const p = structuredClone(pack);
    mutate(p);
    const r = validatePack(p);
    return r.ok ? [] : r.errors;
  };
  assert.deepEqual(errs(() => {}), []);
  assert.ok(errs((p) => (p.regions[0].sample = "nope")).some((e) => /regions\.0\.sample: no sample nope/.test(e)));
  assert.ok(errs((p) => (p.regions = p.regions.filter((r: any) => r.sample !== p.regions[0].sample))).some((e) => /no region plays it/.test(e)));
  assert.ok(errs((p) => (p.regions[0].lo = 127)).some((e) => /lo 127 above hi/.test(e)));
  assert.ok(errs((p) => (p.licence.spdx = "CC-BY-NC-4.0")).some((e) => /non-commercial/.test(e)));
  assert.ok(errs((p) => (p.source.url = p.source.url.replace(p.origin.commit, "main"))).some((e) => /source\.url: expected/.test(e)));
});

test("the program table validates and names only checked-in multisample packs", () => {
  const table = InstrumentTable.parse(JSON.parse(readFileSync("samples/instruments.json", "utf8")));
  const ids = new Set(manifests.map((f) => load(f)).filter((p) => p.kind === "multisample").map((p) => p.id));
  for (const id of tablePacks(table)) assert.ok(ids.has(id), `${id} is in samples/`);
});
