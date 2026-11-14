import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import type { SampleKit } from "../corpus/pack.js";
import type { SoundDeclaration } from "../corpus/sound.js";
import type { ScoreNote } from "./types.js";
import { SampleCache, SampleLibrary, mirrorPath, mirroredAt, requiredSamples } from "./sampler.js";

const DANIGB = "https://danigb.github.io/samples/";
const GUITAR = "gleitz-musyngkite/acoustic-guitar-nylon";

// The table and manifests from //samples:manifests; audio is never fetched (nothing here plays).
const disk = () => new SampleCache(undefined, (ref) => ref, async (ref) => {
  try {
    return new Response(readFileSync(`samples/${ref}`));
  } catch {
    return new Response("", { status: 404 });
  }
});

const sound = (instruments: SoundDeclaration["instruments"], drums: number[] = []): SoundDeclaration => ({ instruments, drums });
const inst = (program: number, range: [number, number]) => ({ role: "lead" as const, program, octave: 4, range });

test("a mirror maps the older kits' upstream URLs onto the sample directory, beside the packs", () => {
  assert.equal(mirrorPath(`${DANIGB}drum-machines/LM-2/kick.m4a`), "danigb/drum-machines/LM-2/kick.m4a");
  assert.equal(mirrorPath("https://example.com/a.m4a"), undefined);
  assert.throws(() => mirroredAt("http://site/samples/")("https://example.com/a.m4a"));
  assert.equal(mirroredAt("http://site/samples/")("danigb-sampled/tr909-detroit/kick.wav"), "http://site/samples/danigb-sampled/tr909-detroit/kick.wav", "pack samples sit in the same directory");
  assert.equal(mirroredAt("http://site/samples/")("instruments.json"), "http://site/samples/instruments.json");
});

test("soundfont instruments need one file per key, within the font's range, and their manifest", async () => {
  const urls = await requiredSamples(disk(), [{ id: "x", sound: sound([inst(24, [60, 62])]) }]);
  assert.deepEqual(urls, [`${GUITAR}/c4.mp3`, `${GUITAR}/d4.mp3`, `${GUITAR}/db4.mp3`, `${GUITAR}/pack.json`, "instruments.json"]);

  const wide = await requiredSamples(disk(), [{ id: "x", sound: sound([inst(24, [10, 120])]) }]);
  assert.equal(wide.length, 88 + 2, "keys outside A0..C8 reuse the edge files");
});

test("styles sharing a program share its files", async () => {
  const a = { id: "a", sound: sound([inst(24, [60, 62])]) };
  const b = { id: "b", sound: sound([inst(24, [61, 64])]) };
  const urls = await requiredSamples(disk(), [a, b]);
  assert.equal(urls.length, 2 + 5, "C4 to E4 once each, plus the table and the manifest");
});

test("sampled instruments need every region the keys reach: every velocity layer, under the names the repo hosts", async () => {
  const urls = await requiredSamples(disk(), [{ id: "x", sound: sound([inst(0, [61, 61])]) }]);
  assert.ok(urls.includes("danigb-samples/splendid-grand-piano/pack.json"));
  const layers = urls.filter((u) => u.endsWith(".m4a")).map((u) => u.split("/").pop()!.split("-")[0]).sort();
  assert.deepEqual([...new Set(layers)], ["ff", "mf", "mp", "pp"], urls.join(" "));
});

test("the font picks the soundfont group; an SFZ library plays in both", async () => {
  const fluid = await requiredSamples(disk(), [{ id: "x", sound: sound([inst(24, [60, 60]), inst(12, [60, 60])]) }], "FluidR3_GM");
  assert.ok(fluid.includes("gleitz-fluidr3-gm/acoustic-guitar-nylon/c4.mp3"));
  assert.ok(fluid.includes("danigb-samples/vcsl-marimba/pack.json"));
});

test("a program the table does not list cannot be declared, and plays nothing", async () => {
  await assert.rejects(requiredSamples(disk(), [{ id: "x", sound: sound([inst(127, [60, 60])]) }]), /x: lead, program 127, key 60: program 127 has no entry in samples\/instruments.json/);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const n: ScoreNote = { t: 0, dur: 0.1, key: 60, vel: 80, ch: 0, role: "lead", program: 127 };
    const { plans } = await new SampleLibrary(disk()).prepare([n], "x", undefined, 1);
    assert.deepEqual(plans[0]!.zones, []);
  } finally {
    console.warn = warn;
  }
});

