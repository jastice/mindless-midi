/**
 * The conductor strings pieces together forever, choosing a style for each
 * from the user's selection. It is a pure, deterministic bar generator: the
 * same seed and selection always yields the same music.
 */
import type { StyleBundle } from "../corpus/schema.js";
import { Rng } from "../theory/rng.js";
import { DEFAULT_PIECE_OPTIONS, Piece, type PieceOptions } from "./piece.js";
import type { Bar } from "./types.js";

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
  }

  get currentPiece(): Piece | null {
    return this.piece;
  }

  nextBar(): Bar {
    if (!this.piece || this.barInPiece >= this.piece.totalBars) this.startPiece();
    const bar = this.piece!.renderBar(this.barInPiece, this.barIndex);
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
