/**
 * A piece: one style, one key and tempo, one form, a few minutes long.
 * Planning happens up front (cheap); notes are rendered lazily bar by bar.
 */
import type { CompPattern, DrumPattern, Instrument, Motif, Progression, Role, StyleBundle, StyleCorpus } from "../corpus/schema.js";
import { melodicRange, pitchRange } from "../corpus/sound.js";
import { Rng } from "../theory/rng.js";
import { MODES, type ModeName, foldIntoRange, keyLabel, mod, parseRoman, pitchClass } from "../theory/theory.js";
import { bendRangeControls, gestureControls, gestureCurve } from "./gestures.js";
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
  /** How notes are played. Omitted: velocity as written by the default floor, no gestures. */
  expression?: Expression;
  /** Play at this tempo and in this key instead of drawing them (the draws still happen, so the rest of the piece is unchanged). */
  fixed?: { bpm: number; tonic: number; mode?: ModeName };
  /**
   * "set": a track in a DJ set. No ending chord, no gap, no ritardando and no
   * transposing on later passes (a track is in one key); sections are padded to
   * a multiple of 4 bars and the last one so the piece is whole 8-bar phrases.
   */
  frame?: "piece" | "set";
  /** Added to every section's intensity (clamped to 0..1), to play the same form hotter or cooler. */
  lift?: number;
}

/**
 * Performance the arranger adds on top of the notes. None of it changes which
 * notes are written or draws from their random streams, so a seed gives the
 * same piece with or without it.
 */
export interface Expression {
  /** Share of written velocity the quietest section plays at (default 0.62). Lower leaves more dynamic range. */
  velocityFloor?: number;
  /** Write slides, swells, accents and chokes, and their pitch bend and CC11 events. */
  gestures?: boolean;
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
  private readonly expression: Expression;
  private readonly set: boolean;

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
    this.expression = opts.expression ?? {};
    this.set = opts.frame === "set";
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
    const fixed = opts.fixed;
    this.tonic = fixed ? mod(fixed.tonic, 12) : pitchClass(key.tonic);
    this.mode = fixed?.mode ?? (key.mode as ModeName);
    const bpm = Math.round(form.tempo ? area.float(form.tempo.min, form.tempo.max) : styleBpm);
    this.bpm = fixed ? fixed.bpm : bpm;
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
      if (opts.lift) intensity = clamp01(intensity + opts.lift);
      const bars = this.set ? Math.ceil(s.bars / 4) * 4 : s.bars;
      const material = materialFor(s.label, s.progression);
      const harmony = new Harmony(material.progression, bars * c.beatsPerBar);
      const grooveRng = vary.fork("groove");
      const grooves = this.inPalette(c.drums.filter((d) => d.kind === "groove"));
      const byFit = grooveRng.shuffle(grooves).sort((a, b) => Math.abs(a.intensity - intensity) - Math.abs(b.intensity - intensity));
      const fills = this.inPalette(c.drums.filter((d) => d.kind === "fill"));
      sections.push({
        index: sections.length,
        label: s.label,
        bars,
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
      bar += bars;
    };
    for (const s of head) push(s, 0, plan.fork(`head:${s.label}`));
    for (let p = 0; p < passes; p++) {
      const vary = plan.fork(`pass:${p}`);
      if (p > 0 && vary.chance(0.22)) {
        const step = vary.pick([2, -2, 5, -3, 1]);
        if (!this.set) transpose += step;
      }
      for (const s of body) push(s, p, vary.fork(`${s.label}:${sections.length}`));
    }
    for (const s of tail) push(s, 0, plan.fork(`tail:${s.label}`));
    const last = sections[sections.length - 1]!;
    if (this.set && bar % 8) {
      last.bars += 8 - (bar % 8);
      last.harmony = new Harmony(last.material.progression, last.bars * c.beatsPerBar);
      bar = last.startBar + last.bars;
    }
    this.sections = sections;
    this.bodyBars = bar;
    this.totalBars = this.set ? bar : bar + 2;
  }

