/**
 * Scrolling piano roll. Notes come in from the right (we schedule a few
 * seconds ahead, so the future is known), cross the playhead and drift off.
 */
import type { Role } from "../corpus/schema.js";
import type { Player } from "./player.js";

const PAST = 7;
const FUTURE = 2.2;
const LOW = 28;
const HIGH = 100;
const ROLES: Role[] = ["lead", "counter", "arp", "pad", "comp", "bass", "drums"];

export class Roll {
  private readonly ctx: CanvasRenderingContext2D;
  private colors = new Map<Role, string>();
  private gridColor = "";
  private playheadColor = "";
  private raf = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly player: Player,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.readTheme();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.readTheme());
  }

  private readTheme(): void {
    const css = getComputedStyle(document.documentElement);
    for (const r of ROLES) this.colors.set(r, css.getPropertyValue(`--role-${r}`).trim() || "#888");
    this.gridColor = css.getPropertyValue("--grid").trim();
    this.playheadColor = css.getPropertyValue("--playhead").trim();
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
    if (!this.player.started) return;

    const now = this.player.now;
    const playX = w * (PAST / (PAST + FUTURE));
    const pxPerSec = w / (PAST + FUTURE);
    const drumBand = h * 0.16;
    const noteH = Math.max(2, ((h - drumBand) / (HIGH - LOW)) * 1.6);
    const yOf = (key: number) => (h - drumBand) * (1 - (Math.min(HIGH, Math.max(LOW, key)) - LOW) / (HIGH - LOW));

    // Bar lines.
    ctx.fillStyle = this.gridColor;
    const bars = this.player.window(now - PAST, now + FUTURE);
    for (const tb of bars) {
      const x = playX + (tb.start - now) * pxPerSec;
      ctx.fillRect(Math.round(x), 0, Math.max(1, dpr), h);
    }

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
        const alpha = t0 > now ? 0.35 : sounding ? 1 : Math.max(0.12, 0.75 - age / PAST);
        ctx.globalAlpha = alpha * (0.45 + (n.vel / 127) * 0.55);
        ctx.fillStyle = this.colors.get(n.role) ?? "#888";
        if (n.role === "drums") {
          const y = h - drumBand + ((n.key % 12) / 12) * (drumBand - 4) + 2;
          ctx.fillRect(x0, y, Math.max(2 * dpr, 3), 3 * dpr);
        } else {
          const y = yOf(n.key) - noteH / 2;
          ctx.fillRect(x0, y, Math.max(2 * dpr, x1 - x0 - dpr), noteH);
          if (sounding) {
            ctx.globalAlpha = 0.25;
            ctx.fillRect(x0 - dpr, y - dpr, Math.max(2 * dpr, x1 - x0) + 2 * dpr, noteH + 2 * dpr);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.playheadColor;
    ctx.fillRect(Math.round(playX), 0, Math.max(1, dpr), h);
  }
}
