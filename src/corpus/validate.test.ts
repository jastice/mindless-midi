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

// --- Patches and the synth kit ------------------------------------------------

const PATCH = {
  id: "blip",
  osc: { wave: "saw", voices: 2, detune: 8 },
  filter: { type: "band", cutoff: 800, q: 2, keytrack: 1, env: 2000, a: 0.002, d: 0.1, s: 0, r: 0.1 },
  amp: { a: 0.002, d: 0.2, s: 0, r: 0.1 },
  mod: [{ target: "cutoff", shape: "sine", beats: 16, depth: 0.5 }],
  level: 0.5,
};
const KIT = {
  kick: { f0: 180, f1: 48, sweep: 0.03, decay: 0.15, drive: 2, click: 0.3, sub: { level: 0.7, decay: 0.2 } },
  rumble: { level: 0.4, cutoff: 90, decay: 1.5 },
  snare: { tone: 200, toneDecay: 0.06, noiseDecay: 0.15, noiseHp: 1800, mix: 0.7 },
  hatScale: 1,
  hatDecay: 0.04,
  hat: { tone: 9000, q: 1, hp: 7000, decay: 0.02, open: 0.15, metal: 0.5 },
  perc: [{ lane: "tomLow", freq: 110, bend: 5, sweep: 0.03, decay: 0.2, pan: 0, level: 0.6 }],
};

/** The corpus with a patch on its lead and a kit, then `mutate`. */
function withSounds(mutate: (c: any) => void = () => {}) {
  const c = base();
  c.patches = [structuredClone(PATCH)];
  c.synthKit = structuredClone(KIT);
  c.instruments.find((i: any) => i.role === "lead").patch = "blip";
  mutate(c);
  return validateCorpus(c);
}

test("a corpus may declare patches and a synth kit, and keeps them", () => {
  const r = withSounds();
  assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  assert.deepEqual(r.corpus.patches, [PATCH]);
  assert.deepEqual(r.corpus.synthKit, KIT);
  assert.equal(r.corpus.instruments.find((i) => i.role === "lead")?.patch, "blip");
  assert.ok(!r.warnings.some((w) => /patch|synthKit/.test(w)), r.warnings.join("\n"));
  // And a corpus with neither is as valid as before.
  const plain = validateCorpus(base());
  assert.ok(plain.ok && plain.corpus.patches === undefined && plain.corpus.synthKit === undefined);
});

test("malformed patches and kits are rejected, with their path", () => {
  const cases: Array<[string, (c: any) => void, RegExp]> = [
    ["unknown wave", (c) => (c.patches[0].osc.wave = "supersaw"), /patches\.0\.osc\.wave/],
    ["unknown filter type", (c) => (c.patches[0].filter.type = "notch"), /patches\.0\.filter\.type/],
    ["cutoff out of range", (c) => (c.patches[0].filter.cutoff = 40000), /patches\.0\.filter\.cutoff/],
    ["no resonance", (c) => (c.patches[0].filter.q = 0), /patches\.0\.filter\.q/],
    ["zero release", (c) => (c.patches[0].amp.r = 0), /patches\.0\.amp\.r/],
    ["missing level", (c) => delete c.patches[0].level, /patches\.0\.level/],
    ["missing envelope", (c) => delete c.patches[0].amp, /patches\.0\.amp/],
    ["no voices", (c) => (c.patches[0].osc.voices = 0), /patches\.0\.osc\.voices/],
    ["modulator without a rate", (c) => (c.patches[0].mod[0].beats = 0), /patches\.0\.mod\.0\.beats/],
    ["unknown modulator target", (c) => (c.patches[0].mod[0].target = "resonance"), /patches\.0\.mod\.0\.target/],
    ["too many modulators", (c) => (c.patches[0].mod = Array(5).fill(c.patches[0].mod[0])), /patches\.0\.mod/],
    ["glide as a flag", (c) => (c.patches[0].glide = true), /patches\.0\.glide/],
    ["patch without an id", (c) => delete c.patches[0].id, /patches\.0\.id/],
    ["duplicate patch id", (c) => c.patches.push(structuredClone(c.patches[0])), /duplicate id "blip"/],
    ["instrument names a missing patch", (c) => (c.instruments[0].patch = "nope"), /unknown patch "nope"/],
    ["form instrument names a missing patch", (c) => (c.forms[0].instruments = [{ ...c.instruments[0], patch: "nope" }]), /forms\[0\]\.instruments\[0\]: unknown patch/],
    ["kick too low", (c) => (c.synthKit.kick.f1 = 5), /synthKit\.kick\.f1/],
    ["kit without a snare", (c) => delete c.synthKit.snare, /synthKit\.snare/],
    ["rumble cutoff too high", (c) => (c.synthKit.rumble.cutoff = 2000), /synthKit\.rumble\.cutoff/],
    ["percussion on a lane that does not exist", (c) => (c.synthKit.perc[0].lane = "cowbell"), /synthKit\.perc\.0\.lane/],
  ];
  for (const [name, mutate, re] of cases) {
    const r = withSounds(mutate);
    const e = r.ok ? [] : r.errors;
    assert.ok(e.some((x) => re.test(x)), `${name}: ${e.join(" | ") || "no errors"}`);
  }
});

test("settings that do nothing are warnings, not errors", () => {
  const cases: Array<[string, (c: any) => void, RegExp]> = [
    ["pulse width on a saw", (c) => (c.patches[0].osc.pw = 0.3), /osc\.pw does nothing/],
    ["pw modulator on a saw", (c) => (c.patches[0].mod[0].target = "pw"), /needs wave "pulse"/],
    ["width modulator without spread", (c) => (c.patches[0].mod[0].target = "width"), /needs osc\.spread/],
    ["unused patch", (c) => delete c.instruments.find((i: any) => i.role === "lead").patch, /patch "blip" is not used/],
    ["patch on the drums", (c) => (c.instruments.find((i: any) => i.role === "drums").patch = "blip"), /drums play the kit/],
    ["kick sweeping up", (c) => (c.synthKit.kick.f0 = 40), /sweeps up/],
  ];
  for (const [name, mutate, re] of cases) {
    const r = withSounds(mutate);
    assert.ok(r.ok, `${name}: ${r.ok ? "" : r.errors.join(" | ")}`);
    assert.ok(r.warnings.some((x) => re.test(x)), `${name}: ${r.warnings.join(" | ")}`);
  }
});