test("instrument credits come from the packs' licence blocks", async () => {
  const lib = new SampleLibrary(disk());
  const note = (program: number): ScoreNote => ({ t: 0, dur: 0.1, key: 60, vel: 80, ch: 0, role: "lead", program });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await lib.prepare([note(12), note(24), note(25), note(4)], "x", undefined, 1);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(lib.labels.sort(), ["Greg Sullivan Wurlitzer EP200 (CC BY 3.0)", "MusyngKite GM soundfont (CC BY-SA 3.0)", "VCSL marimba (CC0)"]);
});

test("drum kits need the declared keys, through the aliases the sampler plays them by", async () => {
  const urls = await requiredSamples(disk(), [{ id: "lofi", sound: sound([], [36, 40]) }]);
  assert.deepEqual(urls, [
    `${DANIGB}sample-pi/drums/one-shots/kick/drum_bass_hard.m4a`,
    `${DANIGB}sample-pi/drums/one-shots/snare/drum_snare_soft.m4a`,
    "instruments.json",
  ]);
});

const s909 = (id: string) => ({ id: `danigb-sampled/tr909-detroit:${id}`, path: `danigb-sampled/tr909-detroit/${id}.wav` });
const kit: SampleKit = {
  hits: {
    "36": { default: s909("kick"), hard: { id: "danigb-samples/sample-pi-drums:bd_haus", path: "danigb-samples/sample-pi-drums/bd_haus.m4a" }, soft: s909("kick-short") },
    "38": { default: s909("snare") },
    "42": { default: s909("hihat-closed") },
  },
  aliases: { "35": 36, "40": 38 },
};

test("a style's own kit needs every touch variant of the keys it reaches, through its aliases", async () => {
  const urls = await requiredSamples(disk(), [{ id: "minimal_techno", sound: sound([], [35, 40]), kit }]);
  assert.deepEqual(urls, [
    "danigb-sampled/tr909-detroit/kick-short.wav",
    "danigb-sampled/tr909-detroit/kick.wav",
    "danigb-sampled/tr909-detroit/snare.wav",
    "danigb-samples/sample-pi-drums/bd_haus.m4a",
    "instruments.json",
  ]);
});

test("with touch, a kit's hard and soft recordings play at the ends of the velocity range", async () => {
  const drum = (key: number, vel: number): ScoreNote => ({ t: 0, dur: 0.1, key, vel, ch: 9, role: "drums", program: 0 });
  const played = async (touch: boolean, notes: ScoreNote[]) => {
    // Downloads fail (nothing is served here); the plans are what counts.
    const { plans } = await new SampleLibrary(new SampleCache(), "MusyngKite", touch).prepare(notes, "minimal_techno", kit, 1);
    return plans.map((p) => p.zones.map((z) => z.url).join());
  };
  const notes = [drum(36, 120), drum(36, 80), drum(36, 30), drum(38, 120), drum(40, 30), drum(99, 80)];
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await played(true, notes), [
      "danigb-samples/sample-pi-drums/bd_haus.m4a",
      "danigb-sampled/tr909-detroit/kick.wav",
      "danigb-sampled/tr909-detroit/kick-short.wav",
      "danigb-sampled/tr909-detroit/snare.wav",
      "danigb-sampled/tr909-detroit/snare.wav",
      "",
    ]);
    assert.deepEqual((await played(false, notes)).slice(0, 3), Array(3).fill("danigb-sampled/tr909-detroit/kick.wav"));
  } finally {
    console.warn = warn;
  }
});

test("minimal_techno plays its own kit from sample packs, and Claudia's site ships no older-kit drum file", () => {
  const { styles } = JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: { id: string; kit?: SampleKit }[] };
  const techno = styles.find((s) => s.id === "minimal_techno");
  assert.ok(techno?.kit, "minimal_techno's bundle carries a kit");
  assert.ok(techno.kit.hits["36"]!.default.id.startsWith("danigb-sampled/tr909-detroit:"));
  const shipped = readdirSync("styles/claudia_samples", { recursive: true }) as string[];
  assert.ok(shipped.includes("danigb-sampled/tr909-detroit/kick.wav"));
  assert.ok(shipped.includes("instruments.json") && shipped.includes("credits.json"));
  assert.deepEqual(shipped.filter((f) => f === "danigb" || f.startsWith("danigb/")), []);
  const credits = JSON.parse(readFileSync("styles/claudia_samples/credits.json", "utf8")) as { pack: string }[];
  assert.ok(credits.some((c) => c.pack === "danigb-sampled/tr909-detroit"));
});
