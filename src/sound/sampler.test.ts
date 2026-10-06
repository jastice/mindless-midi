import assert from "node:assert/strict";
import { test } from "node:test";
import type { SoundDeclaration } from "../corpus/sound.js";
import { SampleCache, mirrorPath, mirroredAt, requiredSamples } from "./sampler.js";

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
