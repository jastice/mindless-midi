/**
 * The stage: the score as blocks of light. Notes come in from the right and
 * cross the playhead; a block's brightness is its velocity and its colour its
 * part. What the plain note list doesn't say is drawn too: a slide leans into
 * its note, a swell opens like a wedge, an accent gets a cap, a choked hat a
 * stop, and every kick thumps the floor.
 */
import type { Player } from "../app/player.js";
import type { Role } from "../corpus/constants.js";
import { curveAt } from "../engine/gestures.js";

const PAST = 5;
const FUTURE = 2.6;
const LOW = 28;
const HIGH = 100;
const MAX_DPR = 2;

const COLOR: Record<Role, string> = {
  lead: "#d6ff3f",
  counter: "#7fe3ff",
  arp: "#b9a2ff",
  pad: "#5f73ff",
  comp: "#ffd166",
  bass: "#ff8a3d",
  drums: "#f2efe9",
};
const KICK = "#ff5b2e";

export class Stage {
  private readonly ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private raf = 0;
  private drawn = { now: NaN, w: 0, h: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly player: Player,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.cssW = canvas.clientWidth;
    this.cssH = canvas.clientHeight;
    player.onChange(() => (this.drawn.now = NaN));
    new ResizeObserver(() => {
      this.cssW = canvas.clientWidth;
      this.cssH = canvas.clientHeight;
    }).observe(canvas);
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
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.round(this.cssW * dpr);
    const h = Math.round(this.cssH * dpr);
    const now = this.player.started ? this.player.now : 0;
    if (this.drawn.now === now && this.drawn.w === w && this.drawn.h === h) return;
    this.drawn = { now, w, h };
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);

    const floor = h * 0.2;
    const top = h - floor;
    const rowH = top / (HIGH - LOW);
    const noteH = Math.max(3 * dpr, rowH * 2.2);
    const yOf = (key: number) => top * (1 - (Math.min(HIGH, Math.max(LOW, key)) - LOW) / (HIGH - LOW)) - noteH / 2;
    const playX = Math.round(w * (PAST / (PAST + FUTURE)));
    const pxPerSec = w / (PAST + FUTURE);
    const xOf = (t: number) => playX + (t - now) * pxPerSec;

    // Octave lines and the floor the drums stand on.
    ctx.fillStyle = "rgba(242, 239, 233, 0.06)";
    for (let key = 36; key <= 96; key += 12) ctx.fillRect(0, Math.round(yOf(key) + noteH / 2), w, Math.max(1, dpr));
    ctx.fillStyle = "rgba(242, 239, 233, 0.14)";
    ctx.fillRect(0, Math.round(top), w, Math.max(1, dpr));
    if (!this.player.started) return;

    const bars = this.player.window(now - PAST, now + FUTURE);
    // Bar lines, and how hard each section leans in as a strip along the top.
    for (const tb of bars) {
      const x = Math.round(xOf(tb.start));
      ctx.fillStyle = "rgba(242, 239, 233, 0.1)";
      ctx.fillRect(x, 0, Math.max(1, dpr), h);
      if (!tb.bar.info.gap) {
        ctx.fillStyle = `rgba(214, 255, 63, ${0.15 + 0.6 * tb.bar.info.intensity})`;
        ctx.fillRect(x, 0, Math.max(1, xOf(tb.end) - xOf(tb.start) - dpr), Math.max(2, 3 * dpr * (0.4 + tb.bar.info.intensity)));
      }
    }

