/**
 * A piece: one style, one key and tempo, one form, a few minutes long.
 * Planning happens up front (cheap); notes are rendered lazily bar by bar.
 */
import type { CompPattern, DrumPattern, Instrument, Motif, Progression, Role, StyleBundle, StyleCorpus } from "../corpus/schema.js";
import { melodicRange, pitchRange } from "../corpus/sound.js";
import { Rng } from "../theory/rng.js";
import { MODES, type ModeName, foldIntoRange, keyLabel, mod, parseRoman, pitchClass } from "../theory/theory.js";
import { Harmony } from "./harmony.js";
import {
  type BarContext,
  composePhrase,
  hasCymbals,
  holdChord,
  newMemory,
  type PartMemory,
  type PhraseNote,
  writeChords,
  writeDrums,
  writeMelody,
  writeOstinato,
} from "./parts.js";
import { type Bar, CHANNELS, type ControlEvent, type NoteEvent } from "./types.js";

export interface PieceOptions {
  minSeconds: number;
  maxSeconds: number;
}

export const DEFAULT_PIECE_OPTIONS: PieceOptions = { minSeconds: 150, maxSeconds: 330 };

interface Material {
  progression: Progression;
  motifs: Record<"lead" | "counter" | "arp" | "bass", Motif[]>;
  comping: Partial<Record<"pad" | "comp", CompPattern>>;
}

interface PlannedSection {
  index: number;
  label: string;
  bars: number;
  startBar: number;
  intensity: number;
  roles: Role[];
  pass: number;
  transpose: number;
  material: Material;
  harmony: Harmony;
  grooves: DrumPattern[];
  fill: DrumPattern | undefined;
}

/** A stretch of a piece: a section, or the ending. */
export interface Segment {
  label: string;
  /** First bar, counted from the start of the piece. */
  start: number;
  bars: number;
}

const FRAME_LABELS = /^(intro|outro|ending|coda)/i;

export class Piece {
  readonly style: StyleBundle;
  readonly corpus: StyleCorpus;
  readonly seed: string;
  readonly index: number;
  readonly tonic: number;
  readonly mode: ModeName;
  readonly bpm: number;
  readonly sections: PlannedSection[];
  /** Section bars + ending bar + gap bar. */
  readonly totalBars: number;
  readonly formId: string;
  /** The form's area tag, if any (e.g. "lava caverns"). */
  readonly palette: string | undefined;

  private readonly rng: Rng;
  private readonly instruments = new Map<Role, Instrument>();
  private readonly overridden = new Set<Role>();
  private readonly memory: PartMemory = newMemory();
  private readonly bodyBars: number;

