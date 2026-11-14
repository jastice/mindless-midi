/**
 * With no patch and no declared kit, the synth must render what it always
 * did. These hashes of the output samples were taken from the code before
 * patches existed (at a956a73); a change to them changes how the shipped apps
 * sound.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { type Stereo, stereo } from "./dsp.js";
import { renderSynthNote } from "./synth.js";
import type { ScoreNote } from "./types.js";

const SR = 24000;

function digest(parts: Stereo[]): string {
  const h = createHash("sha256");
  for (const s of parts) {
    h.update(new Uint8Array(s.l.buffer));
    h.update(new Uint8Array(s.r.buffer));
  }
  return h.digest("hex").slice(0, 16);
}

/** A plain note, a legato note touching it (a glide), a slide and a swell, with and without touch. */
function program(p: number): string {
  const note = (t: number, dur: number, key: number, vel: number, more: Partial<ScoreNote> = {}): ScoreNote => ({ t, dur, key, vel, ch: 0, role: "lead", program: p, ...more });
  const notes = [
    note(0.1, 0.4, 48, 100, { legato: true }),
    note(0.5, 0.5, 55, 70, { legato: true }),
    note(1.2, 0.3, 72, 120, { gesture: "slide", curves: { bend: [[0, -2], [0.1, 0]] } }),
    note(1.8, 0.5, 60, 50, { gesture: "swell", curves: { level: [[0, 0.5], [0.3, 1]] } }),
  ];
  return digest(
    [false, true].map((touch) => {
      const out = stereo(SR * 4);
      notes.forEach((n, i) => renderSynthNote(out, n, SR, "retro", notes[i - 1], touch));
      return out;
    }),
  );
}

const KIT_STYLES = [
  "no_such_style", "lofi", "synthwave", "electro_swing", "jazz_trio", "retro", "metroid", "monkey_island", "bossa_nova", "funk", "western",
  "celtic", "musette", "liquid_dnb", "castlevania", "jrpg", "disco", "baroque", "midnight_platform", "courtyard_nine", "low_log",
];
const DRUM_KEYS = [35, 36, 37, 38, 39, 40, 42, 44, 45, 46, 47, 48, 49, 50, 51, 57, 59, 70];

/** Every drum of a style's kit, soft and hard, and a choked open hat, with and without touch. */
function kit(styleId: string): string {
  const notes: ScoreNote[] = [];
  DRUM_KEYS.forEach((key, i) => {
    notes.push({ t: i * 0.25, dur: 0.1, key, vel: 60, ch: 9, role: "drums", program: 0 });
    notes.push({ t: i * 0.25 + 0.125, dur: 0.1, key, vel: 115, ch: 9, role: "drums", program: 0 });
  });
  notes.push({ t: 5, dur: 0.08, key: 46, vel: 100, ch: 9, role: "drums", program: 0, gesture: "choke" });
  return digest(
    [false, true].map((touch) => {
      const out = stereo(SR * 8);
      for (const n of notes) renderSynthNote(out, n, SR, styleId, undefined, touch);
      return out;
    }),
  );
}