  get keyName(): string {
    return keyLabel(this.tonic, this.mode);
  }

  /** The chunks a listener can jump between: each section, then the ending (its last bar and the gap) unless the piece is a set's track. */
  get segments(): Segment[] {
    const sections = this.sections.map((s) => ({ label: s.label, start: s.startBar, bars: s.bars }));
    return this.set ? sections : [...sections, { label: "ending", start: this.bodyBars, bars: this.totalBars - this.bodyBars }];
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

  /**
   * The notes and controls of a bar. Roles in `leaveOut` are written as usual
   * (so voicings and random streams are the same either way) and then dropped.
   */
  renderBar(barInPiece: number, globalIndex: number, leaveOut?: ReadonlySet<Role>): Bar {
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
          beatGroups: c.beatGroups,
          barStart,
          barInSection,
          sectionBars: section.bars,
          intensity: section.intensity,
          instrument,
          velocityFloor: this.expression.velocityFloor,
        };
        notes.push(...this.renderRole(role, ctx, section));
      }
    } else if (barInPiece === this.bodyBars) {
      info.chords = [this.finalChord()];
      notes.push(...this.renderEnding(last));
    }

    this.groove(notes, this.rng.fork(`feel:${barInPiece}`), section);
    const played = leaveOut?.size ? notes.filter((n) => !leaveOut.has(n.role)) : notes;
    if (this.expression.gestures) {
      this.gestures(notes, this.rng.fork(`gesture:${barInPiece}`), section, barInPiece);
      controls.push(...gestureControls(played));
    } else for (const n of notes) delete n.gesture;
    return { index: globalIndex, beats: bpb, bpm: this.ritardando(barInPiece, played), notes: played, controls, info };
  }

  /** The chord a piece comes to rest on: the tonic, made major in a minor mode if the style ends with a Picardy third. */
  private finalChord(): string {
    return MODES[this.mode][2] === 4 || this.corpus.ending?.picardy ? "I" : "i";
  }

  /**
   * Tempo of a bar, slowing into the final chord if the style asks for it.
   * The last bar of the body eases from the piece's tempo down to the arrival
   * tempo (its notes are moved, in place, so the slowing is gradual rather than
   * a step at the barline: a bar has one tempo), and the final chord is held at
   * the arrival tempo. The silence after it is back in time.
   */
  private ritardando(barInPiece: number, notes: NoteEvent[]): number {
    const amount = this.corpus.ending?.ritardando ?? 0;
    if (amount <= 0 || this.set || barInPiece > this.bodyBars || barInPiece < this.bodyBars - 1) return this.bpm;
    const arrival = this.bpm * (1 - amount);
    if (barInPiece === this.bodyBars) return Math.round(arrival);
    // Seconds per beat grow linearly across the bar, from 60/bpm to 60/arrival,
    // so the bar lasts as long as one at the mean of the two beat lengths.
    const bpb = this.corpus.beatsPerBar;
    const stretch = this.bpm / arrival - 1;
    const warp = (beat: number) => (beat + (stretch * beat * beat) / (2 * bpb)) / (1 + stretch / 2);
    for (const n of notes) {
      const end = warp(n.beat + n.dur);
      n.beat = warp(n.beat);
      n.dur = Math.max(0.03, end - n.beat);
    }
    return Math.round(this.bpm / (1 + stretch / 2));
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
        return writeMelody(ctx, phrase, role, melodicRange(role, ctx.instrument.octave, rules), this.memory, role === "lead" ? rules.trill : 0);
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
    const span = { chord: parseRoman(this.finalChord()), start: 0, end: bpb };
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
        velocityFloor: this.expression.velocityFloor,
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
      if (this.expression.gestures && inst.role !== "drums") out.push(...bendRangeControls(ch), { beat: 0, kind: "bend", ch, value: 8192 });
    }
    return out;
  }

  /**
   * Decide how the bar's notes are played, in place, and return the bend and
   * CC11 events that say so. Gestures written in the corpus are kept; the rest
   * come from rules that only look at this bar, so a bar is played the same
   * however it was reached:
   *
   *   slide   a line note that starts where the last one ended, a step to a fifth away
   *   swell   a long note on an instrument that sustains (a held pad chord swells as one)
   *   accent  bass and kick landing on the downbeat that opens a full section
   *   choke   an open hi-hat, stopped by the next closed one
   *
   * `gestureControls` turns the curves into events.
   */
  private gestures(notes: NoteEvent[], rng: Rng, section: PlannedSection | undefined, barInPiece: number): void {
    const prev = new Map<Role, NoteEvent>();
    const padSwell = new Map<number, boolean>();
    const landing = section !== undefined && barInPiece === section.startBar && section.index > 0 && section.intensity >= 0.5;
    notes.forEach((n, i) => {
      const before = prev.get(n.role);
      prev.set(n.role, n);
      if (n.role === "drums") {
        delete n.gesture;
        if (n.key === 46) {
          const closed = notes.find((m, j) => j > i && m.role === "drums" && (m.key === 42 || m.key === 44) && m.beat > n.beat + 0.05);
          if (closed) {
            n.gesture = "choke";
            n.dur = closed.beat - n.beat;
          }
        } else if (landing && n.beat < 0.05 && (n.key === 35 || n.key === 36)) n.gesture = "accent";
        if (n.gesture === "accent") n.vel = Math.min(127, Math.round(n.vel * 1.15));
        return;
      }
      const program = this.instruments.get(n.role)?.program ?? 0;
      const line = n.role === "lead" || n.role === "counter" || n.role === "bass";
      // A gesture written in the corpus stands, where the part and the note can carry it.
      let gesture = line && n.dur >= 0.2 && n.gesture !== "choke" ? n.gesture : undefined;
      const interval = before ? before.key - n.key : 0;
      const joined = before !== undefined && n.beat - (before.beat + before.dur) < 0.08 && n.beat > before.beat + 0.05;
      if (!gesture && line) {
        const reach = n.role === "bass" ? 5 : 7;
        if (joined && interval !== 0 && Math.abs(interval) <= reach && n.dur >= 0.4 && bends(program) && rng.chance(n.role === "bass" ? 0.16 : 0.24)) gesture = "slide";
        else if (n.role !== "bass" && n.dur >= 2 && sustains(program) && rng.chance(0.5)) gesture = "swell";
        else if (n.role === "bass" && landing && n.beat < 0.05) gesture = "accent";
      } else if (n.role === "pad" && n.dur >= 2.5 && sustains(program)) {
        // One decision per chord: the channel has a single expression lane.
        const slot = Math.round(n.beat * 2);
        if (!padSwell.has(slot)) padSwell.set(slot, rng.chance(0.4));
        if (padSwell.get(slot)) gesture = "swell";
      }
      delete n.gesture;
      delete n.curve;
      if (!gesture) return;
      n.gesture = gesture;
      if (gesture === "accent") n.vel = Math.min(127, Math.round(n.vel * 1.15));
      const curve = gestureCurve(gesture, n.dur, joined && interval !== 0 ? interval : -1);
      if (curve) n.curve = curve;
    });
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

/** Programs whose pitch can be bent between notes: guitars, basses, bowed strings, winds, synth leads, folk instruments. */
function bends(program: number): boolean {
  return (program >= 24 && program <= 44) || (program >= 56 && program <= 87) || (program >= 104 && program <= 111);
}

/** Programs that hold a note at level, so a swell has something to act on. */
function sustains(program: number): boolean {
  return (program >= 16 && program <= 23) || (program >= 40 && program <= 44) || (program >= 48 && program <= 95) || (program >= 109 && program <= 111);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