    let thump = 0;
    for (const tb of bars) {
      const spb = 60 / tb.bar.bpm;
      for (const n of tb.bar.notes) {
        const t0 = tb.start + n.beat * spb;
        const t1 = t0 + n.dur * spb;
        if (t1 < now - PAST || t0 > now + FUTURE) continue;
        const x0 = xOf(t0);
        const x1 = Math.max(x0 + 2 * dpr, xOf(t1) - dpr);
        const vel = n.vel / 127;
        const sounding = t0 <= now && now < t1;
        const heard = t0 <= now;
        const fade = heard && !sounding ? Math.max(0.25, 1 - (now - t1) / PAST) : 1;
        ctx.globalAlpha = (heard ? 0.35 + 0.65 * vel : 0.18 + 0.4 * vel) * fade;

        if (n.role === "drums") {
          const kick = n.key === 35 || n.key === 36;
          if (kick) {
            const since = now - t0;
            if (since >= 0) thump = Math.max(thump, vel * Math.exp(-since / 0.12));
            ctx.fillStyle = KICK;
            const kh = floor * (0.3 + 0.6 * vel);
            ctx.fillRect(x0, h - kh, Math.max(3 * dpr, pxPerSec * 0.05), kh);
            if (n.gesture === "accent") ctx.fillRect(x0 - 2 * dpr, h - kh - 3 * dpr, Math.max(3 * dpr, pxPerSec * 0.05) + 4 * dpr, 2 * dpr);
          } else {
            // Snares and claps mid-floor, metal at its top edge.
            const metal = n.key >= 42 && n.key !== 45 && n.key !== 47 && n.key !== 48 && n.key !== 50;
            const y = metal ? top + floor * 0.12 : top + floor * 0.42;
            const dh = floor * (metal ? 0.1 + 0.12 * vel : 0.16 + 0.22 * vel);
            ctx.fillStyle = COLOR.drums;
            ctx.fillRect(x0, y, n.gesture === "choke" ? Math.max(2 * dpr, x1 - x0) : Math.max(2 * dpr, pxPerSec * 0.025), dh);
            if (n.gesture === "choke") ctx.fillRect(x1, y - 2 * dpr, Math.max(1, dpr), dh + 4 * dpr);
          }
          continue;
        }

        const y = yOf(n.key);
        ctx.fillStyle = ctx.strokeStyle = COLOR[n.role];
        const level = n.curve?.level;
        if (level) {
          // A swell: the block opens from thin to full height along its curve.
          const len = level[level.length - 1]![0] * spb;
          const xm = Math.min(x1, xOf(t0 + len));
          const thin = noteH * curveAt(level, 0) ** 2;
          ctx.beginPath();
          ctx.moveTo(x0, y + noteH / 2 - thin / 2);
          ctx.lineTo(xm, y);
          ctx.lineTo(x1, y);
          ctx.lineTo(x1, y + noteH);
          ctx.lineTo(xm, y + noteH);
          ctx.lineTo(x0, y + noteH / 2 + thin / 2);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(x0, y, x1 - x0, noteH);
        }
        const bend = n.curve?.bend;
        if (bend) {
          // A slide: a line from where the pitch starts into the block.
          const len = bend[bend.length - 1]![0] * spb;
          ctx.lineWidth = Math.max(1.5, 2 * dpr);
          ctx.beginPath();
          ctx.moveTo(x0, y + noteH / 2 - curveAt(bend, 0) * rowH * 2.5);
          ctx.lineTo(Math.min(x1, xOf(t0 + len)), y + noteH / 2);
          ctx.stroke();
        }
        if (n.gesture === "accent") ctx.fillRect(x0, y - 3 * dpr, Math.max(3 * dpr, Math.min(x1 - x0, 8 * dpr)), 2 * dpr);
        if (sounding) {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(playX - dpr, y, 3 * dpr, noteH);
        }
      }
    }

    // The playhead, and the floor lighting up under each kick.
    ctx.globalAlpha = 1;
    if (thump > 0.01) {
      const glow = ctx.createLinearGradient(0, top, 0, h);
      glow.addColorStop(0, "rgba(255, 91, 46, 0)");
      glow.addColorStop(1, `rgba(255, 91, 46, ${0.5 * thump})`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, top, w, floor);
    }
    ctx.fillStyle = "#f2efe9";
    ctx.fillRect(playX, 0, Math.max(2, 1.5 * dpr), h);
  }
}
