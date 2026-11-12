import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateCorpus } from "./validate.js";

const base = () => JSON.parse(readFileSync("styles/retro/corpus.json", "utf8"));

function errors(mutate: (c: any) => void): string[] {
  const c = base();
  mutate(c);
  const r = validateCorpus(c);
  return r.ok ? [] : r.errors;
}

test("checked-in corpus is valid", () => {
  assert.deepEqual(errors(() => {}), []);
});

test("structural errors carry their path", () => {
  const e = errors((c) => (c.tempo.min = "fast"));
  assert.ok(e.some((x) => x.startsWith("tempo.min")), e.join("\n"));
});

test("musical errors are caught", () => {
  const cases: Array<[string, (c: any) => void, RegExp]> = [
    ["bad chord", (c) => (c.progressions[0].chords[0].symbol = "IIIIX"), /chord/],
    ["ragged progression", (c) => (c.progressions[0].chords[0].beats = 3), /whole number/],
    ["drum lane length", (c) => (c.drums[0].lanes.kick = "x..."), /expected 16/],
    ["drum chars", (c) => (c.drums[0].lanes.kick = "x".repeat(15) + "?"), /only X x o/],
    ["motif onset", (c) => (c.motifs[0].notes[0].t = 99), /outside length/],
    ["role without instrument", (c) => (c.instruments = c.instruments.filter((i: any) => i.role !== "bass")), /no instrument/],
    ["role without material", (c) => (c.motifs = c.motifs.filter((m: any) => m.role !== "arp")), /no material/],
    ["unknown bound progression", (c) => (c.forms[0].sections[0].progression = "nope"), /unknown progression/],
    ["duplicate role", (c) => c.instruments.push({ ...c.instruments[0] }), /duplicate role/],
    ["wrong beat grouping", (c) => (c.beatGroups = [3, 2]), /beatGroups.*sum/],
    ["empty beat grouping", (c) => (c.beatGroups = []), /beatGroups/],
    ["zero beat group", (c) => (c.beatGroups = [0, 4]), /beatGroups/],
    ["fractional beat group", (c) => (c.beatGroups = [1.5, 2.5]), /beatGroups/],
  ];
  for (const [name, mutate, re] of cases) {
    const e = errors(mutate);
    assert.ok(e.some((x) => re.test(x)), `${name}: ${e.join(" | ") || "no errors"}`);
  }
});

test("beat grouping is optional and accepts groups adding to the meter", () => {
  assert.deepEqual(errors((c) => (c.beatGroups = [2, 2])), []);
  assert.deepEqual(errors((c) => delete c.beatGroups), []);
});

test("a nine-beat aksak grouping fits a 9-beat bar", () => {
  const e = errors((c) => {
    c.beatsPerBar = 9;
    c.beatGroups = [2, 2, 2, 3];
  });
  assert.ok(!e.some((x) => /beatGroups|beatsPerBar/.test(x)), e.join(" | "));
});
