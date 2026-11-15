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

// --- Parts -------------------------------------------------------------------

/** The corpus with four parts (two of them drums, one with its own patch and material), then `mutate`. */
function withParts(mutate: (c: any) => void = () => {}) {
  const c = base();
  c.patches = [structuredClone(PATCH)];
  c.parts = [
    { id: "kick", role: "drums", lanes: ["kick"] },
    { id: "kit", role: "drums", lanes: ["snare", "closedHat"], enters: 0.2 },
    { id: "low", role: "bass" },
    { id: "run", role: "arp", patch: "blip", material: "run", enters: 0.5, octave: 3, volume: 0.3 },
  ];
  c.motifs.find((m: any) => m.role === "arp").material = "run";
  c.arrangement = { change: 0.4, swap: 0.2, thin: 0.3, evolve: 0.2 };
  mutate(c);
  return validateCorpus(c);
}

test("a corpus may declare parts and arrangement rates, and keeps them", () => {
  const r = withParts();
  assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  assert.deepEqual(r.corpus.parts!.map((p) => p.id), ["kick", "kit", "low", "run"]);
  assert.equal(r.corpus.arrangement!.change, 0.4);
  assert.ok(!r.warnings.some((w) => /parts|patch "blip"|arrangement/.test(w)), r.warnings.join("\n"));
  const plain = validateCorpus(base());
  assert.ok(plain.ok && plain.corpus.parts === undefined && plain.corpus.arrangement === undefined);
});

test("a malformed parts block is rejected, and the error says which part and why", () => {
  const cases: Array<[string, (c: any) => void, RegExp]> = [
    ["unknown role", (c) => (c.parts[2].role = "vocals"), /parts\.2\.role/],
    ["unknown lane", (c) => (c.parts[1].lanes = ["cowbell"]), /parts\.1\.lanes\.0/],
    ["unknown patch", (c) => (c.parts[3].patch = "nope"), /parts\[3\] "run": unknown patch "nope"/],
    ["unknown material", (c) => (c.parts[3].material = "nope"), /parts\[3\] "run": unknown material "nope" \(no arp motifs are tagged with it\)/],
    ["material nobody plays", (c) => (c.motifs.find((m: any) => m.role === "lead").material = "orphan"), /motifs\[\d+\] "[^"]+": unknown material "orphan" \(no lead part has it\)/],
    ["material of another role's part", (c) => (c.drums[0].material = "run"), /drums\[0\] "[^"]+": unknown material "run" \(no drums part has it\)/],
    ["duplicate ids", (c) => (c.parts[2].id = "kick"), /parts\[2\] "kick": duplicate part id/],
    ["a lane claimed twice", (c) => c.parts[1].lanes.push("kick"), /parts\[1\] "kit": lane "kick" is already played by part "kick"/],
    ["drums without lanes", (c) => delete c.parts[0].lanes, /parts\[0\] "kick": a drums part names the lanes it plays/],
    ["empty lanes", (c) => (c.parts[0].lanes = []), /parts\.0\.lanes/],
    ["lanes on a bass", (c) => (c.parts[2].lanes = ["kick"]), /parts\[2\] "low": lanes are for drums parts/],
    ["a role with no instrument", (c) => (c.instruments = c.instruments.filter((i: any) => i.role !== "bass")), /parts\[2\] "low": role "bass" has no instrument/],
    ["no untagged material left", (c) => c.motifs.forEach((m: any) => m.role === "bass" && (m.material = "run")), /parts\[2\] "low": there are no untagged bass motifs for it to play/],
    ["lanes no groove uses", (c) => (c.drums.forEach((d: any) => (d.lanes.shaker = "")), (c.parts[1].lanes = ["shaker"])), /parts\[1\] "kit": no groove has anything on its lanes \(shaker\)/],
    ["enters out of range", (c) => (c.parts[1].enters = 1.5), /parts\.1\.enters/],
    ["part without an id", (c) => delete c.parts[0].id, /parts\.0\.id/],
    ["a rate out of range", (c) => (c.arrangement.change = 2), /arrangement\.change/],
    ["a missing rate", (c) => delete c.arrangement.evolve, /arrangement\.evolve/],
    ["no parts at all", (c) => (c.parts = []), /^parts:/],
  ];
  for (const [name, mutate, re] of cases) {
    const r = withParts(mutate);
    const e = r.ok ? [] : r.errors;
    assert.ok(e.some((x) => re.test(x)), `${name}: ${e.join(" | ") || "no errors"}`);
  }
  // A material tag means nothing without parts.
  const e = errors((c) => (c.motifs[0].material = "run"));
  assert.ok(e.some((x) => /motifs\[0\] "[^"]+": material "run" needs a parts block/.test(x)), e.join(" | "));
});

test("parts that are valid but odd are warnings", () => {
  const cases: Array<[string, (c: any) => void, RegExp]> = [
    ["a patch on a drums part", (c) => (c.parts[0].patch = "blip"), /parts\[0\] "kick": drums play the kit/],
    ["a level on a drums part", (c) => (c.parts[1].volume = 0.5), /parts\[1\] "kit": a kit is levelled as one/],
    ["no kick", (c) => (c.parts[0].lanes = ["rim"]), /no part plays the kick lane/],
    ["rates without parts", (c) => (delete c.parts, delete c.motifs.find((m: any) => m.material).material), /arrangement: does nothing without parts/],
  ];
  for (const [name, mutate, re] of cases) {
    const r = withParts(mutate);
    assert.ok(r.ok, `${name}: ${r.ok ? "" : r.errors.join(" | ")}`);
    assert.ok(r.warnings.some((x) => re.test(x)), `${name}: ${r.warnings.join(" | ")}`);
  }
});
