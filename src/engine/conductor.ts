/**
 * The conductor strings pieces together forever, choosing a style for each
 * from the user's selection. It is a pure, deterministic bar generator: the
 * same seed and selection always yields the same music.
 */
import type { StyleBundle } from "../corpus/schema.js";
import { Rng } from "../theory/rng.js";
import { DEFAULT_PIECE_OPTIONS, Piece, type PieceOptions } from "./piece.js";
import type { Bar, ControlEvent } from "./types.js";

/** How many pieces `seek` will replay (a link can't ask for more), so a hand-edited position can't hang the tab. */
export const MAX_SEEK_PIECE = 1000;

/** Where a seek landed: a bar, and the segment (section, or the ending) that holds it. */
export interface Landing {
  piece: number;
  bar: number;
  segment: number;
  /** Segments in the piece. */
  segments: number;
  label: string;
}

/** What it took to start a piece, so it can be started again exactly. */
interface Choice {
  style: StyleBundle;
  /** The form this style used last time, which the piece avoids repeating. */
  previousForm: string | undefined;
  formId: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.floor(n), lo), hi);

export class Conductor {
  readonly seed: string;
  private styles: StyleBundle[];
  private readonly opts: PieceOptions;
  private piece: Piece | null = null;
  private barInPiece = 0;
  private barIndex = 0;
  /** The next piece to start. */
  private pieceIndex = 0;
  /** Every piece started so far, in order. Seeking back plays them as they were, whatever the pool is now. */
  private readonly chosen: Choice[] = [];
  /** Setup of the bars `seek` skipped, to ride along with the first bar returned. */
  private carry: ControlEvent[] = [];

  constructor(styles: StyleBundle[], seed: string, opts: PieceOptions = DEFAULT_PIECE_OPTIONS) {
    if (!styles.length) throw new Error("Conductor needs at least one style");
    this.styles = styles;
    this.seed = seed;
    this.opts = opts;
  }

  /** Change the style pool. Takes effect at the next piece (not yet started ones are chosen again). */
  setStyles(styles: StyleBundle[]): void {
    if (!styles.length) throw new Error("Conductor needs at least one style");
    this.styles = styles;
    this.chosen.length = Math.min(this.chosen.length, this.pieceIndex);
  }

  /** Abandon the current piece; the next bar starts a new one. */
  skip(): void {
    this.piece = null;
    this.carry = [];
  }

  get currentPiece(): Piece | null {
    return this.piece;
  }

  /**
   * Make the next bar be `barInPiece` of piece `pieceIndex`, as though everything before it had
   * been played. Pieces already started come back exactly as they were; for later ones (a link
   * into a fresh session, say) each piece's style and form depend on the one before, and a
   * piece's voicings on its earlier bars, so they are replayed (quickly; nothing is rendered to
   * audio) with the current style pool. Skips don't matter.
   *
   * The bar returned first carries the setup (instruments, levels) of the bars skipped in its
   * piece, as a listener joining mid-piece needs it. Positions out of range are clamped.
   */
  seek(pieceIndex: number, barInPiece: number): Landing {
    return this.land(this.enter(pieceIndex), barInPiece);
  }

  /** Like `seek`, to the first bar of a segment of the piece; a negative `segment` counts from the end. */
  seekSegment(pieceIndex: number, segment: number): Landing {
    const piece = this.enter(pieceIndex);
    const segments = piece.segments;
    return this.land(piece, segments[clamp(segment < 0 ? segments.length + segment : segment, 0, segments.length - 1)]!.start);
  }

  nextBar(): Bar {
    if (!this.piece || this.barInPiece >= this.piece.totalBars) this.startPiece();
    let bar = this.piece!.renderBar(this.barInPiece, this.barIndex);
    if (this.carry.length) {
      bar = { ...bar, controls: [...this.carry, ...bar.controls] };
      this.carry = [];
    }
    this.barInPiece++;
    this.barIndex++;
    return bar;
  }

  /** Start piece `pieceIndex` (starting any not yet started before it) and make it the current one. */
  private enter(pieceIndex: number): Piece {
    const target = clamp(pieceIndex, 0, MAX_SEEK_PIECE);
    while (this.chosen.length < target) {
      this.pieceIndex = this.chosen.length;
      this.startPiece();
    }
    this.pieceIndex = target;
    this.startPiece();
    return this.piece!;
  }

  private land(piece: Piece, barInPiece: number): Landing {
    const bar = clamp(barInPiece, 0, piece.totalBars - 1);
    this.carry = [];
    for (let b = 0; b < bar; b++) {
      for (const c of piece.renderBar(b, 0).controls) this.carry.push({ ...c, beat: 0 });
    }
    this.barInPiece = bar;
    const segments = piece.segments;
    let segment = segments.length - 1;
    while (segment > 0 && segments[segment]!.start > bar) segment--;
    return { piece: piece.index, bar, segment, segments: segments.length, label: segments[segment]!.label };
  }

  private startPiece(): void {
    const i = this.pieceIndex;
    let choice = this.chosen[i];
    if (!choice) {
      const lastStyleId = this.chosen[i - 1]?.style.id;
      const pool = this.styles.length > 1 ? this.styles.filter((s) => s.id !== lastStyleId) : this.styles;
      const style = new Rng(`${this.seed}/choose/${i}`).pick(pool);
      let previousForm: string | undefined;
      for (let k = i - 1; k >= 0 && previousForm === undefined; k--) {
        if (this.chosen[k]!.style.id === style.id) previousForm = this.chosen[k]!.formId;
      }
      choice = { style, previousForm, formId: "" };
    }
    this.piece = new Piece(choice.style, `${this.seed}/piece/${i}/${choice.style.id}`, i, this.opts, choice.previousForm);
    choice.formId = this.piece.formId;
    this.chosen[i] = choice;
    this.pieceIndex = i + 1;
    this.barInPiece = 0;
  }
}
