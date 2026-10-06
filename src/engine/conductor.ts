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

export class Conductor {
  readonly seed: string;
  private styles: StyleBundle[];
  private readonly opts: PieceOptions;
  private piece: Piece | null = null;
  private barInPiece = 0;
  private barIndex = 0;
  private pieceIndex = 0;
  private lastStyleId: string | null = null;
  private readonly lastForm = new Map<string, string>();
  /** Setup of the bars `seek` skipped, to ride along with the first bar returned. */
  private carry: ControlEvent[] = [];

  constructor(styles: StyleBundle[], seed: string, opts: PieceOptions = DEFAULT_PIECE_OPTIONS) {
    if (!styles.length) throw new Error("Conductor needs at least one style");
    this.styles = styles;
    this.seed = seed;
    this.opts = opts;
  }

  /** Change the style pool. Takes effect at the next piece. */
  setStyles(styles: StyleBundle[]): void {
    if (!styles.length) throw new Error("Conductor needs at least one style");
    this.styles = styles;
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
   * been played. Each piece's style and form depend on the one before, and a piece's voicings
   * on its earlier bars, so this replays them (quickly; nothing is rendered to audio). Pieces
   * come out the same as in the original run provided the style pool was the same then; skips
   * don't matter. Only valid before the first bar.
   *
   * The bar returned first carries the setup (instruments, levels) of the bars skipped in its
   * piece, as a listener joining mid-piece needs it. Returns where it landed (positions out of
   * range are clamped).
   */
  seek(pieceIndex: number, barInPiece: number): { piece: number; bar: number } {
    if (this.pieceIndex || this.barIndex) throw new Error("seek must come before the first bar");
    const last = Math.min(Math.max(Math.floor(pieceIndex), 0), MAX_SEEK_PIECE);
    for (let i = 0; i <= last; i++) this.startPiece();
    const piece = this.piece!;
    const bar = Math.min(Math.max(Math.floor(barInPiece), 0), piece.totalBars - 1);
    for (let b = 0; b < bar; b++) {
      for (const c of piece.renderBar(b, 0).controls) this.carry.push({ ...c, beat: 0 });
    }
    this.barInPiece = bar;
    return { piece: last, bar };
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

  private startPiece(): void {
    const rng = new Rng(`${this.seed}/choose/${this.pieceIndex}`);
    const pool = this.styles.length > 1 ? this.styles.filter((s) => s.id !== this.lastStyleId) : this.styles;
    const style = rng.pick(pool);
    this.piece = new Piece(
      style,
      `${this.seed}/piece/${this.pieceIndex}/${style.id}`,
      this.pieceIndex,
      this.opts,
      this.lastForm.get(style.id),
    );
    this.lastStyleId = style.id;
    this.lastForm.set(style.id, this.piece.formId);
    this.pieceIndex++;
    this.barInPiece = 0;
  }
}
