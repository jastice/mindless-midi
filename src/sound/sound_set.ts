/**
 * A style's own sounds as the synth takes them: its patches by name and its
 * modelled drum kit (see corpus/patch.ts). Kept apart from the synth so the
 * main thread can build one without bundling the voices.
 */
import type { Kit, Patch } from "../corpus/patch.js";
import type { ScoreNote } from "./types.js";

export interface SoundSet {
  /** A note names one in `patch`. */
  patches?: Record<string, Patch>;
  kit?: Kit;
}

/** A style's declared sounds. Undefined for a style with none, which is every style of Mindless Midi and Mighty Midi. */
export function styleSound(corpus: { patches?: (Patch & { id: string })[] | undefined; synthKit?: Kit | undefined }): SoundSet | undefined {
  if (!corpus.patches?.length && !corpus.synthKit) return undefined;
  return {
    ...(corpus.patches?.length && { patches: Object.fromEntries(corpus.patches.map((p) => [p.id, p])) }),
    ...(corpus.synthKit && { kit: corpus.synthKit }),
  };
}

/** The mix level of each part that sets its own (see corpus `parts`). Undefined for a style without parts. */
export function partLevels(corpus: { parts?: { id: string; role: string; volume?: number | undefined }[] | undefined }): Record<string, number> | undefined {
  if (!corpus.parts?.length) return undefined;
  return Object.fromEntries(corpus.parts.filter((p) => p.volume !== undefined && p.role !== "drums").map((p) => [p.id, p.volume!]));
}

/**
 * Whether a note plays one of the style's patches. Only the synth has those, so it plays the note
 * under the samples engine too. (Drums stay with the engine: sampled there, the declared kit in the synth.)
 */
export function playsPatch(n: ScoreNote, sound: SoundSet | undefined): boolean {
  return n.role !== "drums" && n.patch !== undefined && sound?.patches?.[n.patch] !== undefined;
}
