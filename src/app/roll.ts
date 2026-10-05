/**
 * Scrolling score. Notes come in from the right (we schedule a few seconds
 * ahead, so the future is known), cross the playhead and drift off. Drawn like
 * a printed page: ink noteheads on two staves, the lead in the spot colour,
 * drums as crosses. All colours come from the page's CSS variables.
 */
import type { Role } from "../corpus/schema.js";
import type { Player } from "./player.js";

const PAST = 7;
const FUTURE = 2.2;
const LOW = 28;
const HIGH = 100;
/** How strongly each part is inked; the lead is the only one in the spot colour. */
const WEIGHT: Record<Role, number> = { lead: 1, counter: 0.85, arp: 0.7, pad: 0.5, comp: 0.6, bass: 0.95, drums: 0.7 };
/** Staff lines as MIDI keys: treble E4 to F5, bass G2 to A3. */
const STAVES = [[64, 67, 71, 74, 77], [43, 47, 50, 53, 57]];

export class Roll {
  private readonly ctx: CanvasRenderingContext2D;
  private ink = "";
  private spot = "";
  private rule = "";
  private raf = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly player: Player,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.readTheme();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.readTheme());
  }

  /** Re-read the page colours; call after the theme (engine edition) changes. */
  readTheme(): void {
    const css = getComputedStyle(document.documentElement);
    this.ink = css.getPropertyValue("--ink").trim() || "#222";
    this.spot = css.getPropertyValue("--spot").trim() || "#d33";
    this.rule = css.getPropertyValue("--rule").trim() || "#8884";
  }

  start(): void {
    const frame = () => {
      this.draw();
      this.raf = requestAnimationFrame(frame);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(frame);
  }

  private draw(): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);

    const drumBand = h * 0.16;
    const noteH = Math.max(2, ((h - drumBand) / (HIGH - LOW)) * 1.6);
    const yOf = (key: number) => (h - drumBand) * (1 - (Math.min(HIGH, Math.max(LOW, key)) - LOW) / (HIGH - LOW));

    // Staves.
    ctx.fillStyle = this.rule;
    for (const staff of STAVES) for (const key of staff) ctx.fillRect(0, Math.round(yOf(key)), w, Math.max(1, Math.round(dpr)));
    if (!this.player.started) return;

    const now = this.player.now;
    const playX = w * (PAST / (PAST + FUTURE));
    const pxPerSec = w / (PAST + FUTURE);
    const r = Math.max(3.2 * dpr, noteH * 0.8);

    // Bar lines.
    const bars = this.player.window(now - PAST, now + FUTURE);
    for (const tb of bars) {
      const x = playX + (tb.start - now) * pxPerSec;
      ctx.fillRect(Math.round(x), 0, Math.max(1, dpr), h);
    }

    ctx.lineWidth = Math.max(1, 1.2 * dpr);
    for (const tb of bars) {
      const spb = 60 / tb.bar.bpm;
      for (const n of tb.bar.notes) {
        const t0 = tb.start + n.beat * spb;
        const t1 = t0 + n.dur * spb;
        if (t1 < now - PAST || t0 > now + FUTURE) continue;
        const x0 = playX + (t0 - now) * pxPerSec;
        const x1 = playX + (t1 - now) * pxPerSec;
        const sounding = t0 <= now && now < t1;
        const age = now - t1;
        const alpha = t0 > now ? 0.55 : sounding ? 1 : Math.max(0.2, 0.85 - age / PAST);
        ctx.globalAlpha = Math.min(1, alpha * WEIGHT[n.role] * (0.7 + (n.vel / 127) * 0.3));
        ctx.fillStyle = ctx.strokeStyle = n.role === "lead" || sounding ? this.spot : this.ink;
        if (n.role === "drums") {
          const y = h - drumBand + ((n.key % 12) / 12) * (drumBand - 4) + 2 + r / 2;
          ctx.beginPath();
          ctx.moveTo(x0 - r * 0.8, y - r * 0.8);
          ctx.lineTo(x0 + r * 0.8, y + r * 0.8);
          ctx.moveTo(x0 - r * 0.8, y + r * 0.8);
          ctx.lineTo(x0 + r * 0.8, y - r * 0.8);
          ctx.stroke();
        } else {
          const y = yOf(n.key);
          if (x1 - x0 > r * 3) {
            ctx.beginPath();
            ctx.moveTo(x0, y);
            ctx.lineTo(x1 - dpr, y);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.ellipse(x0, y, r * 1.25, r, -0.35, 0, Math.PI * 2);
          if (n.role === "pad") ctx.stroke();
          else ctx.fill();
          if (sounding) {
            ctx.beginPath();
            ctx.arc(x0, y, r * 2.4, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.spot;
    ctx.fillRect(Math.round(playX), 0, Math.max(2, 1.5 * dpr), h);
  }
}
