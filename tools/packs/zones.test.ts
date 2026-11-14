/**
 * The zone-equivalence test of docs/sample-format-plan.md, step 2: for every
 * program in samples/instruments.json and both soundfonts, the zones the
 * sampler plays from the pack manifest are the zones it played from
 * upstream's own document before packs, for every key, a spread of
 * velocities, and enough notes to go round every round robin.
 *
 * The reference is the old loader: the program switch it had (below), the
 * websfz reading in ./websfz.ts, and the soundfont's file naming. The
 * documents come from each manifest's pinned `source` (//samples:sources).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { FONTS, type InstrumentTable, type MultisamplePack, servedPath } from "../../src/corpus/pack.js";
import { type Zone, SampleCache, instrumentFor } from "../../src/sound/sampler.js";
import { type SfzRegion, type WebsfzDoc, parseWebsfz, regionUrl } from "./websfz.js";

const DANIGB = "https://danigb.github.io/samples/";
const GLEITZ = "https://gleitz.github.io/midi-js-soundfonts/";

/** The sampler's program switch before packs: document and sample folder per SFZ program; every other program was the soundfont. */
const OLD_SFZ: Record<number, [string, string]> = {
  0: ["splendid-grand-piano/websfz.json", ""],
  1: ["splendid-grand-piano/websfz.json", ""],
  2: ["splendid-grand-piano/websfz.json", ""],
  4: ["gs-e-pianos/Wurlitzer EP200/wurlitzer-ep200.websfz.json", "Samples/"],
  5: ["gs-e-pianos/Wurlitzer EP200/wurlitzer-ep200.websfz.json", "Samples/"],
  11: ["vcsl/Struck Idiophones/vibraphone-soft-mallets.websfz.json", ""],
  12: ["vcsl/Struck Idiophones/marimba.websfz.json", ""],
  32: ["dsmolken/double-bass/dsmolkenrubnerbasspizz.websfz.json", ""],
  66: ["vcsl/Reed Aerophones/tenor-saxophone-vibrato.websfz.json", ""],
};

/** The old zones for an SFZ instrument, as its `zones()` computed them. */
function oldSfz(regions: SfzRegion[], base: string): (key: number, vel: number) => Zone[] {
  const rr = new Map<number, number>();
  const ramp = (x: number, lo: number, hi: number) => (hi <= lo ? (x >= hi ? 1 : 0) : Math.max(0, Math.min(1, (x - lo) / (hi - lo))));
  return (key, vel) => {
    const counter = rr.get(key) ?? 0;
    rr.set(key, counter + 1);
    const out: Zone[] = [];
    for (const r of regions) {
      if (key < r.lokey || key > r.hikey || vel < r.lovel || vel > r.hivel) continue;
      if (r.seqLength > 1 && (counter % r.seqLength) + 1 !== r.seqPosition) continue;
      let w = 1;
      if (r.xfin) w *= ramp(vel, r.xfin[0], r.xfin[1]);
      if (r.xfout) w *= 1 - ramp(vel, r.xfout[0], r.xfout[1]);
      if (w < 0.02) continue;
      out.push({ url: regionUrl(base, r), rate: Math.pow(2, (key - r.center + r.tune / 100) / 12), gain: Math.sqrt(w) * Math.pow(10, r.volume / 20), offset: r.offset });
    }
    return out;
  };
}

/** The old zones for a soundfont program: one file per key from A0 to C8, the edge files repitched beyond. */
function oldGm(font: string, name: string): (key: number) => Zone[] {
  const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  return (key) => {
    const k = Math.max(21, Math.min(108, key));
    return [{ url: `${GLEITZ}${font}/${name}-mp3/${FLAT[k % 12]}${Math.floor(k / 12) - 1}.mp3`, rate: Math.pow(2, (key - k) / 12), gain: 1, offset: 0 }];
  };
}

const table = JSON.parse(readFileSync("samples/instruments.json", "utf8")) as InstrumentTable;
const manifest = (id: string) => JSON.parse(readFileSync(`samples/${id}/pack.json`, "utf8")) as MultisamplePack;
const source = (pack: MultisamplePack) => readFileSync(`samples/sources/${pack.id}/${pack.source.path.slice(pack.source.path.lastIndexOf("/") + 1)}`, "utf8");