  constructor(
    style: StyleBundle,
    seed: string,
    index: number,
    opts: PieceOptions = DEFAULT_PIECE_OPTIONS,
    /** The form this style used last time, to avoid back-to-back repeats. */
    previousForm?: string,
  ) {
    this.style = style;
    this.corpus = style.corpus;
    this.seed = seed;
    this.index = index;
    this.rng = new Rng(seed);
    const c = this.corpus;
    for (const inst of c.instruments) this.instruments.set(inst.role, inst);

    const plan = this.rng.fork("plan");
    const styleKey = plan.pick(c.keys);
    const styleBpm = plan.float(c.tempo.min, c.tempo.max);
    const fresh = c.forms.filter((f) => f.id !== previousForm);
    const form = plan.pick(fresh.length ? fresh : c.forms);
    this.formId = form.id;
    this.palette = form.palette;
    // Forms can define an "area" with its own keys, tempo and instruments.
    // (A separate stream, so pieces from forms without overrides keep their seeds.)
    const area = this.rng.fork("area");
    const key = form.keys?.length ? area.pick(form.keys) : styleKey;
    this.tonic = pitchClass(key.tonic);
    this.mode = key.mode as ModeName;
    this.bpm = Math.round(form.tempo ? area.float(form.tempo.min, form.tempo.max) : styleBpm);
    for (const inst of form.instruments ?? []) {
      this.instruments.set(inst.role, inst);
      this.overridden.add(inst.role);
    }

    // How many passes through the body to hit the target duration.
    const barSec = (c.beatsPerBar * 60) / this.bpm;
    const head = leadingFrame(form.sections);
    const tail = trailingFrame(form.sections);
    const body = form.sections.slice(head.length, form.sections.length - tail.length);
    const secOf = (ss: typeof body) => ss.reduce((a, s) => a + s.bars, 0) * barSec;
    const target = plan.float(opts.minSeconds, opts.maxSeconds);
    let passes = 1;
    if (body.length) {
      while (passes < 12 && secOf(head) + secOf(tail) + secOf(body) * (passes + 1) <= target) passes++;
      while (passes < 12 && secOf(head) + secOf(tail) + secOf(body) * passes < opts.minSeconds) passes++;
    }

    // One set of material per section label so repeats are recognisable.
    const materials = new Map<string, Material>();
    const usedProgressions = new Set<string>();
    const materialFor = (label: string, progressionId: string | undefined): Material => {
      let m = materials.get(label);
      if (!m) {
        m = this.pickMaterial(plan.fork(`material:${label}`), usedProgressions, progressionId);
        materials.set(label, m);
      }
      return m;
    };

    const sections: PlannedSection[] = [];
    let bar = 0;
    let transpose = 0;
    const push = (s: (typeof body)[number], pass: number, vary: Rng) => {
      let roles = [...s.roles];
      let intensity = s.intensity;
      if (pass > 0 && !FRAME_LABELS.test(s.label)) {
        roles = this.varyRoles(roles, vary);
        intensity = clamp01(intensity + vary.float(-0.08, 0.12));
      }
      const material = materialFor(s.label, s.progression);
      const harmony = new Harmony(material.progression, s.bars * c.beatsPerBar);
      const grooveRng = vary.fork("groove");
      const grooves = this.inPalette(c.drums.filter((d) => d.kind === "groove"));
      const byFit = grooveRng.shuffle(grooves).sort((a, b) => Math.abs(a.intensity - intensity) - Math.abs(b.intensity - intensity));
      const fills = this.inPalette(c.drums.filter((d) => d.kind === "fill"));
      sections.push({
        index: sections.length,
        label: s.label,
        bars: s.bars,
        startBar: bar,
        intensity,
        roles,
        pass,
        transpose,
        material,
        harmony,
        grooves: byFit.slice(0, 2),
        fill: fills.length ? grooveRng.weighted(fills, (f) => 1 / (0.15 + Math.abs(f.intensity - intensity))) : undefined,
      });
      bar += s.bars;
    };
    for (const s of head) push(s, 0, plan.fork(`head:${s.label}`));
    for (let p = 0; p < passes; p++) {
      const vary = plan.fork(`pass:${p}`);
      if (p > 0 && vary.chance(0.22)) transpose += vary.pick([2, -2, 5, -3, 1]);
      for (const s of body) push(s, p, vary.fork(`${s.label}:${sections.length}`));
    }
    for (const s of tail) push(s, 0, plan.fork(`tail:${s.label}`));
    this.sections = sections;
    this.bodyBars = bar;
    this.totalBars = bar + 2;
  }

  get keyName(): string {
    return keyLabel(this.tonic, this.mode);
  }

  /** The chunks a listener can jump between: each section, then the ending (its last bar and the gap). */
  get segments(): Segment[] {
    return [
      ...this.sections.map((s) => ({ label: s.label, start: s.startBar, bars: s.bars })),
      { label: "ending", start: this.bodyBars, bars: this.totalBars - this.bodyBars },
    ];
  }

  get seconds(): number {
    return (this.totalBars * this.corpus.beatsPerBar * 60) / this.bpm;
  }

  private pickMaterial(rng: Rng, used: Set<string>, progressionId: string | undefined): Material {
    const c = this.corpus;
    const progressions = this.inPalette(c.progressions);
    const fresh = progressions.filter((p) => !used.has(p.id));
    const bound = c.progressions.find((p) => p.id === progressionId);
    const progression = bound ?? rng.pick(fresh.length ? fresh : progressions);
    used.add(progression.id);
    const motifsFor = (role: Motif["role"], n: number) =>
      rng.shuffle(this.inPalette(c.motifs.filter((m) => m.role === role))).slice(0, n);
    let counter = motifsFor("counter", 2);
    const lead = motifsFor("lead", 2);
    if (!counter.length) {
      counter = rng.shuffle(this.inPalette(c.motifs.filter((m) => m.role === "lead")).filter((m) => !lead.includes(m))).slice(0, 2);
    }
    if (!counter.length) counter = lead.slice().reverse();
    const pickComp = (role: CompPattern["role"]) => {
      const options = this.inPalette(c.comping.filter((p) => p.role === role));
      return options.length ? rng.pick(options) : undefined;
    };
    return {
      progression,
      motifs: { lead, counter, arp: motifsFor("arp", 2), bass: motifsFor("bass", 2) },
      comping: { pad: pickComp("pad") ?? pickComp("comp"), comp: pickComp("comp") ?? pickComp("pad") },
    };
  }

