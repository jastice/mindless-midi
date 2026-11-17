/**
 * DJ Claudia: an endless, seeded DJ set. One track after another, each in a
 * compatible key and within a few percent of the last tempo, mixed into the
 * next on two decks. The set conductor makes the bars; the shared Player
 * plays them for weight, with the Synth or Samples engine.
 *
 * The page is the booth cam with a HUD on it: the tracklist (titles from each
 * style's name theme), the two decks with a lane of the next phrases, and the
 * transport. The set's name, its styles and the credits sit under the video.
 */
import { mediaAnchor } from "../app/media_anchor.js";
import { EXPRESSION, type Engine, Player, type Position, type TimedBar } from "../app/player.js";
import { trackName } from "../corpus/names.js";
import type { StyleBundle } from "../corpus/schema.js";
import { BLEND_BARS, DEFAULT_SET_OPTIONS, PHRASE_BARS, SetConductor } from "../engine/set.js";
import { type Bar, type BarInfo, type TransitionType, barSeconds } from "../engine/types.js";
import { BoothCam } from "./booth.js";
import type { ClipSet } from "./director.js";
import { type DeckLane, LANE_PHRASES, type Lanes, type Seg, deckLanes } from "./lanes.js";
import { setName } from "./set_name.js";

const ENGINES: { id: Engine; label: string }[] = [
  { id: "synth", label: "Synth" },
  { id: "samples", label: "Samples" },
];
const MIX_LABEL: Record<TransitionType, string> = { blend: "Blend", filter: "Filter", cut: "Cut", breakdown: "Breakdown" };
const DECK_LETTER = ["A", "B"] as const;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`dj-claudia:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`dj-claudia:${key}`, value);
    } catch {
      /* private mode etc. */
    }
  },
};

/** A place in the set as track.bar, 1-based. */
const formatAt = (p: Position) => `${p.piece + 1}.${p.bar + 1}`;

function parseAt(s: string | null): Position | undefined {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(s ?? "");
  if (!m) return undefined;
  const piece = Number(m[1]) - 1;
  const bar = Number(m[2] ?? 1) - 1;
  return piece >= 0 && bar >= 0 ? { piece, bar } : undefined;
}

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
const no = (piece: number) => String(piece + 1).padStart(2, "0");

/** "A", "A and B", "A, B and C". */
const andList = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function toast(text: string): void {
  const t = el("div", "toast", text);
  t.setAttribute("role", "status");
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

/** A lane segment's look: violet for the deck playing now (or going out), white for the one coming in. */
function paintSeg(i: HTMLElement, seg: Seg, later: boolean): void {
  const rgb = later ? "237,237,239" : "176,140,255";
  i.className = seg.state === "idle" ? "idle" : seg.state;
  const alpha = seg.state === "on" ? (later ? 0.85 : 1) : seg.state === "out" ? 0.1 + 0.6 * (1 - seg.level) : seg.state === "in" ? 0.2 + 0.6 * seg.level : 0;
  i.style.background = seg.state === "idle" ? "" : `rgba(${rgb},${alpha.toFixed(2)})`;
}

/** A lane in words, for screen readers: "Deck A: plays 2 phrases, then goes out over 2". */
function laneWords(d: DeckLane): string {
  const WORD: Record<Seg["state"], string> = { on: "plays", out: "goes out over", in: "comes in over", idle: "idle for" };
  const runs: [Seg["state"], number][] = [];
  for (const s of d.segs) {
    const last = runs[runs.length - 1];
    if (last && last[0] === s.state) last[1]++;
    else runs.push([s.state, 1]);
  }
  return `Deck ${DECK_LETTER[d.deck]}, next ${d.segs.length} phrases: ${runs.map(([s, n], k) => `${WORD[s]} ${n}${k ? "" : ` phrase${n === 1 ? "" : "s"}`}`).join(", then ")}`;
}

/** A track heard in this session, and where in the set it began (seconds of set time). */
interface Heard {
  piece: number;
  styleId: string;
  styleTitle: string;
  at: number;
}

async function main(): Promise<void> {
  const res = await fetch(new URL("styles.json", document.baseURI));
  const { styles } = (await res.json()) as { styles: StyleBundle[] };
  const styleById = new Map(styles.map((s) => [s.id, s]));
  const allIds = styles.map((s) => s.id);

  // The URL is the session (seed, place, sound, styles); a bare visit resumes the last one.
  const params = new URLSearchParams(location.search);
  const linked = params.get("seed");
  const savedSeed = linked ? null : store.get("seed");
  const seed = linked || savedSeed || setName();
  const at = parseAt(linked ? params.get("at") : savedSeed ? store.get("at") : null);
  const volume = Number(store.get("volume") ?? "0.8");
  const wantedEngine = params.get("sound") ?? store.get("sound") ?? "synth";
  const engine: Engine = ENGINES.some((e) => e.id === wantedEngine) ? (wantedEngine as Engine) : "synth";
  const parseStyles = (s: string | null) => {
    const want = (s ?? "").split(",").filter((id) => allIds.includes(id));
    return want.length ? allIds.filter((id) => want.includes(id)) : null;
  };
  // A link without `styles` is a set from all of them.
  let chosen: string[] = parseStyles(linked ? params.get("styles") : store.get("styles")) ?? allIds;
  const pool = () => styles.filter((s) => chosen.includes(s.id));

  // The set conductor the player plays from, for the set's plans.
  let conductor: SetConductor | null = null;
  const player = new Player(pool(), {
    source: (p, s, pieces) => (conductor = new SetConductor(p, s, { ...pieces, ...DEFAULT_SET_OPTIONS })),
    seed,
    ...(at && { at }),
    engine,
    stemWorkletUrl: new URL("stem-worklet.js", import.meta.url).href,
    workerUrl: new URL("render-worker.js", import.meta.url).href,
    expression: EXPRESSION,
    weighted: true,
    decks: true,
  });
  player.setVolume(volume);
  const titleOf = (piece: number, styleId: string) => {
    const style = styleById.get(styleId);
    return style ? trackName(style, player.seed, piece) : `Track ${piece + 1}`;
  };

  // --- Booth cam ----------------------------------------------------------
  // Clips ship with the site at clips/ (bazel run //tools/clips:prep); ?clips= points elsewhere.
  const clipBase = new URL(params.get("clips") ?? "clips/", document.baseURI);
  let booth: BoothCam | null = null;
  try {
    const set = (await (await fetch(new URL("clips.json", document.baseURI))).json()) as ClipSet;
    // Only where the clips are served: the still answering is the sign.
    const still = set.stills.home;
    const served = still ? (await fetch(new URL(still, clipBase), { method: "HEAD" })).ok : false;
    if (set.clips.length && served) booth = new BoothCam($("cam"), player, set, clipBase);
  } catch (err) {
    console.warn("booth cam unavailable", err);
  }
  const camToggle = $<HTMLButtonElement>("cam-toggle");
  camToggle.hidden = !booth;
  function renderCam(on: boolean): void {
    booth?.setEnabled(on);
    camToggle.setAttribute("aria-pressed", String(on));
    camToggle.querySelector(".cam-label")!.textContent = on ? "Cam on" : "Cam off";
  }
  let camOn = store.get("booth") !== "off";
  renderCam(camOn);
  camToggle.addEventListener("click", () => {
    camOn = !camOn;
    store.set("booth", camOn ? "on" : "off");
    renderCam(camOn);
  });
  Object.assign(window, { djClaudia: { player, styles, booth, conductor: () => conductor } });

  // --- Sound --------------------------------------------------------------
  const chipFor = new Map<Engine, HTMLButtonElement>();
  for (const e of ENGINES) {
    const chip = el("button", "engine");
    chip.type = "button";
    chip.setAttribute("role", "radio");
    chip.append(el("span", "nm", e.label), el("span", "fill"));
    chip.querySelector(".fill")!.setAttribute("aria-hidden", "true");
    chip.addEventListener("click", () => {
      void player.setEngine(e.id);
      persist();
    });
    chipFor.set(e.id, chip);
    $("engines").append(chip);
  }
  let creditCount = -1;
  function renderEngine(): void {
    const pending = player.pendingEngine;
    const shown = player.audibleEngine;
    const progress = player.loadProgress;
    const loading = pending ?? (progress !== null ? shown : null);
    for (const [id, chip] of chipFor) {
      chip.setAttribute("aria-checked", String(id === shown));
      chip.classList.toggle("pending", id === pending);
      const filling = id === loading && progress !== null;
      chip.style.setProperty("--progress", filling ? String(progress) : "0");
      if (filling) chip.setAttribute("aria-label", `${ENGINES.find((x) => x.id === id)!.label}, loading ${Math.round(progress * 100)}%`);
      else chip.removeAttribute("aria-label");
      chip.tabIndex = id === shown ? 0 : -1;
    }
    // Samples heard so far, each linked to where its licence was read.
    const credits = player.sampleCreditEntries;
    if (credits.length === creditCount) return;
    creditCount = credits.length;
    const p = $("credit-samples");
    p.hidden = !credits.length;
    p.replaceChildren("Samples heard so far: ");
    credits.forEach((c, k) => {
      const a = el("a", undefined, c.name);
      a.href = c.source;
      p.append(...(k ? [", "] : []), a, ` (${c.licence})`);
    });
    p.append(".");
  }
  $("engines").addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    ev.preventDefault();
    const i = ENGINES.findIndex((x) => x.id === player.engine);
    const next = ENGINES[(i + 1) % ENGINES.length]!;
    void player.setEngine(next.id);
    chipFor.get(next.id)?.focus();
    persist();
  });

  // --- Credits: who wrote the styles, from their own data ---------------------
  {
    const byAuthors = new Map<string, { authors: string[]; titles: string[] }>();
    for (const s of styles) {
      const authors = s.corpus.authors;
      if (!authors?.length) continue;
      const key = authors.join("\n");
      const g = byAuthors.get(key) ?? { authors, titles: [] };
      g.titles.push(s.corpus.title);
      byAuthors.set(key, g);
    }
    const groups = [...byAuthors.values()];
    if (groups.length) {
      const claude = groups.every((g) => g.authors.every((a) => a.startsWith("Claude ")));
      $("credit-styles").textContent =
        `Every track is composed in this tab as it plays. The styles it draws on were written by ${claude ? "Claude" : "their authors"}: ` +
        `${groups.map((g) => `${andList(g.titles)} by ${andList(g.authors)}`).join(", ")}.`;
    }
  }

  // --- Styles -------------------------------------------------------------
  const styleBtns = new Map<string, HTMLButtonElement>();
  for (const s of styles) {
    const b = el("button", "style-btn");
    b.type = "button";
    b.append(el("span", "box"), s.corpus.title);
    b.querySelector(".box")!.setAttribute("aria-hidden", "true");
    b.addEventListener("click", () => {
      const on = chosen.includes(s.id);
      if (on && chosen.length === 1) return toast("At least one style stays on");
      chosen = on ? chosen.filter((id) => id !== s.id) : allIds.filter((id) => id === s.id || chosen.includes(id));
      store.set("styles", chosen.join(","));
      player.setStyles(pool(), { fromNext: true });
      renderStyles();
      persist();
      lastKey = "";
    });
    styleBtns.set(s.id, b);
    $("styles").append(b);
  }
  function renderStyles(): void {
    for (const [id, b] of styleBtns) {
      const on = chosen.includes(id);
      b.setAttribute("aria-pressed", String(on));
      const last = on && chosen.length === 1;
      b.classList.toggle("last", last);
      b.title = last ? "At least one style stays on" : "";
    }
  }
  renderStyles();

  // --- Session ------------------------------------------------------------
  const seedInput = $<HTMLInputElement>("seed");
  function shareUrl(): string {
    const u = new URL(location.href);
    u.search = "";
    u.searchParams.set("seed", player.seed);
    const here = player.position();
    if (here.piece || here.bar) u.searchParams.set("at", formatAt(here));
    if (player.engine !== "synth") u.searchParams.set("sound", player.engine);
    if (chosen.length < allIds.length) u.searchParams.set("styles", chosen.join(","));
    return u.href;
  }
  function persist(): void {
    store.set("sound", player.engine);
    store.set("styles", chosen.join(","));
    if (player.started) {
      store.set("seed", player.seed);
      store.set("at", formatAt(player.position()));
    }
    history.replaceState(null, "", shareUrl());
  }
  persist();
  addEventListener("pagehide", persist);
  seedInput.value = seed;
  $("set-tag").textContent = seed;
  $("share").addEventListener("click", () => {
    navigator.clipboard?.writeText(shareUrl()).then(
      () => toast("Link copied: same set, same bar"),
      () => toast(shareUrl()),
    );
  });
  function newSet(s: string): void {
    player.reseed(s);
    seedInput.value = player.seed;
    $("set-tag").textContent = player.seed;
    heard.length = 0;
    setClock = null;
    after();
  }
  $("reseed").addEventListener("click", () => {
    newSet(setName());
    toast(`New set: ${player.seed}`);
  });
  seedInput.addEventListener("change", () => {
    const s = seedInput.value.trim();
    if (s && s !== player.seed) newSet(s);
    else seedInput.value = player.seed;
  });

  // --- Transport ----------------------------------------------------------
  const playBtn = $<HTMLButtonElement>("play");
  const holdMedia = mediaAnchor();
  async function toggle(): Promise<void> {
    if (!player.playing) holdMedia(true); // inside the click, before any await
    try {
      await player.toggle();
    } catch (err) {
      console.error(err);
      toast(`Could not start audio: ${(err as Error).message}`);
    }
    render();
  }
  playBtn.addEventListener("click", toggle);
  function after(): void {
    lastKey = "";
    describe();
    renderSkip();
    persist();
  }
  function skip(): void {
    player.nextPieceOnPhrase(PHRASE_BARS);
    after();
  }
  $("skip").addEventListener("click", skip);
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.repeat || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") {
      if (e.target instanceof HTMLButtonElement) return; // the button's own click
      e.preventDefault();
      void toggle();
    } else if (e.key === "n" || e.key === "N") skip();
  });
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => void player.play());
    navigator.mediaSession.setActionHandler("pause", () => void player.pause());
    navigator.mediaSession.setActionHandler("nexttrack", skip);
  }
  function renderSkip(): void {
    const s = player.skipping;
    const btn = $("skip");
    btn.classList.toggle("armed", s !== null);
    btn.title = s ? "Go to the next track now (N)" : "Next track, on the next phrase (N)";
  }

  // --- The decks ----------------------------------------------------------
  const deckRows = ([0, 1] as const).map((d) => {
    const row = $(`deck-${d}`);
    const badge = el("span", "badge", DECK_LETTER[d]);
    badge.setAttribute("aria-label", `Deck ${DECK_LETTER[d]}`);
    const info = el("div", "dk-info");
    const style = el("span", "dk-style");
    const status = el("span", "dk-status");
    info.append(style, status);
    const lane = el("div", "lane");
    lane.setAttribute("role", "img");
    const segs = Array.from({ length: LANE_PHRASES }, () => lane.appendChild(el("i")));
    row.append(badge, info, lane);
    return { row, badge, style, status, lane, segs };
  });
  const barPips = Array.from({ length: PHRASE_BARS }, () => $("bars").appendChild(el("i")));

  function renderDecks(lanes: Lanes, styleOf: (piece: number) => string | undefined): void {
    for (const d of lanes.decks) {
      const r = deckRows[d.deck]!;
      r.row.classList.toggle("dominant", d.dominant);
      r.badge.classList.toggle("on", d.dominant && d.role !== "idle");
      r.style.textContent = d.piece === null ? "–" : (styleOf(d.piece) ?? "–");
      let status = "Idle";
      let cls = "";
      if (d.role === "air") [status, cls] = player.playing ? ["On air", "air"] : ["Paused", ""];
      else if (d.role === "out") [status, cls] = ["Going out", "moving"];
      else if (d.role === "in") [status, cls] = ["Coming in", "moving"];
      else if (d.role === "cued" && d.piece !== null) status = `Cued · track ${no(d.piece)}`;
      r.status.textContent = status;
      r.status.className = `dk-status ${cls}`;
      const later = d.role === "in" || d.role === "cued";
      d.segs.forEach((s, k) => paintSeg(r.segs[k]!, s, later));
      r.lane.setAttribute("aria-label", laneWords(d));
    }
    const where = `Phrase ${lanes.phrase + 1} · Bar ${lanes.barInPhrase + 1}`;
    $("where").textContent = where;
    $("where-narrow").textContent = where;
    barPips.forEach((p, k) => {
      p.classList.toggle("done", k < lanes.barInPhrase);
      p.classList.toggle("here", k === lanes.barInPhrase);
    });
    const axis = $("axis");
    axis.replaceChildren();
    if (!lanes.mix || lanes.mix.from > 0) axis.append(el("span", undefined, "Now"));
    if (lanes.mix) {
      const m = el("span", "mix", MIX_LABEL[lanes.mix.type]);
      m.style.gridColumn = `${lanes.mix.from + 1} / ${lanes.mix.to + 2}`;
      axis.append(m);
    }
  }

  // --- Tracklist ----------------------------------------------------------
  const heard: Heard[] = [];
  /** Set time at an audio-clock time: from where the first bar heard sits in the set (its nominal time), counting only time heard. */
  let setClock: { at: number; t: number } | null = null;
  const setTime = (t: number) => (setClock ? setClock.at + (t - setClock.t) : 0);
  function hear(info: BarInfo, at: number): void {
    if (heard.some((h) => h.piece === info.pieceIndex)) return;
    heard.push({ piece: info.pieceIndex, styleId: info.styleId, styleTitle: info.styleTitle, at });
    heard.sort((a, b) => a.piece - b.piece);
  }
  /** Note the tracks sounding in an audible bar, with when they began. */
  function noteTracks(tb: TimedBar): void {
    const bar = tb.bar;
    const i = bar.info;
    const sec = barSeconds(bar);
    setClock ??= { at: (conductor?.trackPlan(i.pieceIndex)?.start ?? 0) + i.barInPiece * sec, t: tb.start };
    const t = bar.transition?.type === "cut" ? undefined : bar.transition;
    // Bars ago each began: the incoming in an overlap at its start; on landing, every track at its own first bar.
    const first = !heard.length;
    const ago = (info: BarInfo) => (t && info.pieceIndex === t.to ? t.bar : first ? info.barInPiece : 0);
    hear(i, setTime(tb.start - ago(i) * sec));
    if (bar.with) hear(bar.with.info, setTime(tb.start - ago(bar.with.info) * sec));
  }

  function trackLi(cls: string, piece: number, name: string, time: string): HTMLLIElement {
    const li = el("li", `other ${cls}`);
    li.append(el("span", "no", no(piece)), el("span", "name", name), el("span", "time", time));
    return li;
  }

  /** What the HUD shows: the audible bar, or before anything plays, where the set will start. */
  function view(): { bar: Bar | null; tb: TimedBar | null; piece: number; barInPiece: number; pieceBars: number; styleId: string; styleTitle: string; sec: number } | null {
    // Bars from before a jump or a new set are still audible for a moment: they are not this set's.
    const tb = player.seeking ? undefined : player.current();
    if (tb && !tb.bar.info.gap) {
      const i = tb.bar.info;
      return { bar: tb.bar, tb, piece: i.pieceIndex, barInPiece: i.barInPiece, pieceBars: i.pieceBars, styleId: i.styleId, styleTitle: i.styleTitle, sec: barSeconds(tb.bar) };
    }
    const c = conductor;
    const pos = player.position();
    const plan = c?.trackPlan(pos.piece);
    if (!c || !plan) return null;
    return { bar: null, tb: null, piece: pos.piece, barInPiece: pos.bar, pieceBars: c.trackPiece(pos.piece).totalBars, styleId: plan.styleId, styleTitle: styleById.get(plan.styleId)?.corpus.title ?? "", sec: (4 * 60) / plan.bpm };
  }

  // --- Now playing --------------------------------------------------------
  let lastKey = "";
  let lastTrack = -1;
  function describe(): void {
    const v = view();
    if (!v) return;
    const c = conductor;
    const t = v.bar?.transition;
    // Plan the handover as soon as it could show on the lanes (the set would plan it a little later itself).
    if (c && v.bar && !t && v.barInPiece >= v.pieceBars - BLEND_BARS - LANE_PHRASES * PHRASE_BARS) c.planTransition(v.piece);
    if (v.tb) noteTracks(v.tb);
    const out = t || !c ? null : c.transitionPlan(v.piece);
    const nextPlan = c?.trackPlan(v.piece + 1) ?? null;
    const key = `${player.seed}:${v.piece}:${v.barInPiece}:${player.playing}:${heard.length}:${out?.type}:${nextPlan?.styleId}:${chosen.join()}`;
    if (key === lastKey) return;
    lastKey = key;
    persist();

    // Lanes.
    const lanes = deckLanes({ piece: v.piece, barInPiece: v.barInPiece, pieceBars: v.pieceBars, transition: t, out, phraseBars: PHRASE_BARS });
    const styleOf = (piece: number) => {
      if (piece === v.piece) return v.styleTitle;
      const w = v.bar?.with?.info;
      if (w?.pieceIndex === piece) return w.styleTitle;
      const plan = c?.trackPlan(piece);
      return plan ? styleById.get(plan.styleId)?.corpus.title : undefined;
    };
    renderDecks(lanes, styleOf);

    // Tracklist: three before, the one playing, and the next once it is planned.
    const name = titleOf(v.piece, v.styleId);
    const nowAt = heard.find((h) => h.piece === v.piece)?.at ?? (c?.trackPlan(v.piece)?.start ?? 0);
    const before = heard.filter((h) => h.piece < v.piece);
    const list: HTMLLIElement[] = before.slice(-3).map((h, k, a) => trackLi(`age-${a.length - k}`, h.piece, titleOf(h.piece, h.styleId), clock(h.at)));
    const now = el("li", "now");
    now.setAttribute("aria-current", "true");
    now.append(el("span", "meta", `${no(v.piece)} · ${clock(nowAt)} · ${v.styleTitle}`), el("span", "name", name));
    list.push(now);
    const nextHeard = heard.find((h) => h.piece === v.piece + 1);
    if (nextHeard) list.push(trackLi("next", nextHeard.piece, titleOf(nextHeard.piece, nextHeard.styleId), clock(nextHeard.at)));
    else if (nextPlan && v.tb) {
      const cut = v.bar?.transition?.type === "cut" ? v.bar.transition : undefined;
      const bars = cut ? cut.bars - cut.bar : out ? out.start - v.barInPiece : null;
      if (bars !== null) list.push(trackLi("next", v.piece + 1, titleOf(v.piece + 1, nextPlan.styleId), `≈ ${clock(setTime(v.tb.start) + bars * v.sec)}`));
    }
    $("tracks").replaceChildren(...list);
    // Earlier (narrow layout): the rest, newest first.
    const earlier = before.slice(0, -1).reverse();
    $("earlier-sec").hidden = !earlier.length;
    $("earlier").replaceChildren(
      ...earlier.map((h) => {
        const li = el("li");
        li.append(el("span", "no", no(h.piece)), el("span", "name", titleOf(h.piece, h.styleId)), el("span", "time", clock(h.at)));
        return li;
      }),
    );

    document.title = `${player.playing ? "▶ " : ""}${name} · DJ Claudia`;
    if ("mediaSession" in navigator && (v.piece !== lastTrack || !navigator.mediaSession.metadata)) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: name, artist: "DJ Claudia", album: `Set ${player.seed} · track ${no(v.piece)} · ${v.styleTitle}` });
    }
    lastTrack = v.piece;
  }

  function render(): void {
    playBtn.setAttribute("aria-label", player.playing ? "Pause" : "Play");
    document.documentElement.classList.toggle("playing", player.playing);
    $("live-text").textContent = player.playing ? "Live" : "Paused";
    holdMedia(player.playing);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = player.playing ? "playing" : "paused";
    lastKey = "";
    describe();
    renderSkip();
  }
  player.onChange(render);
  player.onChange(renderEngine);
  renderEngine();
  setInterval(() => {
    describe();
    renderSkip();
    renderEngine();
  }, 200);
  render();
}

main().catch((err: unknown) => {
  console.error(err);
  const p = document.createElement("p");
  p.style.cssText = "padding:16px;color:#ff3b5c;font-family:monospace";
  p.textContent = `Failed to start: ${String(err)}`;
  document.body.prepend(p);
});
