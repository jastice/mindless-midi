/**
 * The pieces Mindless Midi and Mighty Midi play must not change when the
 * engine grows options they do not use. These hashes were taken from the code
 * before the set options existed (at 43957bc); a change to them changes
 * shipped music.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../corpus/schema.js";
import { Conductor } from "./conductor.js";
import { DEFAULT_PIECE_OPTIONS, type PieceOptions } from "./piece.js";

const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };

const OPTIONS: Record<string, PieceOptions> = {
  plain: DEFAULT_PIECE_OPTIONS,
  expressive: { ...DEFAULT_PIECE_OPTIONS, expression: { gestures: true, velocityFloor: 0.4 } },
  short: { minSeconds: 20, maxSeconds: 40, expression: { gestures: true } },
};

function hash(c: Conductor, bars: number): string {
  const h = createHash("sha256");
  for (let i = 0; i < bars; i++) h.update(JSON.stringify(c.nextBar()));
  return h.digest("hex").slice(0, 16);
}

const GOLDEN: Record<string, string> = {
  "metroid/plain/g1": "a51c6981ff26bec8",
  "metroid/plain/g2": "82cabe3dc9571639",
  "metroid/expressive/g1": "22c991c69f513168",
  "metroid/expressive/g2": "d144bfcc13083543",
  "metroid/short/g1": "3edadf7bfa74e02e",
  "metroid/short/g2": "91a51ce4f6dd1eb4",
  "retro/plain/g1": "9b9d6fe84111f6c6",
  "retro/plain/g2": "1d119cbe5781a42c",
  "retro/expressive/g1": "0d55c56ae41d05c3",
  "retro/expressive/g2": "3ac4bb580de086d1",
  "retro/short/g1": "02a28a188bd01a0a",
  "retro/short/g2": "293d1129bab025ec",
  "lofi/plain/g1": "10dbb3f47b5f4f64",
  "lofi/plain/g2": "19957f8719ac7d19",
  "lofi/expressive/g1": "b8baef3a3c373354",
  "lofi/expressive/g2": "4e266a7487546718",
  "lofi/short/g1": "a64889aa50bff15d",
  "lofi/short/g2": "19aab64ca691f746",
  "jazz_trio/plain/g1": "e3bd0b6d4ad4dd76",
  "jazz_trio/plain/g2": "f667f177461c86da",
  "jazz_trio/expressive/g1": "bfb1e79cc675d05a",
  "jazz_trio/expressive/g2": "40c56a0e14e1a9d5",
  "jazz_trio/short/g1": "5edb91552b679de3",
  "jazz_trio/short/g2": "e4221156d28ffdfc",
  "minimalist/plain/g1": "62c5817b44787fa5",
  "minimalist/plain/g2": "e1ce52b369f91d75",
  "minimalist/expressive/g1": "2261aa1866d7e74e",
  "minimalist/expressive/g2": "a9855763a2d6229a",
  "minimalist/short/g1": "2c5a546da1724ff0",
  "minimalist/short/g2": "ba3d9788c9a747c5",
  "monkey_island/plain/g1": "867fcd43ce807291",
  "monkey_island/plain/g2": "208e003fc00a65b1",
  "monkey_island/expressive/g1": "92f98e7880d894f5",
  "monkey_island/expressive/g2": "a1f99fe27ebea93f",
  "monkey_island/short/g1": "3c9ffdfbf175dbe7",
  "monkey_island/short/g2": "f6fb0127eefc9a2d",
  "electro_swing/plain/g1": "e602741aaa76d5f8",
  "electro_swing/plain/g2": "369d591d9678f7e4",
  "electro_swing/expressive/g1": "809053e11cef5cbe",
  "electro_swing/expressive/g2": "60cfc1cdec332f1f",
  "electro_swing/short/g1": "7775664af003de0c",
  "electro_swing/short/g2": "b0f7df7dba728c08",
  "synthwave/plain/g1": "64086a6e03bfad04",
  "synthwave/plain/g2": "2ab94440feceffae",
  "synthwave/expressive/g1": "0877379dc09b69e1",
  "synthwave/expressive/g2": "0f6d61fe15481f51",
  "synthwave/short/g1": "2e90ca61486fa37f",
  "synthwave/short/g2": "78b11701d7279908",
  "bossa_nova/plain/g1": "56b636c68f8a7a94",
  "bossa_nova/plain/g2": "0c8580b31bc4e76b",
  "bossa_nova/expressive/g1": "efcd7688bdde4452",
  "bossa_nova/expressive/g2": "e926a2f20c9a516e",
  "bossa_nova/short/g1": "e005677e2b123623",
  "bossa_nova/short/g2": "ce32c0135206b2b6",
  "funk/plain/g1": "43693bcaf2ddefa2",
  "funk/plain/g2": "82f74607587bd540",
  "funk/expressive/g1": "e5a71820b172c159",
  "funk/expressive/g2": "bde1f9f123a88a60",
  "funk/short/g1": "9a6c256a85620840",
  "funk/short/g2": "73e23a283e772dc1",
  "western/plain/g1": "162143ba2f258d16",
  "western/plain/g2": "cd40860c29b39e1b",
  "western/expressive/g1": "d3a9a7a47bf18bb0",
  "western/expressive/g2": "412776c91bcc63e5",
  "western/short/g1": "ac2bb7a3f02ec065",
  "western/short/g2": "538e6057f74f47ca",
  "celtic/plain/g1": "f2c7bcda66fee02f",
  "celtic/plain/g2": "c9c4204d08206d8b",
  "celtic/expressive/g1": "84dc2f468db4c552",
  "celtic/expressive/g2": "8570045c84fbfc97",
  "celtic/short/g1": "6608612419a62b83",
  "celtic/short/g2": "78bc5c2e836eea23",
  "musette/plain/g1": "f9bc001d48aeb976",
  "musette/plain/g2": "b5ce522eec81ed73",
  "musette/expressive/g1": "5dda5ee9a07fe16d",
  "musette/expressive/g2": "2df771e268c025ec",
  "musette/short/g1": "dbf8d8b436768989",
  "musette/short/g2": "308e68467a0f36ff",
  "liquid_dnb/plain/g1": "b2c80010d05e2fbe",
  "liquid_dnb/plain/g2": "5c88747fe44034d9",
  "liquid_dnb/expressive/g1": "78dde61637c78f6f",
  "liquid_dnb/expressive/g2": "d3e991bd1552ae02",
  "liquid_dnb/short/g1": "a2adedc8912e9d35",
  "liquid_dnb/short/g2": "99d25bfd641682ea",
  "castlevania/plain/g1": "48b15ff4a2a9546a",
  "castlevania/plain/g2": "38c5ae9858487c45",
  "castlevania/expressive/g1": "54be9207b3d1a07c",
  "castlevania/expressive/g2": "117130ed11c91914",
  "castlevania/short/g1": "1ee607674d586a6d",
  "castlevania/short/g2": "ba00ca1a82a12922",
  "jrpg/plain/g1": "b8a3ac31d8114e1e",
  "jrpg/plain/g2": "90a52f407dbb554c",
  "jrpg/expressive/g1": "d31679d2ed67a951",
  "jrpg/expressive/g2": "84a3a249e4353828",
  "jrpg/short/g1": "22e553261f6b94e4",
  "jrpg/short/g2": "7b4194db76f84c00",
  "disco/plain/g1": "675f4c0027c01cff",
  "disco/plain/g2": "922489093fcfb14f",
  "disco/expressive/g1": "fcfe90283c2f2191",
  "disco/expressive/g2": "bb59d130a4472ef1",
  "disco/short/g1": "c4e9be308d6b6ae2",
  "disco/short/g2": "7fef9b73f581cb1e",
  "baroque/plain/g1": "f64397a972883b0f",
  "baroque/plain/g2": "1ccc74e1cb78f7dd",
  "baroque/expressive/g1": "75165a1344416281",
  "baroque/expressive/g2": "41c5b59df709fe0b",
  "baroque/short/g1": "ec91eeecc9b6b342",
  "baroque/short/g2": "166b76cbd8b2e086",
  "orbital_glass/plain/g1": "0ecb72a05a14bffd",
  "orbital_glass/plain/g2": "339c241317065d02",
  "orbital_glass/expressive/g1": "150cbdc35c632bfe",
  "orbital_glass/expressive/g2": "1eb86679605c6020",
  "orbital_glass/short/g1": "e69efb090face09d",
  "orbital_glass/short/g2": "2232f67f23e49ba3",
  "midnight_platform/plain/g1": "a0fb8af2be50abb3",
  "midnight_platform/plain/g2": "80c39683526d8ddd",
  "midnight_platform/expressive/g1": "71da6e47fd28ea1e",
  "midnight_platform/expressive/g2": "732709f253ebb139",
  "midnight_platform/short/g1": "d7b0c85a108929ac",
  "midnight_platform/short/g2": "8ca927a03080aabe",
  "courtyard_nine/plain/g1": "6f41c7bbecf1bba8",
  "courtyard_nine/plain/g2": "e2ea4c005857b1c0",
  "courtyard_nine/expressive/g1": "650dbffe608cce3f",
  "courtyard_nine/expressive/g2": "ab2bb40fae51470d",
  "courtyard_nine/short/g1": "18c6705f6b639f5c",
  "courtyard_nine/short/g2": "290f0873d2d8a203",
  "low_log/plain/g1": "82b1e8f92231f2e3",
  "low_log/plain/g2": "7cfa63387977d369",
  "low_log/expressive/g1": "1b14ff42b1030b5c",
  "low_log/expressive/g2": "c35eede4e9cdea89",
  "low_log/short/g1": "1b0cccdf10627c69",
  "low_log/short/g2": "3fd9c5748f0b855a",
  "pool/plain": "e1d6c947844046c2",
  "seek/plain": "042bb0749a7c1d4b",
  "pool/expressive": "b244c422b5759212",
  "seek/expressive": "7067e9de633217ae",
  "pool/short": "28664d27097bdc53",
  "seek/short": "437412a33bf27821",
};

test("default pieces are bit for bit what they were", () => {
  const got: Record<string, string> = {};
  for (const style of styles) {
    for (const [name, opts] of Object.entries(OPTIONS)) {
      for (const seed of ["g1", "g2"]) got[`${style.id}/${name}/${seed}`] = hash(new Conductor([style], `golden-${seed}`, opts), 240);
    }
  }
  for (const [name, opts] of Object.entries(OPTIONS)) {
    got[`pool/${name}`] = hash(new Conductor(styles, "golden-pool", opts), 1200);
    const c = new Conductor(styles, "golden-seek", opts);
    c.seek(3, 17);
    got[`seek/${name}`] = hash(c, 300);
  }
  assert.deepEqual(got, GOLDEN);
});
