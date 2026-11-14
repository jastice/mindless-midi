/**
 * Booth cam clip prep: turns chosen takes into the clips the page plays.
 *
 *   bazel run //tools/clips:prep                      # defaults below
 *   bazel run //tools/clips:prep -- --takes DIR --out DIR --config FILE --json FILE
 *
 * Per take named in the config (art/claudia-dj/selects.json): decode small
 * grey frames, find the loop (or use the whole take for a transition), check
 * its first and last frame against its poses, estimate the beat phase from
 * the nods, and transcode the usable range without audio to H.264 at the
 * set's frame size and 24 fps, keyframe every 12 frames. Each output file is
 * named by the SHA-256 of its bytes, as the content-addressed store will name
 * it; a pose still is written the same way. Then `clips.json` (the ClipSet)
 * goes to --json, which is the one file that is committed.
 *
 * Media never goes into the repository: --out defaults to ~/workspace/claudia/clips/.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Clip, ClipKind, ClipSet, Energy, Pose, Scene } from "../../src/claudia/director.js";
import { DEFAULT_LOOP, type Frame, JOIN_LIMIT, beatPhase, clipBpm, diff, findBoomerang, findLoop, motion } from "./analyse.js";

const FFMPEG = process.env.FFMPEG ?? (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
const FPS = 24;
const GW = 160;
const GH = 90;

interface Select {
  id: string;
  /** File in the takes folder. */
  take: string;
  kind: ClipKind;
  from: Pose;
  to: Pose;
  energy?: Energy;
  scene?: Scene;
  /** Override the measured beat phase, in frames. */
  beatPhase?: number;
  /** Use exactly these frames of the take instead of searching (for transitions, or to pin a loop). */
  range?: [number, number];
  /** Bars the clip fills; searched for loops when absent. */
  bars?: number;
  /** Play the take forward from `range[0]` (or 0) and back, for takes that never return to their first frame. */
  boomerang?: boolean;
}

interface Config {
  /** Output frame size; sources of another aspect are cropped to it around the centre, then scaled. */
  width: number;
  height: number;
  /** Each pose's still: a take and a frame of it. */
  poses: Partial<Record<Pose, { take: string; frame: number }>>;
  clips: Select[];
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i]!.startsWith("--")) out[a[i]!.slice(2)] = a[++i] ?? "";
  return out;
}

const home = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
// Under `bazel run`, relative paths are the caller's.
const here = (p: string) => resolve(process.env.BUILD_WORKING_DIRECTORY ?? process.cwd(), home(p));
const repo = (p: string) => resolve(process.env.BUILD_WORKSPACE_DIRECTORY ?? process.cwd(), p);

/** Crop to the output aspect around the centre, then scale. */
function fit(cfg: Config): string {
  const ar = cfg.width / cfg.height;
  return `crop='min(iw,ih*${ar})':'min(ih,iw/${ar})',scale=${cfg.width}:${cfg.height}:flags=lanczos,setsar=1`;
}

