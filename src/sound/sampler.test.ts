import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { type PackCredit, type SampleKit, creditLines } from "../corpus/pack.js";
import type { SoundDeclaration } from "../corpus/sound.js";
import type { ScoreNote } from "./types.js";
import { SampleCache, SampleLibrary, requiredSamples, servedAt } from "./sampler.js";

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

test("the site serves every file by its path in the sample directory: the table, manifests and samples", () => {
  const at = servedAt("http://site/samples/");
  assert.equal(at("danigb-sampled/tr909-detroit/kick.wav"), "http://site/samples/danigb-sampled/tr909-detroit/kick.wav");
  assert.equal(at("instruments.json"), "http://site/samples/instruments.json");
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

/** Reads the table and manifests from disk, and "decodes" any audio file to a frame of silence. */
const decoding = () => {
  const ctx = { decodeAudioData: async () => ({ numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(1) }) } as unknown as ConstructorParameters<typeof SampleCache>[0];
  return new SampleCache(ctx, (ref) => ref, async (ref) => (ref.endsWith(".json") ? new Response(readFileSync(`samples/${ref}`)) : new Response(new ArrayBuffer(8))));
};

test("the page credits the packs it has played, one line per credit, from the site's credits.json", async () => {
  const lib = new SampleLibrary(decoding());
  const note = (program: number): ScoreNote => ({ t: 0, dur: 0.1, key: 60, vel: 80, ch: 0, role: "lead", program });
  await lib.prepare([note(12), note(24), note(25), note(4)], "x", undefined, 1);
  assert.deepEqual(lib.packs, ["danigb-samples/vcsl-marimba", "danigb-samples/wurlitzer-ep200", "gleitz-musyngkite/acoustic-guitar-nylon", "gleitz-musyngkite/acoustic-guitar-steel"]);
  const credits = JSON.parse(readFileSync("styles/samples/credits.json", "utf8")) as PackCredit[];
  // Two soundfont programs share their font's credit.
  assert.deepEqual(creditLines(credits, lib.packs), ["VCSL marimba (CC0)", "Greg Sullivan Wurlitzer EP200 (CC BY 3.0)", "MusyngKite GM soundfont (CC BY-SA 3.0)"]);
});

test("a style that declares drum keys needs a kit", async () => {
  await assert.rejects(requiredSamples(disk(), [{ id: "x", sound: sound([], [36]) }]), /x: drums, key 36: the style has no drum kit/);
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

test("lofi's Sonic Pi kit swaps in the hard and soft recordings with touch, and its LM-2 cabasa has none", async () => {
  const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: { id: string; kit?: SampleKit }[] };
  const lofi = styles.find((s) => s.id === "lofi")!.kit!;
  const drum = (key: number, vel: number): ScoreNote => ({ t: 0, dur: 0.1, key, vel, ch: 9, role: "drums", program: 0 });
  const SP = "danigb-samples/sample-pi-drums/";
  const notes = [drum(36, 127), drum(36, 30), drum(38, 127), drum(40, 30), drum(70, 127), drum(70, 1)];
  const played = async (touch: boolean) => {
    const { plans } = await new SampleLibrary(decoding(), "MusyngKite", touch).prepare(notes, "lofi", lofi, 1);
    return plans.map((p) => p.zones.map((z) => z.url).join());
  };
  assert.deepEqual(await played(true), [
    `${SP}drum_bass_hard.m4a`,
    `${SP}drum_bass_soft.m4a`,
    `${SP}drum_snare_hard.m4a`,
    `${SP}drum_snare_soft.m4a`, // 40 plays as 38
    "danigb-samples/lm-2/cabasa.m4a",
    "danigb-samples/lm-2/cabasa.m4a",
  ]);
  assert.deepEqual(await played(false), [`${SP}drum_bass_hard.m4a`, `${SP}drum_bass_hard.m4a`, `${SP}drum_snare_soft.m4a`, `${SP}drum_snare_soft.m4a`, "danigb-samples/lm-2/cabasa.m4a", "danigb-samples/lm-2/cabasa.m4a"]);
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

test("the main site ships every file under its pack, with no upstream mirror directory, and credits each pack once", () => {
  const shipped = readdirSync("styles/samples", { withFileTypes: true });
  const dirs = shipped.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(dirs, ["danigb-samples", "gleitz-musyngkite"]);
  const credits = JSON.parse(readFileSync("styles/samples/credits.json", "utf8")) as PackCredit[];
  const packs = new Set((readdirSync("styles/samples", { recursive: true }) as string[]).filter((f) => f.endsWith("/pack.json")).map((f) => f.slice(0, -"/pack.json".length)));
  assert.deepEqual(credits.map((c) => c.pack), [...packs].sort());
});
