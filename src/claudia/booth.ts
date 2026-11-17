/**
 * The booth cam: Claudia at the decks, in time with the set. Plays the
 * director's clips on two muted video layers, driven by the Player's audio
 * clock: each animation frame, the clip on screen is where the bar says it
 * should be, by nudging its playback rate (seeking only when it is far off),
 * and the next clip fades in over the pose frame they share.
 *
 * Bars are counted here as they become audible. A bar that does not follow
 * the last one (a seek, a new set) starts the plan again at Home.
 */
import type { Player, TimedBar } from "../app/player.js";
import { type ClipSet, Director, type PlanSource, type Placement, RollingPlan, type TrackFacts, cuesFor, factsOf, trackFacts } from "./director.js";

/** Seek when the picture is this many frames off; closer than that, bend the rate. */
const SEEK_FRAMES = 2;
/** Most the rate is bent to catch up, either way. */
const BEND = 0.03;
/** Rate bend per second of drift. */
const BEND_GAIN = 0.5;

interface Slot {
  video: HTMLVideoElement;
  placement: Placement | null;
  file: string;
}

export interface BoothStats {
  /** Presented frames measured. */
  frames: number;
  /** Mean and worst absolute drift of the presented frame against the audio clock, in video frames. */
  meanDrift: number;
  maxDrift: number;
  /** Mean signed drift: positive is the picture ahead of the sound. */
  bias: number;
  seeks: number;
  joins: number;
}

export class BoothCam {
  private readonly el: HTMLElement;
  private readonly player: Player;
  private readonly set: ClipSet;
  private readonly base: URL;
  private readonly slots: [Slot, Slot];
  private readonly still: HTMLImageElement;
  private director: Director;
  private plan: RollingPlan;
  private enabled = true;
  private readonly reduced: MediaQueryList;
  /** The last audible bar and its number in our count. */
  private bar: { tb: TimedBar; n: number } | null = null;
  private front: Placement | null = null;
  private drift = { n: 0, sum: 0, abs: 0, max: 0, seeks: 0, joins: 0 };