  /**
   * Material for this piece's area: items tagged with the form's palette if
   * there are any, else untagged items, else anything.
   */
  private inPalette<T extends { palette?: string | undefined }>(items: T[]): T[] {
    if (this.palette !== undefined) {
      const tagged = items.filter((x) => x.palette === this.palette);
      if (tagged.length) return tagged;
    }
    const untagged = items.filter((x) => x.palette === undefined);
    return untagged.length ? untagged : items;
  }

  /** Small orchestration changes on repeats so passes don't sound identical. */
  private varyRoles(roles: Role[], rng: Rng): Role[] {
    const out = roles.slice();
    const optional: Role[] = ["counter", "arp", "pad", "comp"];
    if (rng.chance(0.35)) {
      const droppable = out.filter((r) => optional.includes(r));
      if (droppable.length && out.length > 2) out.splice(out.indexOf(rng.pick(droppable)), 1);
    }
    if (rng.chance(0.3)) {
      const addable = optional.filter((r) => !out.includes(r) && this.instruments.has(r) && this.hasMaterial(r));
      if (addable.length) out.push(rng.pick(addable));
    }
    return out;
  }

  private hasMaterial(role: Role): boolean {
    const c = this.corpus;
    switch (role) {
      case "pad":
      case "comp":
        return c.comping.length > 0;
      case "drums":
        return c.drums.some((d) => d.kind === "groove");
      case "counter":
        return c.motifs.some((m) => m.role === "counter" || m.role === "lead");
      default:
        return c.motifs.some((m) => m.role === role);
    }
  }

  sectionAt(barInPiece: number): PlannedSection | undefined {
    return this.sections.find((s) => barInPiece >= s.startBar && barInPiece < s.startBar + s.bars);
  }

  renderBar(barInPiece: number, globalIndex: number): Bar {
    const c = this.corpus;
    const bpb = c.beatsPerBar;
    const notes: NoteEvent[] = [];
    const controls: ControlEvent[] = barInPiece === 0 ? this.setupControls() : [];
    const section = this.sectionAt(barInPiece);
    const last = this.sections[this.sections.length - 1]!;
    const info = {
      pieceIndex: this.index,
      pieceSeed: this.seed,
      styleId: this.style.id,
      styleTitle: c.title,
      area: this.palette,
      keyName: keyLabel(this.tonic + (section ?? last).transpose, this.mode),
      tonic: mod(this.tonic + (section ?? last).transpose, 12),
      mode: this.mode,
      section: section?.label ?? (barInPiece === this.bodyBars ? "ending" : ""),
      sectionIndex: section?.index ?? this.sections.length,
      sectionCount: this.sections.length,
      barInSection: section ? barInPiece - section.startBar : 0,
      sectionBars: section?.bars ?? 1,
      barInPiece,
      pieceBars: this.totalBars,
      intensity: section?.intensity ?? 0.3,
      chords: [] as string[],
      gap: barInPiece > this.bodyBars,
    };

    if (section) {
      const barInSection = barInPiece - section.startBar;
      const barStart = barInSection * bpb;
      info.chords = section.harmony.between(barStart, barStart + bpb).map((s) => s.chord.symbol);
      const rng = this.rng.fork(`bar:${barInPiece}`);
      for (const role of section.roles) {
        const instrument = this.instruments.get(role);
        if (!instrument) continue;
        const ctx: BarContext = {
          rng: rng.fork(role),
          tonic: mod(this.tonic + section.transpose, 12),
          mode: this.mode,
          harmony: section.harmony,
          beatsPerBar: bpb,
          barStart,
          barInSection,
          sectionBars: section.bars,
          intensity: section.intensity,
          instrument,
        };
        notes.push(...this.renderRole(role, ctx, section));
      }
    } else if (barInPiece === this.bodyBars) {
      notes.push(...this.renderEnding(last));
    }

    this.groove(notes, this.rng.fork(`feel:${barInPiece}`), section);
    return { index: globalIndex, beats: bpb, bpm: this.bpm, notes, controls, info };
  }

