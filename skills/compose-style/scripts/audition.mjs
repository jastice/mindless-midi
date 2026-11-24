#!/usr/bin/env node
/**
 * Offline Synth-engine audition renderer for both DJ Claudia and Mindless Midi.
 *
 * Drives the real render worker (`src/sound/worker.js`) in Node, writes a
 * stereo 16-bit PCM WAV (defaulting to /tmp, never inside the repo), and
 * prints bar-by-bar section/part details plus acoustic weight measurements.
 *
 * Prerequisites (build once after corpus or sound edits):
 *   Claudia:
 *     bazel build //styles:claudia //src/sound:worker //src/sound //src/engine
 *   Mindless Midi:
 *     bazel build //styles:styles //src/sound:worker //src/sound //src/engine
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = `Usage: node skills/compose-style/scripts/audition.mjs [options]

Options:
  --style <id>          Style id to audition (required unless --list-styles)
  --pack <name>         "claudia" or "mindless" (auto-detected if omitted)
  --seed <str>          Deterministic seed (default: audit-1)
  --track <n>           Piece / track index (default: 0; try 2 for post-warmup Claudia)
  --from <bar>          Start bar index in the piece (default: 0, overridden by --find)
  --bars <n>            Number of bars to render (default: 24)
  --find <query>        Auto-locate a clip start bar:
                          drop              Breakdown/build leading into first drop (Claudia)
                          peak              Highest-intensity section
                          breakdown         First breakdown (drums/bass out)
                          ending            Final bars of the piece (includes ending cadence)
                          parts:a,b         First bar (after bar 15) where all listed parts play
  --plain               Disable weighted mix + expressive gestures (default: weighted)
  --sr <hz>             Sample rate in Hz (default: 24000)
  --out <path.wav>      Output WAV path (default: /tmp/<style>_<seed>.wav)
  --raw-gain            Skip peak normalization to 0.88 (preserve raw worker amplitude)
  --list                Print track layout (sections, bars, parts) without rendering audio
  --list-styles         Print available style ids in built pack(s)
  --bin <dir>           Explicit path to Bazel bin dir (default: auto-detect .bazel/bin or bazel-bin)
  --help                Show this help
`;

function parseArgs(argv) {
  const args = {
    pack: null,
    style: null,
    seed: "audit-1",
    track: 0,
    from: null,
    bars: 24,
    find: null,
    weighted: true,
    sr: 24000,
    out: null,
    rawGain: false,
    list: false,
    listStyles: false,
    bin: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${k}`);
      return argv[++i];
    };
    if (k === "--help" || k === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (k === "--style") args.style = next();
    else if (k === "--pack") args.pack = next();
    else if (k === "--seed") args.seed = next();
    else if (k === "--track") args.track = Number(next());
    else if (k === "--from") args.from = Number(next());
    else if (k === "--bars") args.bars = Number(next());
    else if (k === "--find") args.find = next();
    else if (k === "--plain") args.weighted = false;
    else if (k === "--weighted") args.weighted = true;
    else if (k === "--sr") args.sr = Number(next());
    else if (k === "--out") args.out = next();
    else if (k === "--raw-gain") args.rawGain = true;
    else if (k === "--list") args.list = true;
    else if (k === "--list-styles") args.listStyles = true;
    else if (k === "--bin") args.bin = resolve(next());
    else throw new Error(`Unknown argument: ${k}`);
  }
  return args;
}

function findRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(cur, "MODULE.bazel"))) return cur;
    cur = dirname(cur);
  }
  return process.cwd();
}

function findBazelBin(root, explicit) {
  if (explicit) return explicit;
  for (const rel of [".bazel/bin", "bazel-bin"]) {
    const p = resolve(root, rel);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not find .bazel/bin or bazel-bin under ${root}.\n` +
      `Build targets first, e.g.:\n` +
      `  bazel build //styles:claudia //styles:styles //src/sound:worker //src/sound //src/engine`,
  );
}

function loadPack(binDir, name) {
  const file = resolve(binDir, "styles", name === "claudia" ? "claudia.json" : "styles.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")).styles;
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

function writeWav(outPath, mix, sr, rawGain) {
  const total = mix.l.length;
  let peak = 0;
  for (let i = 0; i < total; i++) {
    peak = Math.max(peak, Math.abs(mix.l[i]), Math.abs(mix.r[i]));
  }
  const gain = rawGain ? 1 : peak > 0 ? 0.88 / peak : 1;
  const dataBytes = total * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < total; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix.l[i] * gain)) * 32767), off);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix.r[i] * gain)) * 32767), off + 2);
    off += 4;
  }
  writeFileSync(outPath, buf);
  return { peak, gain, seconds: total / sr };
}

function barRoles(bar) {
  const roles = [];
  for (const n of bar.notes ?? []) {
    if (!roles.includes(n.role)) roles.push(n.role);
  }
  return roles;
}

function summarizeSections(bars) {
  const sections = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const info = bar.info;
    const label = info.gap ? "(gap)" : info.section;
    const prev = sections.at(-1);
    if (!prev || prev.label !== label || prev.intensity !== info.intensity) {
      sections.push({
        label,
        start: i,
        end: i,
        intensity: info.intensity,
        roles: new Set(barRoles(bar)),
        parts: new Set(info.parts ?? []),
        builds: info.build ? 1 : 0,
      });
    } else {
      prev.end = i;
      for (const r of barRoles(bar)) prev.roles.add(r);
      for (const p of info.parts ?? []) prev.parts.add(p);
      if (info.build) prev.builds++;
    }
  }
  return sections;
}

function locateStart(bars, query, clipBars) {
  if (!query) return 0;
  if (query === "ending") {
    // Include final cadence bars, excluding trailing inter-piece silence gaps if possible.
    let end = bars.length;
    while (end > 1 && bars[end - 1].info.gap) end--;
    return Math.max(0, end - clipBars);
  }
  if (query === "drop") {
    // Find the drop landing bar (preferring a drop after a build or turn==="drop"),
    // then lead in by up to half the clip (max 8 bars) so both build and drop are heard.
    let dropIdx = bars.findIndex((b, i) => i >= 16 && b.info.turn === "drop");
    if (dropIdx < 0) {
      const buildStart = bars.findIndex((b, i) => i >= 16 && b.info.build);
      if (buildStart >= 0) {
        let j = buildStart;
        while (j < bars.length && bars[j].info.build) j++;
        dropIdx = Math.min(bars.length - 1, j);
      }
    }
    if (dropIdx < 0) {
      for (let i = 16; i < bars.length; i++) {
        const prev = bars[i - 1];
        const cur = bars[i];
        const hadKick = prev.info.parts ? prev.info.parts.includes("kick") : barRoles(prev).includes("drums");
        const hasKick = cur.info.parts ? cur.info.parts.includes("kick") : barRoles(cur).includes("drums");
        if ((!hadKick && hasKick) || cur.info.intensity - prev.info.intensity >= 0.25) {
          dropIdx = i;
          break;
        }
      }
    }
    if (dropIdx >= 0) {
      const leadIn = Math.min(8, Math.floor(clipBars / 2));
      return Math.max(0, dropIdx - leadIn);
    }
    return Math.min(16, Math.max(0, bars.length - clipBars));
  }
  if (query === "peak") {
    let best = 0;
    for (let i = 1; i < bars.length; i++) {
      if (!bars[i].info.gap && bars[i].info.intensity > bars[best].info.intensity) best = i;
    }
    return best;
  }
  if (query === "breakdown") {
    const idx = bars.findIndex((b, i) => {
      if (i < 16 || i >= bars.length - 16 || b.info.gap) return false;
      const hasBass = b.info.parts ? b.info.parts.includes("bass") : barRoles(b).includes("bass");
      return !hasBass;
    });
    return idx >= 0 ? Math.max(0, idx - 2) : 0;
  }
  if (query.startsWith("parts:")) {
    const wanted = query
      .slice("parts:".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const idx = bars.findIndex((b, i) => i >= 16 && wanted.every((w) => (b.info.parts ?? []).includes(w)));
    if (idx < 0) {
      throw new Error(`No bar after bar 15 had all parts [${wanted.join(", ")}] in this seed/track; try another --seed or --track.`);
    }
    return idx;
  }
  throw new Error(`Unknown --find query "${query}". Expected drop, peak, breakdown, ending, or parts:<a,b>.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = findRepoRoot();
  const binDir = findBazelBin(root, args.bin);

  const claudiaStyles = loadPack(binDir, "claudia");
  const mindlessStyles = loadPack(binDir, "mindless");

  if (args.listStyles) {
    if (claudiaStyles) console.log(`claudia:  ${claudiaStyles.map((s) => s.id).join(", ")}`);
    if (mindlessStyles) console.log(`mindless: ${mindlessStyles.map((s) => s.id).join(", ")}`);
    if (!claudiaStyles && !mindlessStyles) {
      throw new Error("Neither styles/claudia.json nor styles/styles.json is built yet.");
    }
    return;
  }

  if (!args.style) {
    console.error("Error: --style <id> is required.\n");
    console.error(USAGE);
    process.exit(2);
  }

  let pack = args.pack;
  let style = null;
  if (pack === "claudia") {
    if (!claudiaStyles) throw new Error("Build //styles:claudia first.");
    style = claudiaStyles.find((s) => s.id === args.style);
  } else if (pack === "mindless") {
    if (!mindlessStyles) throw new Error("Build //styles:styles first.");
    style = mindlessStyles.find((s) => s.id === args.style);
  } else {
    style = claudiaStyles?.find((s) => s.id === args.style) ?? null;
    if (style) pack = "claudia";
    else {
      style = mindlessStyles?.find((s) => s.id === args.style) ?? null;
      if (style) pack = "mindless";
    }
  }

  if (!style) {
    const avail = [
      claudiaStyles ? `claudia=[${claudiaStyles.map((s) => s.id).join(", ")}]` : "claudia=(not built)",
      mindlessStyles ? `mindless=[${mindlessStyles.map((s) => s.id).join(", ")}]` : "mindless=(not built)",
    ].join("  ");
    throw new Error(`Style "${args.style}" not found. Available: ${avail}`);
  }

  const imp = (rel) => {
    const full = resolve(binDir, rel);
    if (!existsSync(full)) {
      throw new Error(`Missing built artifact: ${full}\nRun bazel build for //src/sound:worker and engine/sound deps first.`);
    }
    return import(pathToFileURL(full).href);
  };

  const { velocityScale } = await imp("src/engine/parts.js");
  const { stereo } = await imp("src/sound/dsp.js");
  const { measureWeight } = await imp("src/sound/measure.js");
  const { stemMoves } = await imp("src/sound/moves.js");
  const { barScore } = await imp("src/sound/score.js");
  const { partLevels, styleSound } = await imp("src/sound/sound_set.js");

  const FLOOR = pack === "claudia" ? 0.5 : 0.42;
  let bars = [];
  let header = "";

  if (pack === "claudia") {
    const { SetConductor } = await imp("src/engine/set.js");
    const opts = {
      minSeconds: 180,
      maxSeconds: 360,
      ...(args.weighted && { expression: { gestures: true, velocityFloor: FLOOR } }),
    };
    const piece = new SetConductor([style], args.seed, opts).trackPiece(args.track);
    bars = Array.from({ length: piece.totalBars }, (_, b) => piece.renderBar(b, b));
    header = `${style.id} (claudia) | seed=${args.seed} track=${args.track} | form=${piece.formId} key=${piece.keyName} bpm=${piece.bpm} | ${piece.totalBars} bars`;
  } else {
    const { Conductor } = await imp("src/engine/conductor.js");
    const { DEFAULT_PIECE_OPTIONS } = await imp("src/engine/piece.js");
    const opts = args.weighted
      ? { ...DEFAULT_PIECE_OPTIONS, expression: { gestures: true, velocityFloor: FLOOR } }
      : DEFAULT_PIECE_OPTIONS;
    const conductor = new Conductor([style], args.seed, opts);
    conductor.seek(args.track, 0);
    const formId = conductor.currentPiece?.formId ?? "unknown";
    while (true) {
      const bar = conductor.nextBar();
      if (bars.length > 0 && bar.info.pieceIndex !== args.track) break;
      bars.push(bar);
      if (bars.length > 512) break;
    }
    const first = bars[0];
    const area = first.info.area ? ` area=${first.info.area}` : "";
    header = `${style.id} (mindless) | seed=${args.seed} piece=${args.track} | form=${formId}${area} key=${first.info.keyName} bpm=${first.bpm} | ${bars.length} bars`;
  }

  console.log(header);
  const sections = summarizeSections(bars);
  for (const s of sections) {
    const extra = s.parts.size
      ? `parts=[${[...s.parts].join(",")}]${s.builds ? ` (${s.builds} build bars)` : ""}`
      : `roles=[${[...s.roles].join(",")}]`;
    console.log(
      `  bars ${String(s.start).padStart(3)}..${String(s.end).padEnd(3)} | ${s.label.padEnd(12)} | int=${s.intensity.toFixed(2)} | ${extra}`,
    );
  }

  if (args.list) return;

  const from = args.from !== null ? Math.max(0, Math.min(args.from, bars.length - 1)) : locateStart(bars, args.find, args.bars);
  const to = Math.min(bars.length, from + args.bars);
  const outPath = args.out ?? `/tmp/${style.id}_${args.seed.replace(/[^a-zA-Z0-9_-]/g, "_")}.wav`;

  // Boot the exact render worker in Node.
  const scope = { onmessage: null };
  globalThis.self = scope;
  await imp("src/sound/worker.js");

  let posted = [];
  let cleared = null;
  const port = {
    postMessage(msg) {
      if (msg.type === "clear") cleared?.();
      else posted.push(msg);
    },
  };
  const send = (data) => scope.onmessage({ data });
  send({ type: "init", sampleRate: args.sr, port });

  const parts = partLevels(style.corpus);
  const levels = Object.fromEntries(style.corpus.instruments.map((i) => [i.role, i.volume]));
  const sound = styleSound(style.corpus);
  const programs = new Map();
  const patches = new Map();

  let start = 0;
  for (let i = 0; i < to; i++) {
    const bar = bars[i];
    const frames = Math.round(((bar.beats * 60) / bar.bpm) * args.sr);
    const notes = barScore(
      bar,
      programs,
      args.weighted ? { legato: true, gestures: true, patches } : { patches },
    ).map((n) => ({ ...n, t: n.t + start / args.sr }));

    if (i >= from) {
      const moves = stemMoves(bar);
      send({
        type: "bar",
        engine: "synth",
        start,
        frames,
        styleId: style.id,
        newPiece: i === from,
        levels,
        ...(parts && { partLevels: parts }),
        notes,
        ...(args.weighted && {
          mix: { intensity: bar.info.intensity, lean: velocityScale(bar.info.intensity, FLOOR) },
          touch: true,
        }),
        ...(sound && { sound }),
        ...(moves && { moves }),
      });
      start += frames;
    }
  }

  await new Promise((resolveDone) => {
    cleared = resolveDone;
    send({ type: "clear", from: start });
  });

  const pcm = posted.filter((m) => m.type === "pcm");
  const total = pcm.reduce((a, m) => a + m.frames, 0);
  const mix = stereo(total);
  let at = 0;
  for (const m of pcm) {
    m.roles.forEach((_, i) => {
      for (let k = 0; k < m.frames; k++) {
        mix.l[at + k] += m.data[2 * i][k];
        mix.r[at + k] += m.data[2 * i + 1][k];
      }
    });
    at += m.frames;
  }

  const w = measureWeight(mix, args.sr);
  const { peak, gain, seconds } = writeWav(outPath, mix, args.sr, args.rawGain);

  console.log(`\nClip: bars ${from}..${to - 1} (${to - from} bars, ${seconds.toFixed(1)}s, ${args.weighted ? "weighted" : "plain"}, ${args.sr} Hz)`);
  for (let i = from; i < to; i += 4) {
    const b = bars[i];
    const sec = b.info.gap ? "(gap)" : b.info.section;
    const detail = b.info.parts ? `parts=${b.info.parts.join("+")}` : `roles=${barRoles(b).join("+") || "none"}`;
    const mv = b.moves?.length ? ` moves=${b.moves.map((m) => m.target).join(",")}` : "";
    console.log(`  bar ${String(i).padStart(3)} [${sec}] int=${b.info.intensity.toFixed(2)} ${detail}${b.info.build ? " [BUILD]" : ""}${mv}`);
  }
  console.log(
    `Acoustic: rms=${db(w.rms).toFixed(1)} dB | peak=${peak.toFixed(3)} (wav gain x${gain.toFixed(2)}) | crest=${w.crest.toFixed(1)} dB | sub=${(w.sub * 100).toFixed(0)}% | lowMid=${(w.lowMid * 100).toFixed(0)}% | lowCorr=${w.lowCorrelation.toFixed(2)}`,
  );
  console.log(`Wrote: ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
