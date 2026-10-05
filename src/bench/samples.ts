/** Offline sampled stems for the bench, through the app's sampler. */
import type { Role } from "../corpus/constants.js";
import { type Stereo, stereo, yieldToUi } from "../sound/dsp.js";
import { type SampleLibrary, renderSampleNote } from "../sound/sampler.js";
import { type Score, TAIL_SECONDS } from "./score.js";

export interface SamplerReport {
  bytes: number;
  files: number;
  instruments: string[];
}

/** One stem per role; `skip` leaves roles out (the neural backend replaces the lead). */
export async function renderSampleStems(score: Score, sr: number, lib: SampleLibrary, skip: Role[] = [], onProgress?: (f: number) => void): Promise<{ stems: Map<Role, Stereo>; report: SamplerReport }> {
  const frames = Math.ceil((score.seconds + TAIL_SECONDS) * sr);
  const notes = score.notes.filter((n) => !skip.includes(n.role));
  onProgress?.(0.1);
  const { plans } = await lib.prepare(notes, score.style.id);
  onProgress?.(0.8);
  const stems = new Map<Role, Stereo>();
  notes.forEach((n, i) => {
    let out = stems.get(n.role);
    if (!out) stems.set(n.role, (out = stereo(frames)));
    renderSampleNote(out, n, plans[i]!, (u) => lib.sample(u), sr);
  });
  await yieldToUi();
  const urls = new Set(plans.flatMap((p) => p.zones.map((z) => z.url)).filter((u) => lib.sample(u)));
  const bytes = [...urls].reduce((a, u) => a + (lib.sizes.get(u) ?? 0), 0);
  return { stems, report: { bytes, files: urls.size, instruments: lib.labels } };
}