  private renderRole(role: Role, ctx: BarContext, section: PlannedSection): NoteEvent[] {
    const m = section.material;
    const isLastBar = ctx.barInSection === section.bars - 1;
    switch (role) {
      case "drums": {
        let pattern = section.grooves[0];
        if (!pattern) return [];
        if (isLastBar && section.fill && section.bars > 1 && ctx.rng.chance(0.75)) pattern = section.fill;
        else if (section.grooves[1] && ctx.barInSection % 4 === 3 && ctx.rng.chance(0.35)) pattern = section.grooves[1];
        const crash = ctx.barInSection === 0 && section.index > 0 && section.intensity > 0.35 && hasCymbals(pattern);
        const out = writeDrums(ctx, pattern, { crash });
        if (pattern.stepsPerBeat % 2 !== 0) for (const n of out) n.straight = true;
        return out;
      }
      case "bass":
      case "arp": {
        const motifs = m.motifs[role];
        if (!motifs.length) return [];
        const alt = motifs[1] && ctx.barInSection % 8 >= 6 && this.rng.fork(`alt:${section.index}:${role}`).chance(0.6);
        const motif = alt ? motifs[1]! : motifs[0]!;
        return writeOstinato(ctx, motif, melodicRange(role, ctx.instrument.octave, this.corpus.melody));
      }
      case "pad":
      case "comp": {
        const pattern = m.comping[role];
        return pattern ? writeChords(ctx, pattern, this.memory) : [];
      }
      case "lead":
      case "counter": {
        const rules = this.corpus.melody;
        const phraseBars = Math.max(1, rules.phraseBars);
        const phraseIdx = Math.floor(ctx.barInSection / phraseBars);
        const phrase = this.phrase(section, role, phraseIdx, phraseBars);
        return writeMelody(ctx, phrase, role, melodicRange(role, ctx.instrument.octave, rules), this.memory);
      }
    }
  }

  private phrase(section: PlannedSection, role: "lead" | "counter", phraseIdx: number, phraseBars: number): PhraseNote[] {
    const cacheKey = `${section.index}:${role}:${phraseIdx}`;
    const cached = this.memory.phrases.get(cacheKey);
    if (cached) return cached;
    const rules = this.corpus.melody;
    const bpb = this.corpus.beatsPerBar;
    // Repeated sections usually replay the same melody; later passes sometimes vary it.
    const decide = this.rng.fork(`phrase-variant:${section.index}:${role}:${phraseIdx}`);
    const variant = section.pass > 0 && decide.chance(0.45) ? `:v${section.pass}` : "";
    const rng = this.rng.fork(`phrase:${section.label}:${role}:${phraseIdx}${variant}`);
    const bars = Math.min(phraseBars, section.bars - phraseIdx * phraseBars);
    let notes: PhraseNote[] = [];
    let rest = rng.chance(rules.restProbability);
    if (role === "counter" && section.roles.includes("lead")) {
      const leadPhrase = this.phrase(section, "lead", phraseIdx, phraseBars);
      rest = leadPhrase.length > 0 ? rng.chance(0.55) : rng.chance(0.15);
    }
    if (!rest) {
      const pool = section.material.motifs[role];
      const motifs = phraseIdx % 2 === 1 && pool.length > 1 ? [pool[1]!, pool[0]!] : pool;
      notes = composePhrase(motifs, rules, rng, phraseIdx * phraseBars * bpb, bars * bpb, role === "counter" ? 0.35 : 0);
    }
    this.memory.phrases.set(cacheKey, notes);
    return notes;
  }

