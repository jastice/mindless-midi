/**
 * Curves on a note, for engines that render a whole note at once and so can't
 * be reached by a channel message after the note has started. The note is
 * rendered plain into a scratch buffer and read back along its curves: a bend
 * is the read speed, a swell is gain. Any voice or sample gets both this way.
 */
import { curveAt } from "../engine/gestures.js";
import type { Stereo } from "./dsp.js";
import type { ScoreNote } from "./types.js";

/** Longest a shaped note rings past its written length, seconds. */
const TAIL = 2.5;

export function renderShaped(out: Stereo, n: ScoreNote, sr: number, render: (out: Stereo, n: ScoreNote) => void): void {
  const curves = n.curves;
  if (!curves || (!curves.bend && !curves.level)) return render(out, n);
  const base = Math.round(n.t * sr);
  const start = base - (out.base ?? 0);
  const frames = Math.max(0, Math.min(Math.ceil((n.dur + TAIL) * sr), out.l.length - start));
  if (frames < 2) return;
  const scratch: Stereo = { l: new Float32Array(frames), r: new Float32Array(frames), base };
  render(scratch, n);
  const { bend, level } = curves;
  const bendEnd = bend ? bend[bend.length - 1]![0] : 0;
  const levelEnd = level ? level[level.length - 1]![0] : 0;
  let pos = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    const j = Math.floor(pos);
    if (j >= frames - 1) break;
    const f = pos - j;
    let gain = 1;
    if (level && t < levelEnd) {
      // Expression is heard like the channel controller: gain is its square.
      const x = curveAt(level, t);
      gain = x * x;
    }
    const k = start + i;
    if (k >= 0) {
      out.l[k]! += (scratch.l[j]! + f * (scratch.l[j + 1]! - scratch.l[j]!)) * gain;
      out.r[k]! += (scratch.r[j]! + f * (scratch.r[j + 1]! - scratch.r[j]!)) * gain;
    }
    pos += bend && t < bendEnd ? Math.pow(2, curveAt(bend, t) / 12) : 1;
  }
}
