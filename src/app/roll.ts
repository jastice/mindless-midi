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
/** Past 2x the extra pixels cost fill rate on phones and are invisible on ink and thin lines. */
const MAX_DPR = 2;
/** How strongly each part is inked; the lead is the only one in the spot colour. */
const WEIGHT: Record<Role, number> = { lead: 1, counter: 0.85, arp: 0.7, pad: 0.5, comp: 0.6, bass: 0.95, drums: 0.7 };
/** Staff lines as MIDI keys: treble E4 to F5, bass G2 to A3. */
const STAVES = [[64, 67, 71, 74, 77], [43, 47, 50, 53, 57]];

/** `?perf` turns the readout on (and keeps it on for this tab, since the app rewrites the URL); `?perf=0` turns it off. */
function perfRequested(): boolean {
  const asked = new URLSearchParams(location.search).get("perf");
  try {
    if (asked === "0") sessionStorage.removeItem("perf");
    else if (asked !== null) sessionStorage.setItem("perf", "1");
    return sessionStorage.getItem("perf") === "1";
  } catch {
    return asked !== null && asked !== "0";
  }
}

/**
 * `?perf` on the URL shows a readout over the score for judging smoothness on a real device:
 * frame pacing, how steadily the music clock advances against the page clock, and what drawing costs.
 */
class Probe {
  private readonly el = Object.assign(document.createElement("pre"), { className: "perf" });
  private frames: number[] = [];
  private speeds: number[] = [];
  private draws: number[] = [];
  private lastFrame = 0;
  private lastNow = NaN;
  private shownAt = 0;
  private reported = 0;

  constructor(private readonly player: Player) {
    this.el.style.cssText = "position:fixed;left:6px;bottom:6px;z-index:99;margin:0;padding:6px 8px;font:11px/1.35 ui-monospace,monospace;background:#000c;color:#9f9;pointer-events:none;white-space:pre";
    document.body.append(this.el);
  }

  /** Send a second's summary to the dev server's log (it has no endpoint on the deployed site; the failure is ignored). */
  private report(row: object): void {
    const first = !this.reported++;
    const body = JSON.stringify(first ? { ...row, ua: navigator.userAgent, screen: [screen.width, screen.height] } : row);
    try {
      navigator.sendBeacon("/__perf", body);
    } catch {
      // Not worth a second thought.
    }
  }

  frame(t: number, now: number, drawMs: number): void {
    if (this.lastFrame) {
      const wall = t - this.lastFrame;
      this.frames.push(wall);
      if (this.player.playing && !Number.isNaN(this.lastNow)) this.speeds.push((now - this.lastNow) / (wall / 1000));
    }
    this.lastFrame = t;
    this.lastNow = now;
    this.draws.push(drawMs);
    if (t - this.shownAt < 1000) return;
    this.shownAt = t;
    const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
    const f = (n: number, d = 1) => n.toFixed(d);
    const slow = this.frames.filter((g) => g > 25).length;
    const row = {
      at: new Date().toISOString().slice(11, 23),
      playing: this.player.playing,
      fps: this.frames.length,
      gap: { p50: q(this.frames, 0.5), p95: q(this.frames, 0.95), max: q(this.frames, 1) },
      late: slow,
      speed: { p5: q(this.speeds, 0.05), p50: q(this.speeds, 0.5), p95: q(this.speeds, 0.95) },
      draw: { p50: q(this.draws, 0.5), max: q(this.draws, 1) },
      dpr: devicePixelRatio,
      latencyMs: (this.player.latency ?? 0) * 1000,
    };
    this.el.textContent = [
      `frames  ${row.fps}/s  gap p50 ${f(row.gap.p50)} p95 ${f(row.gap.p95)} max ${f(row.gap.max)} ms`,
      `late    ${slow} frames over 25 ms`,
      `clock   speed p5 ${f(row.speed.p5, 2)} p50 ${f(row.speed.p50, 2)} p95 ${f(row.speed.p95, 2)}  (1.00 is steady)`,
      `draw    p50 ${f(row.draw.p50, 2)} max ${f(row.draw.max, 2)} ms`,
      `dpr ${row.dpr} (drawn at ${Math.min(row.dpr, MAX_DPR)})  latency ${f(row.latencyMs, 0)} ms`,
    ].join("\n");
    this.report(row);
    this.frames = [];
    this.speeds = [];
    this.draws = [];
  }
}

export class Roll {
  private readonly ctx: CanvasRenderingContext2D;
  private ink = "";
  private spot = "";
  private rule = "";
  private raf = 0;
  private readonly probe: Probe | null;
  /** CSS size, kept by a ResizeObserver: reading clientWidth every frame forces a layout. */
  private cssW = 0;
  private cssH = 0;
  /** What was last drawn, so a paused roll costs nothing. */
  private drawn = { now: NaN, started: false, w: 0, h: 0, theme: 0 };
  private theme = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly player: Player,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.probe = perfRequested() ? new Probe(player) : null;
    this.readTheme();
    this.cssW = canvas.clientWidth;
    this.cssH = canvas.clientHeight;
    // A jump while paused rearranges the timeline without moving the clock.
    player.onChange(() => (this.drawn.now = NaN));
    new ResizeObserver(() => {
      this.cssW = canvas.clientWidth;
      this.cssH = canvas.clientHeight;
    }).observe(canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.readTheme());
  }

  /** Re-read the page colours; call after the theme (engine edition) changes. */
  readTheme(): void {
    const css = getComputedStyle(document.documentElement);
    this.ink = css.getPropertyValue("--ink").trim() || "#222";
    this.spot = css.getPropertyValue("--spot").trim() || "#d33";
    this.rule = css.getPropertyValue("--rule").trim() || "#8884";
    this.theme++;
  }

  start(): void {
    const frame = (t: number) => {
      const began = performance.now();
      this.draw();
      this.probe?.frame(t, this.drawn.now, performance.now() - began);
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
    const started = this.player.started;
    const now = started ? this.player.now : 0;
    const d = this.drawn;
    if (d.now === now && d.started === started && d.w === w && d.h === h && d.theme === this.theme) return;
    this.drawn = { now, started, w, h, theme: this.theme };
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
    if (!started) return;

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
