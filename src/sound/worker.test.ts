/**
 * What the render worker streams for the shipped styles must not change when
 * it learns to key its windows and levellers by part. This drives the worker
 * itself, as the player does, and hashes the stems it posts. The hashes were
 * taken from the code before parts existed (at 500d40c); a change to them
 * changes how Mindless Midi and Mighty Midi sound.
 *
 * The worker keeps its mix state for its lifetime, so the runs depend on
 * their order: add new ones at the end.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Role } from "../corpus/constants.js";
import type { StyleBundle } from "../corpus/schema.js";
import { Conductor } from "../engine/conductor.js";
import { velocityScale } from "../engine/parts.js";
import { DEFAULT_PIECE_OPTIONS } from "../engine/piece.js";
import type { StemEngine, ToStems, ToWorker } from "./protocol.js";
import type { PlannedNote, SampleData } from "./sampler.js";
import { barScore } from "./score.js";
import { styleSound } from "./sound_set.js";

const SR = 24000;
const FLOOR = 0.42;
const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };

// The worker is a module worker: it listens on `self`.
const scope: { onmessage: ((e: { data: ToWorker }) => void) | null } = { onmessage: null };
(globalThis as unknown as { self: typeof scope }).self = scope;
await import("./worker.js");

let posted: ToStems[] = [];
let cleared: (() => void) | null = null;
const port = {
  postMessage(msg: ToStems) {
    if (msg.type === "clear") cleared?.();
    else posted.push(msg);
  },
};
const send = (data: ToWorker) => scope.onmessage!({ data });
send({ type: "init", sampleRate: SR, port } as unknown as ToWorker);

// One recording for every sampled note: a decaying tone.
const sample: SampleData = { channels: [new Float32Array(SR / 2)], sampleRate: SR };
for (let i = 0; i < SR / 2; i++) sample.channels[0]![i] = 0.4 * Math.sin(i * 0.11) * Math.exp(-i / (SR * 0.12));
send({ type: "samples", items: [["x", sample]] });

/** Bars of a style through the worker, as the player sends them; a hash of everything it posts. */
async function run(style: StyleBundle, engine: StemEngine, weighted: boolean, bars: number): Promise<string> {
  posted = [];
  const conductor = new Conductor([style], `worker-${style.id}`, weighted ? { ...DEFAULT_PIECE_OPTIONS, expression: { gestures: true, velocityFloor: FLOOR } } : DEFAULT_PIECE_OPTIONS);
  const levels = Object.fromEntries(style.corpus.instruments.map((i) => [i.role, i.volume])) as Partial<Record<Role, number>>;
  const sound = styleSound(style.corpus);
  const programs = new Map<number, number>();
  const patches = new Map<number, string>();
  let start = 0;
  for (let b = 0; b < bars; b++) {
    const bar = conductor.nextBar();
    const frames = Math.round(((bar.beats * 60) / bar.bpm) * SR);
    const notes = barScore(bar, programs, weighted ? { legato: true, gestures: true, patches } : { patches }).map((n) => ({ ...n, t: n.t + start / SR }));
    const plans: PlannedNote[] | undefined =
      engine === "samples" ? notes.map((n) => ({ zones: [{ url: "x", rate: n.role === "drums" ? 1 : Math.pow(2, (n.key - 60) / 12), gain: 1, offset: 0 }], release: 0.08, sustain: false, drum: n.role === "drums" })) : undefined;
    send({
      type: "bar",
      engine,
      start,
      frames,
      styleId: style.id,
      newPiece: bar.info.barInPiece === 0,
      levels,
      notes,
      ...(plans && { plans }),
      ...(weighted && { mix: { intensity: bar.info.intensity, lean: velocityScale(bar.info.intensity, FLOOR) }, touch: true }),
      ...(sound && { sound }),
    });
    start += frames;
  }
  await new Promise<void>((resolve) => {
    cleared = resolve;
    send({ type: "clear", from: start });
  });
  const h = createHash("sha256");
  for (const msg of posted) {
    if (msg.type !== "pcm") continue;
    h.update(`${msg.start}/${msg.frames}/${msg.roles.join(",")}`);
    for (const d of msg.data) h.update(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
  }
  return h.digest("hex").slice(0, 16);
}

const GOLDEN: Record<string, string> = {
  "metroid/synth/plain": "a3160d572d4c2b97",
  "metroid/synth/weighted": "c0bbf2b48bda7ff3",
  "retro/synth/plain": "ec297bd175d62b0d",
  "retro/synth/weighted": "fc59088150791a97",
  "lofi/synth/plain": "99f3dd10b23fc8dd",
  "lofi/synth/weighted": "f2152d81eb7cc822",
  "jazz_trio/synth/plain": "1760c57e7d7c3212",
  "jazz_trio/synth/weighted": "9dc933ad6bc61d97",
  "minimalist/synth/plain": "468bc7ac0e7e57a4",
  "minimalist/synth/weighted": "892e63afc3cdcc03",
  "monkey_island/synth/plain": "c69afcafebad474d",
  "monkey_island/synth/weighted": "1357243ab6f16405",
  "electro_swing/synth/plain": "f1da00af9c973f6f",
  "electro_swing/synth/weighted": "f7958a83026ea6b9",
  "synthwave/synth/plain": "6b94bcd6d23f4ea2",
  "synthwave/synth/weighted": "1a12a153d66eea0b",
  "bossa_nova/synth/plain": "3fa0391eb3eaa921",
  "bossa_nova/synth/weighted": "fd0fdd504cffa1c5",
  "funk/synth/plain": "734325bff9997ebb",
  "funk/synth/weighted": "247e91bc0b4622f4",
  "western/synth/plain": "a3dc3101b1ddbf2b",
  "western/synth/weighted": "1707431c7304536d",
  "celtic/synth/plain": "56db59266ff7a707",
  "celtic/synth/weighted": "9131ba3967efb978",
  "musette/synth/plain": "59385e6231593b98",
  "musette/synth/weighted": "0d7491b428245222",
  "liquid_dnb/synth/plain": "685a585dc1bc7aa9",
  "liquid_dnb/synth/weighted": "71e16c0778cc136d",
  "castlevania/synth/plain": "11430bd55794bdc0",
  "castlevania/synth/weighted": "b4f6b4973c4e3246",
  "jrpg/synth/plain": "4a314f337c6976fb",
  "jrpg/synth/weighted": "e72430122075a393",
  "disco/synth/plain": "039a8982392bb617",
  "disco/synth/weighted": "69025988a8e3a287",
  "baroque/synth/plain": "86a4b7a38cbfd17c",
  "baroque/synth/weighted": "16aa65f91028e3e5",
  "orbital_glass/synth/plain": "78df966ce0de2249",
  "orbital_glass/synth/weighted": "750169ec437f2d28",
  "midnight_platform/synth/plain": "f99660e48ee5c9cb",
  "midnight_platform/synth/weighted": "9cabc1c119ee2496",
  "courtyard_nine/synth/plain": "61f852fd8b920b06",
  "courtyard_nine/synth/weighted": "bb5e60ebce9971ea",
  "low_log/synth/plain": "6f88391f21b97275",
  "low_log/synth/weighted": "e6c5b99cc42cc27e",
  "funk/samples/plain": "d2e69b20e40e2c4c",
  "funk/samples/weighted": "6ed0dd699a178fd3",
  "synthwave/samples/plain": "5cdd53ab8f2e625a",
  "synthwave/samples/weighted": "2860bddaf9c4cffd",
  "jazz_trio/samples/plain": "0f7a6ecc68f0f5b8",
  "jazz_trio/samples/weighted": "c53cab07872339a2",
};

test("the worker streams what it did for every shipped style, plain and weighted, synth and samples", async () => {
  const got: Record<string, string> = {};
  for (const style of styles) {
    got[`${style.id}/synth/plain`] = await run(style, "synth", false, 10);
    got[`${style.id}/synth/weighted`] = await run(style, "synth", true, 10);
  }
  for (const id of ["funk", "synthwave", "jazz_trio"]) {
    const style = styles.find((s) => s.id === id)!;
    got[`${id}/samples/plain`] = await run(style, "samples", false, 10);
    got[`${id}/samples/weighted`] = await run(style, "samples", true, 10);
  }
  if (process.env.PRINT_GOLDEN) console.log(JSON.stringify(got, null, 2));
  assert.deepEqual(got, GOLDEN);
});
