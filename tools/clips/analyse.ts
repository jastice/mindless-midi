/**
 * Frame analysis for the booth cam's clip prep: loop points, join checks and
 * the beat phase, on small grey frames (160×90 by default). Pure, no ffmpeg:
 * prep.ts decodes the frames and calls these.
 *
 * The difference scale is the one used in the tests of the first takes: the
 * mean absolute grey difference per pixel (0..255). An ordinary step from one
 * frame to the next measures about 0.5–1.2; a join above JOIN_LIMIT shows.
 */

export type Frame = Uint8Array;

/** A join (first frame against its pose, a loop's end against its start) worse than this is reported. */
export const JOIN_LIMIT = 3;

/** Mean absolute difference of two grey frames of the same size. */
export function diff(a: Frame, b: Frame): number {
  if (a.length !== b.length) throw new Error(`frame sizes differ: ${a.length} vs ${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

export interface LoopOptions {
  fps: number;
  beatsPerBar: number;
  /** The set tempo the clip should suit; candidates are scored by how far their rate is from 1 at this tempo. */
  targetBpm: number;
  /** Rates outside this are not considered. */
  minRate: number;
  maxRate: number;
  /** Bar counts to try. */
  bars: number[];
}

export const DEFAULT_LOOP: LoopOptions = { fps: 24, beatsPerBar: 4, targetBpm: 129, minRate: 0.92, maxRate: 1.08, bars: [3, 5] };

export interface Loop {
  /** First frame of the loop. */
  start: number;
  /** Frames in the loop: frame `start + frames` is the one that should equal `start`. */
  frames: number;
  bars: number;
  /** Tempo at which the loop plays at ×1. */
  bpm: number;
  /** Difference between the loop's first frame and the frame after its last. */
  closeDiff: number;
  /** The median step between neighbouring frames inside the loop, for scale. */
  stepDiff: number;
}

/** Tempo at which `frames` frames fill `bars` bars at ×1. */
export function clipBpm(frames: number, bars: number, fps: number, beatsPerBar = 4): number {
  return (bars * beatsPerBar * 60 * fps) / frames;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

/**
 * The best loop in a run of frames: the pair `start`, `start + frames` that
 * matches best, among lengths that make a whole number of bars at a rate near
 * 1 for `targetBpm`. Longer loops are favoured a little (less repetition),
 * and rates far from 1 a little less.
 */
export function findLoop(frames: Frame[], opts: LoopOptions = DEFAULT_LOOP): Loop | null {
  let best: (Loop & { score: number }) | null = null;
  const lastIndex = frames.length - 1;
  for (const bars of opts.bars) {
    // frames per bar at the target tempo, and the range the rate limits allow
    const ideal = (bars * opts.beatsPerBar * 60 * opts.fps) / opts.targetBpm;
    const lo = Math.ceil(ideal * opts.minRate);
    const hi = Math.floor(ideal * opts.maxRate);
    for (let len = lo; len <= hi && len <= lastIndex; len++) {
      for (let start = 0; start + len <= lastIndex; start++) {
        const d = diff(frames[start]!, frames[start + len]!);
        const rate = opts.targetBpm / clipBpm(len, bars, opts.fps, opts.beatsPerBar);
        const score = d + 2 * Math.abs(rate - 1) - 0.05 * bars;
        if (!best || score < best.score) {
          best = { start, frames: len, bars, bpm: clipBpm(len, bars, opts.fps, opts.beatsPerBar), closeDiff: d, stepDiff: 0, score };
        }
      }
    }
  }
  if (!best) return null;
  const steps: number[] = [];
  for (let i = best.start + 1; i <= best.start + best.frames; i++) steps.push(diff(frames[i - 1]!, frames[i]!));
  const { score: _, ...loop } = best;
  return { ...loop, stepDiff: median(steps) };
}

/** Motion per frame: the difference to the frame before (0 for the first). */
export function motion(frames: Frame[]): number[] {
  return frames.map((f, i) => (i ? diff(frames[i - 1]!, f) : 0));
}

/**
 * The frame of the first downbeat within a loop's first beat, from its nods:
 * the phase of a comb with one tooth per beat that lines up best with the
 * motion peaks. Nodding down on the beat is the fastest motion, so the comb
 * looks for motion maxima. Returns a frame in [0, framesPerBeat) and how
 * strongly the motion follows the beat (the comb's mean motion over the
 * clip's mean motion; 1 is no beat at all).
 */
export function beatPhase(motionPerFrame: number[], framesPerBeat: number): { phase: number; strength: number } {
  const n = motionPerFrame.length;
  const mean = motionPerFrame.reduce((a, b) => a + b, 0) / Math.max(1, n);
  let best = { phase: 0, strength: 0 };
  const steps = Math.max(1, Math.round(framesPerBeat * 4));
  for (let k = 0; k < steps; k++) {
    const phase = (k / steps) * framesPerBeat;
    let sum = 0;
    let count = 0;
    for (let t = phase; t < n - 1; t += framesPerBeat) {
      // linear interpolation between the neighbouring frames
      const i = Math.floor(t);
      const f = t - i;
      sum += motionPerFrame[i]! * (1 - f) + motionPerFrame[i + 1]! * f;
      count++;
    }
    const strength = count && mean ? sum / count / mean : 0;
    if (strength > best.strength) best = { phase, strength };
  }
  return best;
}

export interface Boomerang {
  start: number;
  /** The frame it turns back on; the clip is start..turn, then turn-1 back down to start+1. */
  turn: number;
  /** Frames in the clip: 2 * (turn - start). */
  frames: number;
  bars: number;
  bpm: number;
  /** Motion around the turn, against the median: low means the bounce is hidden in a still moment. */
  turnMotion: number;
}

/**
 * For a take that never comes back to its first frame: play it forward and
 * back, so it ends where it began. Picks the length (whole bars at a rate
 * near 1) whose turn falls on the stillest moment, where the reversal shows least.
 */
export function findBoomerang(frames: Frame[], start = 0, opts: LoopOptions = DEFAULT_LOOP): Boomerang | null {
  const m = motion(frames);
  const med = median(m.slice(1));
  let best: (Boomerang & { score: number }) | null = null;
  for (const bars of opts.bars) {
    const ideal = (bars * opts.beatsPerBar * 60 * opts.fps) / opts.targetBpm;
    for (let half = Math.ceil((ideal * opts.minRate) / 2); half <= Math.floor((ideal * opts.maxRate) / 2); half++) {
      const turn = start + half;
      if (turn + 1 >= frames.length) continue;
      const around = (m[turn]! + m[turn + 1]!) / 2;
      const bpm = clipBpm(2 * half, bars, opts.fps, opts.beatsPerBar);
      const score = around / Math.max(med, 1e-6) + 2 * Math.abs(opts.targetBpm / bpm - 1) - 0.05 * bars;
      if (!best || score < best.score) best = { start, turn, frames: 2 * half, bars, bpm, turnMotion: around / Math.max(med, 1e-6), score };
    }
  }
  if (!best) return null;
  const { score: _, ...b } = best;
  return b;
}
