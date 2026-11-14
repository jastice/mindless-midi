import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SampleKit } from "../corpus/pack.js";
import type { SoundDeclaration } from "../corpus/sound.js";
import type { ScoreNote } from "./types.js";
import { SampleCache, SampleLibrary, mirrorPath, mirroredAt, requiredSamples } from "./sampler.js";

const DANIGB = "https://danigb.github.io/samples/";
const GLEITZ = "https://gleitz.github.io/midi-js-soundfonts/";

const names = Array.from({ length: 128 }, (_, i) => `program_${i}`);
const piano = {
  groups: [
    {
      regions: [
        { sample: "PP-A0", lokey: 21, hikey: 22, pitch_keycenter: 33 },
        { sample: "PP-C#4", lokey: 60, hikey: 62, pitch_keycenter: 61, lovel: 0, hivel: 60 },
        { sample: "Mf-C#4", lokey: 60, hikey: 62, pitch_keycenter: 61, lovel: 61, hivel: 127 },
        { sample: "PP-C7", lokey: 96, hikey: 96, pitch_keycenter: 96 },
        { sample: "pedal", lokey: 60, hikey: 62, locc64: 64 },
      ],
    },
  ],
};

// Sample documents come from fixtures; audio is never fetched (nothing here plays).
const docs: Record<string, unknown> = {
  [`${GLEITZ}MusyngKite/names.json`]: names,
  [`${DANIGB}splendid-grand-piano/websfz.json`]: piano,
};
const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const doc = docs[String(url)];
    return doc === undefined ? new Response("", { status: 404 }) : Response.json(doc);
  }) as typeof fetch;
});
test.after(() => {
  globalThis.fetch = realFetch;
});

const sound = (instruments: SoundDeclaration["instruments"], drums: number[] = []): SoundDeclaration => ({ instruments, drums });
const inst = (program: number, range: [number, number]) => ({ role: "lead" as const, program, octave: 4, range });

test("a mirror maps upstream URLs onto one directory", () => {
  assert.equal(mirrorPath(`${DANIGB}vcsl/x.m4a`), "danigb/vcsl/x.m4a");
  assert.equal(mirrorPath(`${GLEITZ}MusyngKite/names.json`), "gleitz/MusyngKite/names.json");
  assert.equal(mirrorPath("https://example.com/a.m4a"), undefined);
  assert.equal(mirroredAt("http://site/samples/")(`${GLEITZ}MusyngKite/a.mp3`), "http://site/samples/gleitz/MusyngKite/a.mp3");
  assert.throws(() => mirroredAt("http://site/samples/")("https://example.com/a.m4a"));
  assert.equal(mirroredAt("http://site/samples/")("danigb-sampled/tr909-detroit/kick.wav"), "http://site/samples/danigb-sampled/tr909-detroit/kick.wav", "pack samples sit in the same directory");
});

test("soundfont instruments need one file per key, within the font's range", async () => {
  const urls = await requiredSamples(new SampleCache(), [{ id: "x", sound: sound([inst(24, [60, 62])]) }]);
  assert.deepEqual(urls, [`${GLEITZ}MusyngKite/names.json`, ...["C4", "D4", "Db4"].map((n) => `${GLEITZ}MusyngKite/program_24-mp3/${n}.mp3`)].sort());

  const wide = await requiredSamples(new SampleCache(), [{ id: "x", sound: sound([inst(24, [10, 120])]) }]);
  assert.equal(wide.length, 88 + 1, "keys outside A0..C8 reuse the edge files");
});

test("styles sharing a program share its files", async () => {
  const a = { id: "a", sound: sound([inst(24, [60, 62])]) };
  const b = { id: "b", sound: sound([inst(24, [61, 64])]) };
  const urls = await requiredSamples(new SampleCache(), [a, b]);
  assert.equal(urls.length, 1 + 5, "C4 to E4 once each, plus names.json");
});

test("sampled instruments need every region the keys reach, and their document", async () => {
  const urls = await requiredSamples(new SampleCache(), [{ id: "x", sound: sound([inst(0, [61, 61])]) }]);
  assert.deepEqual(urls, [
    `${DANIGB}splendid-grand-piano/Mf-C%234.m4a`,
    `${DANIGB}splendid-grand-piano/PP-C%234.m4a`,
    `${DANIGB}splendid-grand-piano/websfz.json`,
  ]);
});

test("drum kits need the declared keys, through the aliases the sampler plays them by", async () => {
  const urls = await requiredSamples(new SampleCache(), [{ id: "lofi", sound: sound([], [36, 40]) }]);
  assert.deepEqual(urls, [
    `${DANIGB}sample-pi/drums/one-shots/kick/drum_bass_hard.m4a`,
    `${DANIGB}sample-pi/drums/one-shots/snare/drum_snare_soft.m4a`,
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
  const urls = await requiredSamples(new SampleCache(), [{ id: "minimal_techno", sound: sound([], [35, 40]), kit }]);
  assert.deepEqual(urls, [
    "danigb-sampled/tr909-detroit/kick-short.wav",
    "danigb-sampled/tr909-detroit/kick.wav",
    "danigb-sampled/tr909-detroit/snare.wav",
    "danigb-samples/sample-pi-drums/bd_haus.m4a",
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

test("minimal_techno plays its own kit from sample packs, and Claudia's lock pins no drum file", () => {
  const { styles } = JSON.parse(readFileSync("styles/claudia.json", "utf8")) as { styles: { id: string; kit?: SampleKit }[] };
  const techno = styles.find((s) => s.id === "minimal_techno");
  assert.ok(techno?.kit, "minimal_techno's bundle carries a kit");
  assert.ok(techno.kit.hits["36"]!.default.id.startsWith("danigb-sampled/tr909-detroit:"));
  const lock = Object.keys(JSON.parse(readFileSync("styles/claudia_samples.lock.json", "utf8")) as Record<string, string>);
  assert.deepEqual(lock.filter((f) => !f.startsWith("gleitz/")), []);
});