  constructor(el: HTMLElement, player: Player, set: ClipSet, base: URL) {
    this.el = el;
    this.player = player;
    this.set = set;
    this.base = base;
    this.director = new Director(set, player.seed);
    this.plan = new RollingPlan(this.director);
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.still = document.createElement("img");
    this.still.className = "still";
    this.still.alt = "";
    const home = set.stills.home;
    if (home) this.still.src = new URL(home, base).href;
    const make = (): Slot => {
      const video = document.createElement("video");
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("muted", "");
      video.preload = "auto";
      video.disablePictureInPicture = true;
      video.setAttribute("aria-hidden", "true");
      return { video, placement: null, file: "" };
    };
    this.slots = [make(), make()];
    el.append(this.still, this.slots[0].video, this.slots[1].video);
    this.preloadAll();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) for (const s of this.slots) s.video.pause();
    });
    const tick = () => {
      requestAnimationFrame(tick);
      this.tick();
    };
    requestAnimationFrame(tick);
    this.measure();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.el.classList.toggle("off", !on);
  }

  get stats(): BoothStats {
    const d = this.drift;
    return { frames: d.n, meanDrift: d.n ? d.abs / d.n : 0, maxDrift: d.max, bias: d.n ? d.sum / d.n : 0, seeks: d.seeks, joins: d.joins };
  }

  resetStats(): void {
    this.drift = { n: 0, sum: 0, abs: 0, max: 0, seeks: 0, joins: 0 };
  }

  /** The plan from here on, for inspection. */
  get upcoming(): { bar: number; id: string }[] {
    return this.plan.placements.map((p) => ({ bar: p.bar, id: p.clip.id }));
  }

  /** Fetch every clip once so joins never wait on the network (a few MB for the prototype's set). */
  private preloadAll(): void {
    const files = [...new Set(this.set.clips.map((c) => c.file))];
    for (const f of files) void fetch(new URL(f, this.base)).then((r) => r.blob()).catch(() => undefined);
  }

  private showStill(on: boolean): void {
    this.el.classList.toggle("still-only", on);
    if (on) for (const s of this.slots) s.video.pause();
  }

  /** Our number for the audible bar, counting on from the last one when it follows it. */
  private count(tb: TimedBar): number {
    const last = this.bar;
    if (last && last.tb === tb) return last.n;
    if (this.player.seed !== this.director.seed) {
      this.director = new Director(this.set, this.player.seed);
      this.plan = new RollingPlan(this.director);
    }
    const follows = last && Math.abs(tb.start - last.tb.end) < 0.03 && tb.start > last.tb.start;
    const n = last ? last.n + 1 : 0;
    if (!follows) this.plan.reset();
    this.bar = { tb, n };
    const info = tb.bar.info;
    const track = this.facts(info.pieceIndex) ?? factsOf(info, this.player.layout(info.pieceIndex));
    const next = track.out ? this.facts(info.pieceIndex + 1) : null;
    this.plan.advance(n, cuesFor(info.barInPiece, tb.bar.bpm, track, next));
    return n;
  }

  /** A track's facts from the set's plans, where the bar source is a set conductor. */
  private facts(i: number): TrackFacts | null {
    const src = this.player.barSource as Partial<PlanSource>;
    return src.trackPiece && src.transitionPlan ? trackFacts(src as PlanSource, i) : null;
  }

  /**
   * The frame placement `p` should show at bar position `x`: frame 0 on its
   * first bar line, so the next clip's first frame lands where this one's
   * closing pose frame would be. (Shifting each clip to its measured beat
   * phase froze or overlapped joins by up to 7 frames, for beat estimates
   * barely above noise: Grok does not know the tempo.)
   */
  private frameOf(p: Placement, x: number): number {
    return (x - p.bar) * (p.clip.frames / p.clip.bars);
  }

  private tick(): void {
    const player = this.player;
    if (!this.enabled || this.reduced.matches || !player.started) return this.showStill(true);
    const tb = player.current();
    if (!tb || tb.bar.info.gap) {
      if (!player.playing) for (const s of this.slots) s.video.pause();
      return;
    }
    const n = this.count(tb);
    const barSeconds = tb.end - tb.start;
    const x = n + Math.min(1, Math.max(0, (player.now - tb.start) / barSeconds));
    const cur = this.plan.at(n);
    if (!cur) return this.showStill(true);
    const next = this.plan.after(cur);
    const prev = this.plan.placements[this.plan.placements.indexOf(cur) - 1];
    // The front clip is the latest one that has begun.
    let front = cur;
    if (next && this.frameOf(next, x) >= 0) front = next;
    else if (this.frameOf(cur, x) < 0 && prev) front = prev;
    const behind = front === next ? cur : front === cur ? prev : undefined;
    const fadeIn = this.frameOf(front, x) / Math.max(1, front.clip.fadeFrames);
    const fading = behind && fadeIn < 1 && this.front !== null;
    if (front !== this.front) {
      if (this.front) this.drift.joins++;
      this.front = front;
    }
    const upNext = front === cur ? next : this.plan.after(front);

    const fs = this.slotFor(front, fading ? behind : upNext);
    const other = this.slots[0] === fs ? this.slots[1] : this.slots[0];
    if (fading && behind) this.load(other, behind);
    else if (upNext) this.load(other, upNext);

    this.showStill(false);
    fs.video.style.zIndex = "2";
    other.video.style.zIndex = "1";
    fs.video.style.opacity = String(fading ? Math.max(0, Math.min(1, fadeIn)) : 1);
    other.video.style.opacity = fading ? "1" : "0";

    const playing = player.playing && !document.hidden;
    this.sync(fs, x, barSeconds, playing, true);
    if (fading && behind) this.sync(other, x, barSeconds, playing, false);
    else {
      other.video.pause();
      // Waiting for its turn on its first frame.
      if (other.placement && other.video.readyState >= 1 && other.video.currentTime > 0.01 && !other.video.seeking) other.video.currentTime = 0;
    }
  }

  /** The slot holding `p`, or a free one (not the one holding `keep`) loaded with it. */
  private slotFor(p: Placement, keep: Placement | undefined): Slot {
    const has = this.slots.find((s) => s.placement === p);
    if (has) return has;
    const free = this.slots.find((s) => s.placement !== keep) ?? this.slots[0];
    this.load(free, p);
    return free;
  }

  private load(s: Slot, p: Placement): void {
    if (s.placement === p) return;
    s.placement = p;
    if (s.file !== p.clip.file) {
      s.file = p.clip.file;
      s.video.src = new URL(p.clip.file, this.base).href;
    } else if (s.video.readyState >= 1) s.video.currentTime = 0;
  }

  private sync(s: Slot, x: number, barSeconds: number, playing: boolean, measure: boolean): void {
    const p = s.placement!;
    const v = s.video;
    const fps = this.set.fps;
    const frame = this.frameOf(p, x);
    const lastFrame = p.clip.frames - 1;
    const target = Math.max(0, Math.min(lastFrame, frame)) / fps;
    const rate = p.clip.frames / p.clip.bars / fps / barSeconds;
    if (v.readyState < 1) return;
    if (!playing || frame >= lastFrame) {
      v.pause();
      if (Math.abs(v.currentTime - target) > 0.5 / fps && !v.seeking) v.currentTime = target;
      return;
    }
    const drift = target - v.currentTime;
    if (Math.abs(drift) > SEEK_FRAMES / fps) {
      if (!v.seeking) {
        // Land a little ahead: the seek takes a moment.
        v.currentTime = Math.min(lastFrame / fps, target + 0.05 * rate);
        if (measure) this.drift.seeks++;
      }
    } else {
      const bend = Math.max(-BEND, Math.min(BEND, drift * BEND_GAIN));
      const r = Math.round(rate * (1 + bend) * 1000) / 1000;
      if (Math.abs(v.playbackRate - r) > 0.0015) v.playbackRate = r;
    }
    if (v.paused) void v.play().catch(() => undefined);
  }

  /** Drift of what is actually on screen, from each presented video frame, where the browser reports them. */
  private measure(): void {
    for (const s of this.slots) {
      const v = s.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; expectedDisplayTime: number }) => void) => number };
      if (!v.requestVideoFrameCallback) return;
      const onFrame = (_now: number, meta: { mediaTime: number; expectedDisplayTime: number }) => {
        v.requestVideoFrameCallback!(onFrame);
        const b = this.bar;
        const p = s.placement;
        if (!b || !p || p !== this.front || !this.player.playing || Number(v.style.opacity) < 1) return;
        // Where the music will be when this frame shows.
        const shown = this.player.now + (meta.expectedDisplayTime - performance.now()) / 1000;
        const barSeconds = b.tb.end - b.tb.start;
        const x = b.n + (shown - b.tb.start) / barSeconds;
        const want = this.frameOf(p, x);
        if (want < 1 || want > p.clip.frames - 2) return;
        const d = meta.mediaTime * this.set.fps - want;
        const dd = this.drift;
        dd.n++;
        dd.sum += d;
        dd.abs += Math.abs(d);
        dd.max = Math.max(dd.max, Math.abs(d));
      };
      v.requestVideoFrameCallback(onFrame);
    }
  }
}