/** The served path a pack gives an old upstream URL: the same file, matched without case (the Splendid piano's documents say MF- where the repo has Mf-). */
function served(pack: MultisamplePack, oldUrl: string, base: string): string {
  assert.ok(oldUrl.startsWith(base), oldUrl);
  const file = decodeURIComponent(oldUrl.slice(base.length)).toLowerCase();
  const hit = Object.entries(pack.samples).find(([, s]) => s.file.toLowerCase() === file);
  assert.ok(hit, `${pack.id} has no file for ${oldUrl}`);
  return servedPath(pack.id, hit[0], hit[1].file);
}

const cache = new SampleCache(undefined, (ref) => ref, async (ref) => new Response(readFileSync(`samples/${ref}`)));
const VELS = [1, 20, 40, 52, 64, 80, 100, 127];
const ROUNDS = 4;

for (const font of FONTS) {
  for (const [program, entry] of Object.entries(table.programs)) {
    const p = Number(program);
    test(`program ${p} (${font}): ${entry.packs[font]} plays what upstream's document did`, async () => {
      const pack = manifest(entry.packs[font]);
      let old: (key: number, vel: number) => Zone[];
      let base: string;
      const sfz = OLD_SFZ[p];
      if (sfz) {
        assert.equal(pack.source.path, `audio/${sfz[0]}`, "the table names the pack made from the program's old document");
        assert.equal(entry.packs.MusyngKite, entry.packs.FluidR3_GM, "an SFZ library plays the same in both fonts");
        const docUrl = DANIGB + sfz[0];
        base = docUrl.slice(0, docUrl.lastIndexOf("/") + 1);
        old = oldSfz(parseWebsfz(JSON.parse(source(pack)) as WebsfzDoc, sfz[1]), base);
        // The old loader asked for the URL with spaces and # encoded; compare on the decoded file.
        base = encodeURI(base);
      } else {
        assert.equal(pack.source.path, `${font}/names.json`);
        const name = (JSON.parse(source(pack)) as string[])[p] ?? "acoustic_grand_piano";
        assert.equal(pack.origin.path, `${font}/${name}-mp3/`, `program ${p} is ${name} in ${font}`);
        base = `${GLEITZ}${font}/${name}-mp3/`;
        old = oldGm(font, name);
      }
      const now = await instrumentFor(cache, font, p);
      let zones = 0;
      for (let round = 0; round < ROUNDS; round++) {
        for (let key = 0; key <= 127; key++) {
          for (const vel of VELS) {
            const want = old(key, vel).map((z) => ({ ...z, url: served(pack, z.url, base) }));
            const got = await now.zones(key, vel);
            assert.equal(got.length, want.length, `key ${key} vel ${vel} round ${round}: ${got.map((z) => z.url)} vs ${want.map((z) => z.url)}`);
            got.forEach((z, i) => {
              const w = want[i]!;
              assert.equal(z.url, w.url, `key ${key} vel ${vel}`);
              assert.ok(Math.abs(z.rate - w.rate) < 1e-12 && Math.abs(z.gain - w.gain) < 1e-12 && z.offset === w.offset, `key ${key} vel ${vel}: ${JSON.stringify(z)} vs ${JSON.stringify(w)}`);
            });
            zones += got.length;
          }
        }
      }
      assert.ok(zones > 0, "plays something");
    });
  }
}

test("every multisample manifest is reached from the table", () => {
  const all = (readdirSync("samples", { recursive: true }) as string[]).filter((f) => f.endsWith("pack.json")).map((f) => JSON.parse(readFileSync(`samples/${f}`, "utf8")) as { id: string; kind: string });
  const named = new Set(Object.values(table.programs).flatMap((e) => Object.values(e.packs)));
  assert.deepEqual(all.filter((m) => m.kind === "multisample" && !named.has(m.id)).map((m) => m.id), []);
});