// prettier-ignore
const PROGRAMS: string[] = [
  "e1ed9168722452ce", "e1ed9168722452ce", "e1ed9168722452ce", "e1ed9168722452ce", "bf76d5eb629813a7", "bf76d5eb629813a7", "b7444ea646dc594d", "0c7990de9bf58fc2",
  "3360cad3394d4138", "3360cad3394d4138", "3360cad3394d4138", "254512ae8bd121d6", "29be9dcd32ad4390", "9901c5ac8c5e73bf", "3360cad3394d4138", "3360cad3394d4138",
  "636e66816910ae47", "636e66816910ae47", "636e66816910ae47", "636e66816910ae47", "636e66816910ae47", "636e66816910ae47", "636e66816910ae47", "636e66816910ae47",
  "08005d1790d7ba96", "903bc7243046c2eb", "903bc7243046c2eb", "903bc7243046c2eb", "a1cbf2ded8628225", "903bc7243046c2eb", "903bc7243046c2eb", "903bc7243046c2eb",
  "8bfb8ab8f2b29eb2", "8bfb8ab8f2b29eb2", "d1f734fed6c6fdd6", "8bfb8ab8f2b29eb2", "8bfb8ab8f2b29eb2", "8bfb8ab8f2b29eb2", "e8c6af1a2c295f57", "e8c6af1a2c295f57",
  "c282d7cc5ae80775", "c282d7cc5ae80775", "22439ea4a77013bd", "22439ea4a77013bd", "22439ea4a77013bd", "b335e93d7768f2b0", "d11549c9662ffbce", "22439ea4a77013bd",
  "5cac05f7a3019c20", "e8878952e33f60dc", "5cac05f7a3019c20", "5cac05f7a3019c20", "55546435ffe8e999", "55546435ffe8e999", "55546435ffe8e999", "55546435ffe8e999",
  "19823fae062c7d37", "19823fae062c7d37", "19823fae062c7d37", "433d5d4ae2cb1b7e", "19823fae062c7d37", "1bfa90eb1cedb20f", "1bfa90eb1cedb20f", "19823fae062c7d37",
  "14c2a6327ed73592", "14c2a6327ed73592", "14c2a6327ed73592", "14c2a6327ed73592", "75ed69fc13fb9c45", "75ed69fc13fb9c45", "75ed69fc13fb9c45", "673da5b9ba1352ca",
  "50658f524f40ef6a", "50658f524f40ef6a", "50658f524f40ef6a", "50658f524f40ef6a", "50658f524f40ef6a", "50658f524f40ef6a", "50658f524f40ef6a", "50658f524f40ef6a",
  "6221092c62ca465b", "9cc85b9abcd3ecb8", "9cc85b9abcd3ecb8", "9cc85b9abcd3ecb8", "9cc85b9abcd3ecb8", "9cc85b9abcd3ecb8", "9cc85b9abcd3ecb8", "9cc85b9abcd3ecb8",
  "4ca38d4735d69297", "4ca38d4735d69297", "c8c36d936f589d54", "55546435ffe8e999", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297",
  "4ca38d4735d69297", "4ca38d4735d69297", "3360cad3394d4138", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297",
  "dc4c542b92005209", "dc4c542b92005209", "dc4c542b92005209", "dc4c542b92005209", "4ca38d4735d69297", "75ed69fc13fb9c45", "4ca38d4735d69297", "4ca38d4735d69297",
  "3360cad3394d4138", "3360cad3394d4138", "87b3b1d744c49d3e", "f0ef3659d1ccaf0f", "f0ef3659d1ccaf0f", "f0ef3659d1ccaf0f", "f0ef3659d1ccaf0f", "f0ef3659d1ccaf0f",
  "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297", "4ca38d4735d69297",
];

const KITS: Record<string, string> = {
  no_such_style: "167e9fade75c3a76",
  lofi: "8be4fe250bccc6d1",
  synthwave: "c01704da44f18baf",
  electro_swing: "0b0df28fd5e5f56d",
  jazz_trio: "85d24f46adebf24b",
  retro: "7d7a8c14a3ca0eb5",
  metroid: "d79c4c0a43d7e84f",
  monkey_island: "5dd477b412312e74",
  bossa_nova: "f5602ef72603f788",
  funk: "926a62b3ebbf348e",
  western: "5b0a88085e2fc8f7",
  celtic: "e29c4c27aa6861d7",
  musette: "bae4e1242f963475",
  liquid_dnb: "c304ce1de6e5aece",
  castlevania: "08296afaf955607a",
  jrpg: "ef3d2c3fa34a16a4",
  disco: "75c863129cf7279e",
  baroque: "20efd5d68c76f8fb",
  midnight_platform: "dd16857400b5c97b",
  courtyard_nine: "3624e77315dddf8e",
  low_log: "6321eec60dfa37aa",
};

test("every program renders the samples it did before patches", () => {
  const now = Array.from({ length: 128 }, (_, p) => program(p));
  if (!PROGRAMS.length) console.log("PROGRAMS=" + JSON.stringify(now));
  assert.deepEqual(now, PROGRAMS);
});

test("every built-in kit renders the samples it did before patches", () => {
  const now = Object.fromEntries(KIT_STYLES.map((id) => [id, kit(id)]));
  if (!Object.keys(KITS).length) console.log("KITS=" + JSON.stringify(now));
  assert.deepEqual(now, KITS);
});
