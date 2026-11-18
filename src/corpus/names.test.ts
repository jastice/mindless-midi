import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { allNames, nameAt, nameCount, trackName } from "./names.js";
import type { StyleCorpus } from "./schema.js";
import { MAX_NAME_LENGTH, MIN_NAMES, validateCorpus } from "./validate.js";

const corpus = (id: string) => JSON.parse(readFileSync(`styles/${id}/corpus.json`, "utf8")) as StyleCorpus;
const style = (id: string) => ({ id, corpus: corpus(id) });
const THEMED = ["minimal_techno", "berlin_techno", "psychedelic_house", "big_beat", "big_beat_razor_breaks", "electro"];

test("a theme numbers every combination of its patterns", () => {
  const theme = { patterns: ["{a} {n}", "Fixed"], lists: { a: ["Dot", "Grid"], n: ["1", "2", "3"] } };
  assert.equal(nameCount(theme), 7);
  assert.deepEqual([...allNames(theme)], ["Dot 1", "Dot 2", "Dot 3", "Grid 1", "Grid 2", "Grid 3", "Fixed"]);
  assert.throws(() => nameAt(theme, 7), RangeError);
});

test("track names are the same for the same seed and track, and differ by seed", () => {
  for (const id of THEMED) {
    const s = style(id);
    const a = Array.from({ length: 30 }, (_, i) => trackName(s, "KALT-7731", i));
    const again = Array.from({ length: 30 }, (_, i) => trackName(s, "KALT-7731", i));
    const other = Array.from({ length: 30 }, (_, i) => trackName(s, "NEBEL-0420", i));
    assert.deepEqual(a, again, id);
    assert.notDeepEqual(a, other, id);
  }
});

test("no title comes back within a long set", () => {
  for (const id of THEMED) {
    const s = style(id);
    const n = Math.min(nameCount(s.corpus.names!), 150);
    const seen = new Set(Array.from({ length: n }, (_, i) => trackName(s, "ROST-1186", i)));
    assert.equal(seen.size, n, id);
  }
});

test("each style titles from its own theme", () => {
  const titles = Object.fromEntries(THEMED.map((id) => [id, new Set(allNames(corpus(id).names!))]));
  for (const id of THEMED) {
    const name = trackName(style(id), "KALT-7731", 7);
    assert.ok(titles[id]!.has(name), `${id}: ${name}`);
    for (const other of THEMED) if (other !== id) assert.ok(!titles[other]!.has(name), `${name} is ${id}'s, not ${other}'s`);
  }
  // The genre registers, by a few marks: German only in Berlin, numbers in minimal, English in psychedelic house.
  assert.ok([...titles.berlin_techno!].some((t) => /[äöüß]|kammer|licht/i.test(t)));
  assert.ok([...titles.minimal_techno!].filter((t) => /\d/.test(t)).length > 100);
  assert.ok(![...titles.psychedelic_house!].some((t) => /[äöüß]/i.test(t)));
  for (const want of ["Sinus 4", "Low Grid", "Dot Matrix", "Halbton"]) assert.ok(titles.minimal_techno!.has(want), want);
  for (const want of ["Betonregen", "Schwarzlicht", "Kein Foto", "Kältekammer"]) assert.ok(titles.berlin_techno!.has(want), want);
  for (const want of ["Slow Bloom", "Lilac Hours", "Morning Tide", "Sun Through Smoke"]) assert.ok(titles.psychedelic_house!.has(want), want);
  for (const want of ["Open Channel", "Talk Back", "Don't Panic", "On Air"]) assert.ok(titles.electro!.has(want), want);
});

test("a style without a theme is titled by its title and the track's number", () => {
  assert.equal(trackName({ id: "retro", corpus: { title: "Retro" } }, "x", 6), "Retro 7");
});

test("validation: themes resolve, are large, and short", () => {
  const errs = (names: unknown) => {
    const c = corpus("minimal_techno") as unknown as Record<string, unknown>;
    c.names = names;
    const r = validateCorpus(c);
    return r.ok ? [] : r.errors;
  };
  for (const id of THEMED) assert.deepEqual(errs(corpus(id).names), [], id);
  const many = Array.from({ length: 12 }, (_, i) => `W${i}`);
  assert.ok(errs({ patterns: ["{nope}"], lists: {} }).some((e) => /no list "nope"/.test(e)));
  assert.ok(errs({ patterns: ["{a}"], lists: { a: ["One", "Two"] } }).some((e) => new RegExp(`needs at least ${MIN_NAMES}`).test(e)));
  assert.ok(errs({ patterns: ["{a} {a}", "W0 W0"], lists: { a: many } }).some((e) => /two ways/.test(e)));
  assert.ok(errs({ patterns: ["{a} {a}"], lists: { a: [...many.slice(1), "X".repeat(MAX_NAME_LENGTH)] } }).some((e) => /longer than/.test(e)));
  assert.ok(errs({ patterns: ["{a {a}"], lists: { a: many } }).some((e) => /stray brace/.test(e)));
});