  private renderEnding(last: PlannedSection): NoteEvent[] {
    const c = this.corpus;
    const bpb = c.beatsPerBar;
    const third = MODES[this.mode][2];
    const span = { chord: parseRoman(third === 4 ? "I" : "i"), start: 0, end: bpb };
    const out: NoteEvent[] = [];
    const dur = bpb * 1.5;
    const ctxFor = (role: Role): BarContext | undefined => {
      const instrument = this.instruments.get(role);
      if (!instrument) return undefined;
      return {
        rng: this.rng.fork(`ending:${role}`),
        tonic: mod(this.tonic + last.transpose, 12),
        mode: this.mode,
        harmony: last.harmony,
        beatsPerBar: bpb,
        barStart: 0,
        barInSection: 0,
        sectionBars: 1,
        intensity: Math.min(0.6, last.intensity),
        instrument,
      };
    };
    const chordRole = (["pad", "comp", "arp", "lead"] as const).find((r) => last.roles.includes(r) && this.instruments.has(r))
      ?? (["pad", "comp"] as const).find((r) => this.instruments.has(r));
    if (chordRole) {
      const ctx = ctxFor(chordRole)!;
      // Pads and comps are voiced inside their declared range already; a lead or arp
      // holding the chord folds into its own register (merging notes that land together).
      const [low, high] = pitchRange(ctx.instrument, this.corpus);
      const held = holdChord(ctx, span, chordRole, dur, this.memory, 0.55);
      for (const n of held) n.key = foldIntoRange(n.key, low, high);
      out.push(...held.filter((n, i) => held.findIndex((m) => m.key === n.key) === i));
    }
    const bassCtx = ctxFor("bass");
    if (bassCtx && last.roles.includes("bass")) {
      const root = 12 * (bassCtx.instrument.octave + 1) + bassCtx.tonic;
      const [low, high] = pitchRange(bassCtx.instrument, this.corpus);
      out.push({ beat: 0, dur, ch: CHANNELS.bass, key: foldIntoRange(root > 50 ? root - 12 : root, low, high), vel: 70, role: "bass" });
    }
    if (last.roles.includes("drums")) {
      if (!last.grooves[0] || hasCymbals(last.grooves[0])) {
        out.push({ beat: 0, dur: 1, ch: CHANNELS.drums, key: 49, vel: 60, role: "drums" });
        out.push({ beat: 0, dur: 1, ch: CHANNELS.drums, key: 36, vel: 70, role: "drums" });
      } else {
        // Hand percussion ends on its low drum instead of a kit's crash.
        out.push({ beat: 0, dur: 1, ch: CHANNELS.drums, key: 45, vel: 75, role: "drums" });
      }
    }
    return out;
  }

  private setupControls(): ControlEvent[] {
    const out: ControlEvent[] = [
      { beat: 0, kind: "reset" },
      { beat: 0, kind: "bank", value: this.style.bank },
      { beat: 0, kind: "gain", value: this.style.gain ?? 1 },
    ];
    for (const inst of this.instruments.values()) {
      const ch = CHANNELS[inst.role];
      if (inst.role !== "drums") out.push({ beat: 0, kind: "program", ch, value: inst.program });
      const calibrated = this.overridden.has(inst.role)
        ? this.style.formMixers?.[this.formId]?.[inst.role]
        : this.style.mixer?.[inst.role];
      const level = calibrated ?? Math.round(Math.max(0, Math.min(1, inst.volume)) * 110);
      out.push({ beat: 0, kind: "cc", ch, cc: 7, value: level });
      out.push({ beat: 0, kind: "cc", ch, cc: 10, value: Math.round(64 + Math.max(-1, Math.min(1, inst.pan)) * 63) });
      out.push({ beat: 0, kind: "cc", ch, cc: 11, value: 127 });
    }
    return out;
  }

  /** Swing + humanization, in place. */
  private groove(notes: NoteEvent[], rng: Rng, section: PlannedSection | undefined): void {
    const c = this.corpus;
    const unit = c.swingUnit === "8th" ? 0.5 : 0.25;
    const swing = (b: number): number => {
      if (c.swing <= 0) return b;
      const pos = b / unit;
      const r = Math.round(pos);
      return Math.abs(pos - r) < 1e-6 && mod(r, 2) === 1 ? b + (c.swing * unit) / 3 : b;
    };
    const loose = c.humanize;
    for (const n of notes) {
      const start = n.straight ? n.beat : swing(n.beat);
      const end = n.straight ? n.beat + n.dur : swing(n.beat + n.dur);
      const jitter = section && n.beat > 0 ? rng.gauss() * loose * 0.02 : 0;
      n.beat = Math.max(0, start + jitter);
      n.dur = Math.max(0.03, end - start);
      if (loose > 0) n.vel = Math.max(1, Math.min(127, Math.round(n.vel + rng.gauss() * loose * 7)));
      delete n.straight;
    }
    notes.sort((a, b) => a.beat - b.beat);
  }
}

function leadingFrame<T extends { label: string }>(ss: T[]): T[] {
  const out: T[] = [];
  for (const s of ss) {
    if (!/^intro/i.test(s.label)) break;
    out.push(s);
  }
  return out.length === ss.length ? [] : out;
}

function trailingFrame<T extends { label: string }>(ss: T[]): T[] {
  const out: T[] = [];
  for (let i = ss.length - 1; i >= 0; i--) {
    if (!/^(outro|ending|coda)/i.test(ss[i]!.label)) break;
    out.unshift(ss[i]!);
  }
  return out.length === ss.length ? [] : out;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
