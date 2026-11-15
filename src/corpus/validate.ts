/**
 * Structural (zod) + musical validation of a style corpus. Used at build time
 * (a broken corpus fails the build) and by the generator, which feeds the
 * errors back to Claude for a repair round.
 */
import type { Kit, Patch } from "./patch.js";
import { DRUM_LANES, type Role, StyleCorpus } from "./schema.js";
import { parseRoman } from "../theory/theory.js";

export type ValidationResult =
  | { ok: true; corpus: StyleCorpus; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const EPS = 1e-6;

/** Settings of a patch that are valid but do nothing, or will not do what they seem to. */
export function patchWarnings(p: Patch): string[] {
  const out: string[] = [];
  const { osc } = p;
  if (osc.pw !== undefined && osc.wave !== "pulse") out.push(`osc.pw does nothing on wave "${osc.wave}"`);
  if (osc.voices === 1 && osc.detune > 0) out.push("osc.detune does nothing with one voice");
  if (osc.spread && osc.voices === 1 && osc.wave !== "noise") out.push("osc.spread needs voices >= 2");
  if (osc.wave === "noise" && osc.fm) out.push("osc.fm does nothing on noise");
  for (const [i, m] of (p.mod ?? []).entries()) {
    if (m.target === "pw" && osc.wave !== "pulse") out.push(`mod[${i}]: target "pw" needs wave "pulse"`);
    if (m.target === "width" && !osc.spread) out.push(`mod[${i}]: target "width" needs osc.spread`);
    if (m.target === "pitch" && osc.wave === "noise") out.push(`mod[${i}]: noise has no pitch to modulate`);
    if (m.depth === 0) out.push(`mod[${i}]: depth 0 does nothing`);
  }
  if (p.amp.s === 0 && p.amp.d > 5) out.push("amp: no sustain and a decay over 5 s; the note still ends with its length");
  return out;
}

/** The same for a kit. */
export function kitWarnings(k: Kit): string[] {
  const out: string[] = [];
  if (k.kick.f0 < k.kick.f1) out.push("kick: f0 below f1, the pitch sweeps up");
  if (k.toms && k.toms.low > k.toms.high) out.push("toms: low is above high");
  if (k.hat && k.hat.hp > k.hat.tone * 1.5) out.push("hat: hp is far above tone, little of the hat is left");
  const lanes = new Set<string>();
  for (const p of k.perc ?? []) {
    if (lanes.has(p.lane)) out.push(`perc: lane "${p.lane}" is taken twice; the first wins`);
    lanes.add(p.lane);
    if (p.lane === "kick") out.push("perc: lane \"kick\" replaces the kick, and its sub tail and rumble with it");
  }
  return out;
}

export function validateCorpus(input: unknown): ValidationResult {
  const parsed = StyleCorpus.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      warnings: [],
    };
  }
  const c = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const bpb = c.beatsPerBar;

  if (c.beatGroups && c.beatGroups.reduce((sum, beats) => sum + beats, 0) !== bpb) {
    errors.push(`beatGroups: must sum to beatsPerBar (${bpb})`);
  }

  if (c.tempo.min > c.tempo.max) errors.push(`tempo: min ${c.tempo.min} > max ${c.tempo.max}`);
  if (c.melody.low >= c.melody.high) errors.push(`melody: low ${c.melody.low} >= high ${c.melody.high}`);
  if (c.melody.high - c.melody.low < 12) warnings.push("melody: range narrower than an octave");

  const roles = new Map<Role, number>();
  c.instruments.forEach((inst, i) => {
    if (roles.has(inst.role)) errors.push(`instruments[${i}]: duplicate role "${inst.role}"`);
    roles.set(inst.role, i);
  });

  const ids = new Set<string>();
  const uniq = (kind: string, id: string) => {
    const key = `${kind}:${id}`;
    if (ids.has(key)) errors.push(`${kind}: duplicate id "${id}"`);
    ids.add(key);
  };

  const patches = new Set((c.patches ?? []).map((p) => p.id));
  const patched = new Set<string>();
  (c.patches ?? []).forEach((p, i) => {
    uniq("patch", p.id);
    for (const w of patchWarnings(p)) warnings.push(`patches[${i}] "${p.id}": ${w}`);
  });
  const checkPatch = (where: string, inst: { role: Role; patch?: string | undefined }) => {
    if (inst.patch === undefined) return;
    patched.add(inst.patch);
    if (!patches.has(inst.patch)) errors.push(`${where}: unknown patch "${inst.patch}"`);
    else if (inst.role === "drums") warnings.push(`${where}: drums play the kit; patch "${inst.patch}" is ignored`);
  };
  c.instruments.forEach((inst, i) => checkPatch(`instruments[${i}]`, inst));
  if (c.synthKit) for (const w of kitWarnings(c.synthKit)) warnings.push(`synthKit: ${w}`);

  c.progressions.forEach((p, i) => {
    uniq("progression", p.id);
    let total = 0;
    p.chords.forEach((ch, j) => {
      total += ch.beats;
      try {
        parseRoman(ch.symbol);
      } catch (e) {
        errors.push(`progressions[${i}].chords[${j}]: ${(e as Error).message}`);
      }
    });
    if (Math.abs(total / bpb - Math.round(total / bpb)) > EPS) {
      errors.push(`progressions[${i}] "${p.id}": ${total} beats is not a whole number of ${bpb}-beat bars`);
    }
  });

  c.motifs.forEach((m, i) => {
    uniq("motif", m.id);
    m.notes.forEach((n, j) => {
      if (n.t >= m.lengthBeats - EPS) errors.push(`motifs[${i}] "${m.id}".notes[${j}]: onset ${n.t} outside length ${m.lengthBeats}`);
      if (n.t + n.d > m.lengthBeats + 1 + EPS) warnings.push(`motifs[${i}] "${m.id}".notes[${j}]: rings ${n.t + n.d - m.lengthBeats} beats past the pattern`);
      if (n.approach && m.role !== "bass") warnings.push(`motifs[${i}] "${m.id}": approach tones only apply to bass`);
    });
  });

  c.comping.forEach((p, i) => {
    uniq("comping", p.id);
    p.hits.forEach((h, j) => {
      if (h.t >= p.lengthBeats - EPS) errors.push(`comping[${i}] "${p.id}".hits[${j}]: onset ${h.t} outside length ${p.lengthBeats}`);
    });
  });

  c.drums.forEach((p, i) => {
    uniq("drums", p.id);
    const steps = bpb * p.stepsPerBeat;
    let any = false;
    for (const lane of DRUM_LANES) {
      const s = p.lanes[lane];
      if (s.length === 0) continue;
      any = true;
      if (s.length !== steps) errors.push(`drums[${i}] "${p.id}".${lane}: ${s.length} steps, expected ${steps} (${bpb} beats x ${p.stepsPerBeat})`);
      if (!/^[Xxo.]*$/.test(s)) errors.push(`drums[${i}] "${p.id}".${lane}: only X x o . allowed`);
    }
    if (!any) errors.push(`drums[${i}] "${p.id}": all lanes empty`);
  });

  const needs: Record<Role, () => boolean> = {
    lead: () => c.motifs.some((m) => m.role === "lead"),
    counter: () => c.motifs.some((m) => m.role === "counter" || m.role === "lead"),
    arp: () => c.motifs.some((m) => m.role === "arp"),
    bass: () => c.motifs.some((m) => m.role === "bass"),
    pad: () => c.comping.some((p) => p.role === "pad"),
    comp: () => c.comping.some((p) => p.role === "comp"),
    drums: () => c.drums.some((p) => p.kind === "groove"),
  };
  const used = new Set<Role>();
  const palettes = new Set(
    [...c.progressions, ...c.motifs, ...c.comping, ...c.drums].map((m) => m.palette).filter((p) => p !== undefined),
  );
  c.forms.forEach((f, i) => {
    uniq("form", f.id);
    if (f.tempo && f.tempo.min > f.tempo.max) errors.push(`forms[${i}] "${f.id}": tempo min ${f.tempo.min} > max ${f.tempo.max}`);
    if (f.palette !== undefined && !palettes.has(f.palette)) {
      warnings.push(`forms[${i}] "${f.id}": no material is tagged with palette "${f.palette}"`);
    }
    const formRoles = new Set(roles.keys());
    const overridden = new Set<Role>();
    (f.instruments ?? []).forEach((inst, k) => {
      if (overridden.has(inst.role)) errors.push(`forms[${i}].instruments[${k}]: duplicate role "${inst.role}"`);
      checkPatch(`forms[${i}].instruments[${k}]`, inst);
      overridden.add(inst.role);
      formRoles.add(inst.role);
    });
    f.sections.forEach((s, j) => {
      if (s.progression !== undefined && !c.progressions.some((p) => p.id === s.progression)) {
        errors.push(`forms[${i}].sections[${j}]: unknown progression "${s.progression}"`);
      }
      for (const r of s.roles) {
        used.add(r);
        if (!formRoles.has(r)) errors.push(`forms[${i}].sections[${j}]: role "${r}" has no instrument`);
      }
    });
  });
  for (const p of palettes) {
    if (!c.forms.some((f) => f.palette === p)) warnings.push(`palette "${p}" is never used by a form`);
  }
  for (const r of used) {
    if (!needs[r]()) errors.push(`role "${r}" is used in a form but has no material (motifs/comping/drums)`);
  }
  for (const r of roles.keys()) {
    if (!used.has(r)) warnings.push(`instrument for role "${r}" is never used by any form`);
  }
  for (const id of patches) {
    if (!patched.has(id)) warnings.push(`patch "${id}" is not used by any instrument`);
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, corpus: c, warnings };
}
