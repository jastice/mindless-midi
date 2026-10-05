/**
 * Build-time loudness calibration. FM patches differ in loudness by 10x or
 * more between programs and banks, so the corpus "volume" values (relative
 * mix intent) are turned into measured CC7 levels, and the whole style gets
 * a gain that brings it to a common loudness target.
 */
import { TARGET_RMS } from "../../src/audio/leveler.js";
import type { Form, Instrument, Role, StyleBundle } from "../../src/corpus/schema.js";
import { type Rendered, levels, render } from "./render_lib.js";

const MAX_PEAK = 1.4; // the browser's limiter absorbs the rest
const MIN_CC7 = 6;

export interface Calibration {
  mixer: Partial<Record<Role, number>>;
  formMixers: Record<string, Partial<Record<Role, number>>>;
  gain: number;
  report: string[];
}

/** A bundle that plays only `role`, optionally as a form's override instrument. */
function soloBundle(bundle: StyleBundle, role: Role, cc7: number, area?: Form): StyleBundle {
  const c = bundle.corpus;
  const override = area?.instruments?.find((i) => i.role === role);
  const id = "calibrate";
  return {
    ...bundle,
    mixer: { [role]: cc7 },
    formMixers: override ? { [id]: { [role]: cc7 } } : {},
    gain: 1,
    corpus: {
      ...c,
      melody: { ...c.melody, restProbability: 0 },
      forms: [
        {
          id,
          palette: area?.palette,
          instruments: override ? [override] : undefined,
          sections: [{ label: "A", bars: 16, intensity: 0.6, roles: [role] }],
        },
      ],
    },
  };
}

/**
 * Loudness while the part is actually sounding: RMS over the loudest quarter
 * of 50 ms windows, so sparse parts aren't mistaken for quiet ones.
 */
export function activeRms(r: Pick<Rendered, "left" | "right" | "sampleRate">, top = 0.25): number {
  const win = Math.round(r.sampleRate * 0.05);
  const energies: number[] = [];
  for (let start = 0; start + win <= r.left.length; start += win) {
    let e = 0;
    for (let i = start; i < start + win; i++) e += (r.left[i]! ** 2 + r.right[i]! ** 2) / 2;
    energies.push(e / win);
  }
  energies.sort((a, b) => b - a);
  const n = Math.max(1, Math.floor(energies.length * top));
  return Math.sqrt(energies.slice(0, n).reduce((a, b) => a + b, 0) / n);
}

async function soloRms(bundle: StyleBundle, role: Role, cc7: number, area?: Form): Promise<number> {
  const r = await render([soloBundle(bundle, role, cc7, area)], {
    seconds: 6,
    seed: `calibrate/${bundle.id}/${area?.id ?? ""}/${role}`,
    pieces: { minSeconds: 60, maxSeconds: 60 },
  });
  return activeRms(r);
}

export async function calibrate(bundle: StyleBundle): Promise<Calibration> {
  const c = bundle.corpus;
  const used = new Set(c.forms.flatMap((f) => f.sections.flatMap((s) => s.roles)));
  const report: string[] = [];

  // Loudness vs CC7 follows a power law; measure it per instrument.
  type Fit = { r127: number; p: number; volume: number };
  const measure = async (inst: Instrument, area?: Form): Promise<Fit | null> => {
    const r127 = await soloRms(bundle, inst.role, 127, area);
    const r64 = await soloRms(bundle, inst.role, 64, area);
    if (r127 <= 1e-5 || r64 <= 1e-6) {
      report.push(`${area ? `${area.id}/` : ""}${inst.role}: silent in calibration, left at default`);
      return null;
    }
    const p = Math.max(0.5, Math.min(4, Math.log(r127 / r64) / Math.log(127 / 64)));
    return { r127, p, volume: Math.max(0.05, inst.volume) };
  };
  const toCc7 = (f: Fit, k: number) =>
    Math.max(MIN_CC7, Math.min(127, Math.round(127 * Math.pow(Math.min(1, (f.volume * k) / f.r127), 1 / f.p))));

  const fits = new Map<Role, Fit>();
  for (const inst of c.instruments) {
    if (!used.has(inst.role)) continue;
    const fit = await measure(inst);
    if (fit) fits.set(inst.role, fit);
  }

  // Loudest common scale at which every instrument still fits under CC7 = 127,
  // ignoring outliers too weak to keep up (they just get CC7 = 127).
  const headroom = [...fits.values()].map((f) => f.r127 / f.volume).sort((a, b) => a - b);
  const median = headroom[Math.floor(headroom.length / 2)] ?? 1;
  let k = Infinity;
  for (const h of headroom) if (h >= median / 3) k = Math.min(k, h);
  const mixer: Partial<Record<Role, number>> = {};
  for (const [role, f] of fits) {
    mixer[role] = toCc7(f, k);
    report.push(`${role}: rms@127=${f.r127.toFixed(4)} curve=${f.p.toFixed(2)} volume=${f.volume} -> cc7 ${mixer[role]}`);
  }

  // Instruments that individual forms swap in, on the same scale.
  const formMixers: Record<string, Partial<Record<Role, number>>> = {};
  for (const form of c.forms) {
    for (const inst of form.instruments ?? []) {
      const fit = await measure(inst, form);
      if (!fit || !Number.isFinite(k)) continue;
      (formMixers[form.id] ??= {})[inst.role] = toCc7(fit, k);
      report.push(`${form.id}/${inst.role} (${inst.name}): rms@127=${fit.r127.toFixed(4)} -> cc7 ${toCc7(fit, k)}`);
    }
  }

  // Whole-style gain, measured on real mixes from several seeds (forms and
  // tempos differ a lot in energy).
  let energy = 0;
  let peak = 0;
  const seeds = 4;
  for (let i = 0; i < seeds; i++) {
    const mixed = await render([{ ...bundle, mixer, formMixers, gain: 1 }], { seconds: 30, seed: `calibrate/${bundle.id}/mix/${i}` });
    const st = levels(mixed);
    energy += st.rms ** 2 / seeds;
    peak = Math.max(peak, st.peak);
  }
  const rms = Math.sqrt(energy);
  let gain = rms > 1e-5 ? TARGET_RMS / rms : 1;
  if (peak * gain > MAX_PEAK) gain = MAX_PEAK / peak;
  gain = Math.max(0.25, Math.min(16, gain));
  report.push(`mix: rms=${rms.toFixed(4)} peak=${peak.toFixed(3)} -> gain ${gain.toFixed(2)}`);
  return { mixer, formMixers, gain: Math.round(gain * 1000) / 1000, report };
}
