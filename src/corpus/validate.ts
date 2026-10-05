/**
 * Structural (zod) + musical validation of a style corpus. Used at build time
 * (a broken corpus fails the build) and by the generator, which feeds the
 * errors back to Claude for a repair round.
 */
import { DRUM_LANES, type Role, StyleCorpus } from "./schema.js";
import { parseRoman } from "../theory/theory.js";

export type ValidationResult =
  | { ok: true; corpus: StyleCorpus; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const EPS = 1e-6;

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

  return errors.length ? { ok: false, errors, warnings } : { ok: true, corpus: c, warnings };
}