function greyFrames(file: string, cfg: Config): Frame[] {
  const buf = execFileSync(FFMPEG, ["-v", "error", "-i", file, "-vf", `${fit(cfg)},fps=${FPS},scale=${GW}:${GH},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  const n = GW * GH;
  const frames: Frame[] = [];
  for (let i = 0; i + n <= buf.length; i += n) frames.push(new Uint8Array(buf.subarray(i, i + n)));
  return frames;
}

function hashed(tmp: string, dir: string, ext: string): string {
  const hash = createHash("sha256").update(readFileSync(tmp)).digest("hex");
  const name = `${hash}.${ext}`;
  const dest = join(dir, name);
  if (existsSync(dest)) rmSync(tmp);
  else renameSync(tmp, dest);
  return name;
}

/** Encode frames `start` to `start + frames` of a take; a boomerang plays `start..turn-1` forward, then `turn` back down to `start+1`. */
function transcode(file: string, start: number, frames: number, cfg: Config, out: string, turn?: number): string {
  const tmp = join(out, `.tmp-${process.pid}.mp4`);
  const base = `${fit(cfg)},fps=${FPS}`;
  const graph =
    turn === undefined
      ? ["-vf", `${base},trim=start_frame=${start}:end_frame=${start + frames},setpts=PTS-STARTPTS`]
      : [
          "-filter_complex",
          `[0:v]${base},split[f][r];[f]trim=start_frame=${start}:end_frame=${turn},setpts=PTS-STARTPTS[a];` +
            `[r]trim=start_frame=${start + 1}:end_frame=${turn + 1},setpts=PTS-STARTPTS,reverse[b];[a][b]concat=n=2:v=1:a=0[out]`,
          "-map", "[out]",
        ];
  execFileSync(FFMPEG, [
    "-v", "error", "-y", "-i", file, "-an",
    ...graph,
    "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p",
    "-g", "12", "-keyint_min", "12", "-sc_threshold", "0", "-bf", "0",
    "-movflags", "+faststart", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
    tmp,
  ]);
  return hashed(tmp, out, "mp4");
}

function still(file: string, frame: number, cfg: Config, out: string): string {
  const tmp = join(out, `.tmp-${process.pid}.jpg`);
  execFileSync(FFMPEG, ["-v", "error", "-y", "-i", file, "-vf", `${fit(cfg)},fps=${FPS},select=eq(n\\,${frame})`, "-frames:v", "1", "-q:v", "3", "-map_metadata", "-1", "-fflags", "+bitexact", tmp]);
  return hashed(tmp, out, "jpg");
}

function main(): void {
  const a = args();
  const takes = here(a.takes ?? "~/workspace/claudia/takes");
  const out = here(a.out ?? "~/workspace/claudia/clips");
  const cfg = JSON.parse(readFileSync(a.config ? here(a.config) : repo("art/claudia-dj/selects.json"), "utf8")) as Config;
  const jsonOut = a.json ? here(a.json) : repo("src/claudia/clips.json");
  mkdirSync(out, { recursive: true });

  const cache = new Map<string, Frame[]>();
  const framesOf = (take: string) => {
    let f = cache.get(take);
    if (!f) cache.set(take, (f = greyFrames(join(takes, take), cfg)));
    return f;
  };

  const poseFrames = new Map<Pose, Frame>();
  const stills: Partial<Record<Pose, string>> = {};
  for (const [pose, ref] of Object.entries(cfg.poses) as [Pose, { take: string; frame: number }][]) {
    poseFrames.set(pose, framesOf(ref.take)[ref.frame]!);
    stills[pose] = still(join(takes, ref.take), ref.frame, cfg, out);
  }

  const clips: Clip[] = [];
  let problems = 0;
  for (const sel of cfg.clips) {
    let frames = framesOf(sel.take);
    let start: number;
    let count: number;
    let bars: number;
    let turn: number | undefined;
    if (sel.boomerang) {
      const b = findBoomerang(frames, sel.range?.[0] ?? 0, sel.bars ? { ...DEFAULT_LOOP, bars: [sel.bars] } : DEFAULT_LOOP);
      if (!b) throw new Error(`${sel.id}: no boomerang fits`);
      ({ turn, bars } = b);
      // Analyse the clip as it will play, from 0.
      const fwd = frames.slice(b.start, b.turn);
      const back = frames.slice(b.start + 1, b.turn + 1).reverse();
      frames = [...fwd, ...back, frames[b.start]!];
      [start, count] = [0, b.frames];
      console.log(`${sel.id}: boomerang ${b.start}..${b.turn}, turn motion ${b.turnMotion.toFixed(2)}× the median`);
    } else if (sel.range) {
      [start, count] = [sel.range[0], sel.range[1] - sel.range[0]];
      bars = sel.bars ?? Math.max(1, Math.round((count / FPS) * (DEFAULT_LOOP.targetBpm / 60 / 4)));
    } else {
      const loop = findLoop(frames, sel.bars ? { ...DEFAULT_LOOP, bars: [sel.bars] } : DEFAULT_LOOP);
      if (!loop) throw new Error(`${sel.id}: no loop found in ${frames.length} frames`);
      ({ start, frames: count, bars } = loop);
    }
    const bpm = clipBpm(count, bars, FPS);
    const first = frames[start]!;
    const end = frames[Math.min(start + count, frames.length - 1)]!;
    const closes = diff(first, end);
    const fromPose = poseFrames.get(sel.from);
    const toPose = poseFrames.get(sel.to);
    const fromDiff = fromPose ? diff(first, fromPose) : NaN;
    const toDiff = toPose ? diff(end, toPose) : NaN;
    const mot = motion(frames.slice(start, start + count + 1)).slice(1);
    const beat = beatPhase(mot, count / bars / 4);
    const phase = sel.beatPhase ?? Math.round(beat.phase * 10) / 10;
    const flags: string[] = [];
    if (sel.from === sel.to && closes > JOIN_LIMIT) flags.push(`loop does not close (${closes.toFixed(2)})`);
    if (fromDiff > JOIN_LIMIT) flags.push(`start is off its ${sel.from} pose (${fromDiff.toFixed(2)})`);
    if (toDiff > JOIN_LIMIT) flags.push(`end is off its ${sel.to} pose (${toDiff.toFixed(2)})`);
    problems += flags.length;
    const file = transcode(join(takes, sel.take), turn === undefined ? start : (sel.range?.[0] ?? 0), count, cfg, out, turn);
    console.log(
      `${sel.id.padEnd(18)} frames ${start}..${start + count} (${count}) = ${bars} bars at ${bpm.toFixed(1)} bpm` +
        ` | close ${closes.toFixed(2)} from ${fromDiff.toFixed(2)} to ${toDiff.toFixed(2)}` +
        ` | beat phase ${beat.phase.toFixed(1)}f strength ${beat.strength.toFixed(2)}` +
        `${flags.length ? `\n  !! ${flags.join("; ")}` : ""}`,
    );
    clips.push({
      id: sel.id,
      kind: sel.kind,
      from: sel.from,
      to: sel.to,
      ...(sel.energy && { energy: sel.energy }),
      ...(sel.scene && { scene: sel.scene }),
      file,
      frames: count,
      bars,
      bpm: Math.round(bpm * 1000) / 1000,
      beatPhase: phase,
      fadeFrames: 6,
      source: { take: sel.take, start: turn === undefined ? start : (sel.range?.[0] ?? 0), ...(turn !== undefined && { boomerangTurn: turn }), closeDiff: round2(closes), fromDiff: round2(fromDiff), toDiff: round2(toDiff), beatStrength: round2(beat.strength) },
    });
  }
  const set: ClipSet = { fps: FPS, width: cfg.width, height: cfg.height, stills, clips };
  writeFileSync(jsonOut, `${JSON.stringify(set, null, 2)}\n`);
  console.log(`\n${clips.length} clips to ${out}, clips.json to ${jsonOut}${problems ? `, ${problems} join problem(s)` : ""}`);
}

const round2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

main();
