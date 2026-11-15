/**
 * The built-in drum kits, by style id, for styles that declare no kit of
 * their own. Changing a number here changes how the shipped apps sound
 * (baseline.test.ts holds them).
 */
import type { Kit } from "../../corpus/patch.js";

export const KITS: Record<string, Kit> = {
  default: { kick: { f0: 160, f1: 50, sweep: 0.04, decay: 0.35, drive: 1.5, click: 0.3 }, snare: { tone: 190, toneDecay: 0.08, noiseDecay: 0.17, noiseHp: 1200, mix: 0.6 }, hatScale: 1, hatDecay: 0.045 },
  lofi: { kick: { f0: 120, f1: 48, sweep: 0.05, decay: 0.3, drive: 1.2, click: 0.15 }, snare: { tone: 180, toneDecay: 0.06, noiseDecay: 0.14, noiseHp: 900, mix: 0.55 }, hatScale: 0.8, hatDecay: 0.035 },
  synthwave: { kick: { f0: 180, f1: 46, sweep: 0.03, decay: 0.45, drive: 2, click: 0.4 }, snare: { tone: 200, toneDecay: 0.1, noiseDecay: 0.28, noiseHp: 1500, mix: 0.7 }, hatScale: 1.1, hatDecay: 0.05 },
  electro_swing: { kick: { f0: 200, f1: 52, sweep: 0.025, decay: 0.32, drive: 2.5, click: 0.5 }, snare: { tone: 210, toneDecay: 0.06, noiseDecay: 0.16, noiseHp: 1800, mix: 0.65 }, hatScale: 1.2, hatDecay: 0.04 },
  // Brushes: little tone, a long soft swish.
  jazz_trio: { kick: { f0: 95, f1: 52, sweep: 0.04, decay: 0.25, drive: 1, click: 0.05 }, snare: { tone: 190, toneDecay: 0.04, noiseDecay: 0.3, noiseHp: 2500, mix: 0.85 }, hatScale: 0.9, hatDecay: 0.06 },
  retro: { kick: { f0: 300, f1: 50, sweep: 0.02, decay: 0.15, drive: 3, click: 0.6 }, snare: { tone: 240, toneDecay: 0.04, noiseDecay: 0.1, noiseHp: 800, mix: 0.9 }, hatScale: 1.4, hatDecay: 0.03 },
  metroid: { kick: { f0: 150, f1: 42, sweep: 0.05, decay: 0.5, drive: 1.8, click: 0.2 }, snare: { tone: 170, toneDecay: 0.1, noiseDecay: 0.25, noiseHp: 1000, mix: 0.7 }, hatScale: 0.9, hatDecay: 0.05 },
  monkey_island: { kick: { f0: 110, f1: 60, sweep: 0.03, decay: 0.2, drive: 1, click: 0.1 }, snare: { tone: 330, toneDecay: 0.05, noiseDecay: 0.06, noiseHp: 2000, mix: 0.35 }, hatScale: 1, hatDecay: 0.03, toms: { low: 210, high: 320 } },
  bossa_nova: { kick: { f0: 90, f1: 50, sweep: 0.04, decay: 0.22, drive: 1, click: 0.05 }, snare: { tone: 190, toneDecay: 0.04, noiseDecay: 0.28, noiseHp: 2500, mix: 0.85 }, hatScale: 0.9, hatDecay: 0.05 },
  funk: { kick: { f0: 170, f1: 50, sweep: 0.03, decay: 0.3, drive: 1.8, click: 0.35 }, snare: { tone: 220, toneDecay: 0.07, noiseDecay: 0.14, noiseHp: 1600, mix: 0.6 }, hatScale: 1.1, hatDecay: 0.035 },
  // Gallop on deep floor toms.
  western: { kick: { f0: 100, f1: 50, sweep: 0.04, decay: 0.25, drive: 1, click: 0.1 }, snare: { tone: 210, toneDecay: 0.05, noiseDecay: 0.12, noiseHp: 1500, mix: 0.6 }, hatScale: 1, hatDecay: 0.04, toms: { low: 95, high: 150 } },
  // Bodhrán on the toms; a tight pipe-band snare.
  celtic: { kick: { f0: 100, f1: 55, sweep: 0.03, decay: 0.2, drive: 1, click: 0.05 }, snare: { tone: 280, toneDecay: 0.03, noiseDecay: 0.09, noiseHp: 2500, mix: 0.75 }, hatScale: 1, hatDecay: 0.03, toms: { low: 110, high: 180 } },
  musette: { kick: { f0: 95, f1: 52, sweep: 0.04, decay: 0.22, drive: 1, click: 0.05 }, snare: { tone: 190, toneDecay: 0.04, noiseDecay: 0.3, noiseHp: 2500, mix: 0.85 }, hatScale: 0.9, hatDecay: 0.06 },
  liquid_dnb: { kick: { f0: 160, f1: 48, sweep: 0.04, decay: 0.32, drive: 1.6, click: 0.3 }, snare: { tone: 230, toneDecay: 0.08, noiseDecay: 0.18, noiseHp: 1800, mix: 0.65 }, hatScale: 1.2, hatDecay: 0.03 },
  castlevania: { kick: { f0: 190, f1: 48, sweep: 0.03, decay: 0.35, drive: 2.2, click: 0.45 }, snare: { tone: 200, toneDecay: 0.09, noiseDecay: 0.22, noiseHp: 1300, mix: 0.7 }, hatScale: 1.1, hatDecay: 0.04 },
  // Timpani on the toms.
  jrpg: { kick: { f0: 120, f1: 48, sweep: 0.04, decay: 0.35, drive: 1.3, click: 0.15 }, snare: { tone: 190, toneDecay: 0.05, noiseDecay: 0.2, noiseHp: 1800, mix: 0.8 }, hatScale: 1, hatDecay: 0.045, toms: { low: 70, high: 105 } },
  disco: { kick: { f0: 150, f1: 52, sweep: 0.03, decay: 0.28, drive: 1.6, click: 0.35 }, snare: { tone: 215, toneDecay: 0.06, noiseDecay: 0.16, noiseHp: 1700, mix: 0.65 }, hatScale: 1.15, hatDecay: 0.04, toms: { low: 120, high: 190 } },
  // Kettledrums on the toms, a fourth apart.
  baroque: { kick: { f0: 100, f1: 50, sweep: 0.04, decay: 0.3, drive: 1, click: 0.05 }, snare: { tone: 190, toneDecay: 0.05, noiseDecay: 0.2, noiseHp: 1800, mix: 0.8 }, hatScale: 1, hatDecay: 0.045, toms: { low: 82, high: 110 } },
  midnight_platform: { kick: { f0: 95, f1: 52, sweep: 0.04, decay: 0.23, drive: 1, click: 0.04 }, snare: { tone: 185, toneDecay: 0.035, noiseDecay: 0.28, noiseHp: 2400, mix: 0.88 }, hatScale: 0.9, hatDecay: 0.055, toms: { low: 120, high: 180 } },
  // Frame drum: a short dum, a slap on the low tom.
  courtyard_nine: { kick: { f0: 140, f1: 58, sweep: 0.02, decay: 0.16, drive: 1.15, click: 0.08 }, snare: { tone: 240, toneDecay: 0.03, noiseDecay: 0.07, noiseHp: 1800, mix: 0.45 }, hatScale: 0.7, hatDecay: 0.03, toms: { low: 110, high: 160 } },
  // Soft kick under a singing bass; the shaker is the only chatter.
  low_log: { kick: { f0: 125, f1: 44, sweep: 0.04, decay: 0.26, drive: 1.25, click: 0.1 }, snare: { tone: 170, toneDecay: 0.03, noiseDecay: 0.08, noiseHp: 1600, mix: 0.55 }, hatScale: 0.55, hatDecay: 0.025, toms: { low: 95, high: 140 } },
};
