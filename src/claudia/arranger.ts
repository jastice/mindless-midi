/**
 * DJ Claudia, arranged by hand. The same set as the main page (one seed, the
 * same set conductor, two decks, the booth cam), with the running order laid
 * out as slots: the two tracks just played, the one playing and the next five.
 * Drag a style into a scheduled slot and that track is that style; the set
 * chooses the tracks around it. Each track has a button to play it from its
 * start, the arrow keys move a phrase at a time, and one button goes to the
 * deck transition. The booth cam sits in a small window beside it all.
 */
import { mediaAnchor } from "../app/media_anchor.js";
import { EXPRESSION, type Engine, Player, type Position, type TimedBar } from "../app/player.js";
import type { StyleBundle } from "../corpus/schema.js";
import { DEFAULT_SET_OPTIONS, MIX_BARS, PHRASE_BARS, SetConductor, type TrackInfo } from "../engine/set.js";
import type { TransitionType } from "../engine/types.js";
import { randomSeed } from "../theory/seed.js";
import { keyLabel } from "../theory/theory.js";
import { type Spot, type TrackShape, formatPins, nextTransition, parsePins, slotIndices, stepPhrase, transitionBar } from "./arranger_model.js";
import { BoothCam } from "./booth.js";
import type { ClipSet } from "./director.js";

const ENGINES: { id: Engine; label: string; desc: string }[] = [
  { id: "synth", label: "Synth", desc: "Modelled sounds, nothing to download." },
  { id: "samples", label: "Samples", desc: "Recorded one-shots and instruments, downloaded as the set needs them." },
];
const TRANSITION_LABEL: Record<TransitionType, string> = { blend: "Blend", filter: "Filter", cut: "Cut", breakdown: "Breakdown" };
const STAGE_LABEL = { in: "Mix-in", body: "Body", out: "Mix-out" };
/** The palette's chip for "let the set choose". */
const AUTO = "auto";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`dj-claudia-arranger:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`dj-claudia-arranger:${key}`, value);
    } catch {
      /* private mode etc. */
    }
  },
};

const formatAt = (p: Position) => `${p.piece + 1}.${p.bar + 1}`;

function parseAt(s: string | null): Position | undefined {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(s ?? "");
  if (!m) return undefined;
  const piece = Number(m[1]) - 1;
  const bar = Number(m[2] ?? 1) - 1;
  return piece >= 0 && bar >= 0 ? { piece, bar } : undefined;
}

const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const tempo = (bpm: number) => (Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function mixStage(barInPiece: number, pieceBars: number): "in" | "body" | "out" {
  if (barInPiece < MIX_BARS) return "in";
  if (pieceBars - barInPiece <= MIX_BARS) return "out";
  return "body";
}

function toast(text: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

async function main(): Promise<void> {
  const { styles } = (await (await fetch(new URL("styles.json", document.baseURI))).json()) as { styles: StyleBundle[] };
  const styleOf = new Map(styles.map((s) => [s.id, s]));

  // The URL is the session (seed, place, hand-picked styles, sound); a bare visit resumes the last one.
  const params = new URLSearchParams(location.search);
  const linked = params.get("seed");
  const savedSeed = linked ? null : store.get("seed");
  const seed = linked || savedSeed || randomSeed();
  const at = parseAt(linked ? params.get("at") : savedSeed ? store.get("at") : null);
  /** Hand-picked styles by track index: the page's copy, given to each conductor as it is made. */
  const pins = parsePins(linked ? params.get("pins") : savedSeed ? store.get("pins") : null);
  const volume = Number(store.get("volume") ?? "0.8");
  const wantedEngine = params.get("sound") ?? store.get("sound") ?? "synth";
  const engine: Engine = ENGINES.some((e) => e.id === wantedEngine) ? (wantedEngine as Engine) : "synth";

  let conductor: SetConductor | null = null;
  const player = new Player(styles, {
    source: (pool, s, pieces) => {
      const c = new SetConductor(pool, s, { ...pieces, ...DEFAULT_SET_OPTIONS });
      for (const [i, id] of pins) c.pin(i, id);
      return (conductor = c);
    },
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
  const cond = () => conductor!;

  // --- Booth cam ----------------------------------------------------------
  const clipBase = new URL(params.get("clips") ?? "clips/", document.baseURI);
  let booth: BoothCam | null = null;
  try {
    const set = (await (await fetch(new URL("clips.json", document.baseURI))).json()) as ClipSet;
    const still = set.stills.home;
    const served = still ? (await fetch(new URL(still, clipBase), { method: "HEAD" })).ok : false;
    if (set.clips.length && served) booth = new BoothCam($("cam"), player, set, clipBase);
  } catch (err) {
    console.warn("booth cam unavailable", err);
  }
  const camToggle = $<HTMLButtonElement>("cam-toggle");
  $("cam").parentElement!.hidden = !booth;
  function renderCam(on: boolean): void {
    booth?.setEnabled(on);
    camToggle.setAttribute("aria-pressed", String(on));
    camToggle.textContent = on ? "Hide" : "Show";
  }
  let camOn = store.get("booth") !== "off";
  renderCam(camOn);
  camToggle.addEventListener("click", () => {
    camOn = !camOn;
    store.set("booth", camOn ? "on" : "off");
    renderCam(camOn);
  });

  // --- Session ------------------------------------------------------------
  const seedInput = $<HTMLInputElement>("seed");
  seedInput.value = seed;
  function shareUrl(): string {
    const u = new URL(location.href);
    u.search = "";
    u.searchParams.set("seed", player.seed);
    const here = player.position();
    if (here.piece || here.bar) u.searchParams.set("at", formatAt(here));
    if (pins.size) u.searchParams.set("pins", formatPins(pins));
    if (player.engine !== "synth") u.searchParams.set("sound", player.engine);
    return u.href;
  }
  function persist(): void {
    store.set("sound", player.engine);
    store.set("pins", formatPins(pins));
    if (player.started || pins.size) {
      store.set("seed", player.seed);
      store.set("at", formatAt(player.position()));
    }
    history.replaceState(null, "", shareUrl());
  }
  addEventListener("pagehide", persist);
  $("share").addEventListener("click", () => {
    navigator.clipboard?.writeText(shareUrl()).then(
      () => toast("Link copied: same set, same picks, same bar"),
      () => toast(shareUrl()),
    );
  });
  function newSet(s: string): void {
    pins.clear();
    player.reseed(s);
    seedInput.value = player.seed;
    refresh(true);
  }
  $("reseed").addEventListener("click", () => {
    newSet(randomSeed());
    toast(`New set: ${player.seed}`);
  });
  seedInput.addEventListener("change", () => {
    const s = seedInput.value.trim();
    if (s && s !== player.seed) newSet(s);
    else seedInput.value = player.seed;
  });

  // --- Sound --------------------------------------------------------------
  const chipFor = new Map<Engine, HTMLButtonElement>();
  for (const e of ENGINES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "engine";
    chip.setAttribute("role", "radio");
    chip.innerHTML = `<span class="led" aria-hidden="true"></span><span class="nm"></span><span class="fill" aria-hidden="true"></span>`;
    chip.querySelector(".nm")!.textContent = e.label;
    chip.addEventListener("click", () => {
      void player.setEngine(e.id);
      persist();
    });
    chipFor.set(e.id, chip);
    $("engines").append(chip);
  }
  function renderEngine(): void {
    const pending = player.pendingEngine;
    const shown = player.audibleEngine;
    const progress = player.loadProgress;
    const loading = pending ?? (progress !== null ? shown : null);
    for (const [id, chip] of chipFor) {
      chip.setAttribute("aria-checked", String(id === shown));
      chip.classList.toggle("pending", id === pending);
      chip.style.setProperty("--progress", id === loading && progress !== null ? String(progress) : "0");
    }
    let desc = player.loading ? "Loading samples…" : (ENGINES.find((x) => x.id === shown)?.desc ?? "");
    if (pending) {
      const when = player.switchIn;
      desc = when === null ? `Getting ${ENGINES.find((x) => x.id === pending)!.label} ready. It takes over on a phrase.` : `Takes over in ${Math.ceil(when)} s.`;
    }
    $("engine-desc").textContent = desc;
    const credits = player.sampleCredits;
    $("credits").hidden = !credits.length;
    if (credits.length) $("credits").textContent = `Sampled instruments: ${credits.join(", ")}.`;
  }
  const vol = $<HTMLInputElement>("volume");
  vol.value = String(volume);
  vol.addEventListener("input", () => {
    player.setVolume(Number(vol.value));
    store.set("volume", vol.value);
  });
  // Arrow keys are for phrases, not for a slider left focused.
  vol.addEventListener("pointerup", () => vol.blur());

  // --- Transport and navigation --------------------------------------------
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
    refresh(true);
  }
  playBtn.addEventListener("click", toggle);

  const shape = (i: number): TrackShape => {
    const t = cond().trackInfo(i);
    return { bars: t.bars, out: t.out! };
  };
  /** Jump to a bar of a track; it plays right away if playing, and where Play will start from if not. */
  function jump(spot: Spot): void {
    player.goToBar(spot.piece, spot.bar, spot.solo);
    refresh(true);
    persist();
  }
  /** Play track `i` from its start, starting the audio if need be. */
  async function playTrack(i: number): Promise<void> {
    jump({ piece: i, bar: 0, solo: true });
    if (!player.playing) await toggle();
  }
  const phrase = (direction: -1 | 1) => jump(stepPhrase(player.position(), direction, (p) => cond().trackInfo(p, false).bars));
  const toTransition = () => jump(nextTransition(player.position(), shape));
  $("back").addEventListener("click", () => phrase(-1));
  $("fwd").addEventListener("click", () => phrase(1));
  $("xfade").addEventListener("click", toTransition);

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    // On a focused button, Space and Enter press it.
    const onButton = t instanceof HTMLButtonElement;
    if (e.code === "Space" && !onButton) {
      e.preventDefault();
      void toggle();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      phrase(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      phrase(-1);
    } else if (e.key === "t" || e.key === "T") {
      toTransition();
    } else if (e.key === "Escape" && armed) arm(null);
  });
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => void player.play());
    navigator.mediaSession.setActionHandler("pause", () => void player.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => phrase(1));
    navigator.mediaSession.setActionHandler("previoustrack", () => phrase(-1));
  }

  // --- Styles: the palette, and putting one in a slot ----------------------
  const paletteEl = $("palette");
  /** The style picked up (dragged, or clicked to put in a slot next), or "auto". */
  let armed: string | null = null;
  let dragging: string | null = null;
  const chips = new Map<string, HTMLButtonElement>();
  const addChip = (id: string, label: string, detail: string, color?: string) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = id === AUTO ? "chip auto" : "chip";
    chip.draggable = true;
    chip.dataset.style = id;
    chip.setAttribute("aria-pressed", "false");
    if (color) chip.style.setProperty("--c", color);
    chip.innerHTML = `<span class="sw" aria-hidden="true"></span><span class="nm"></span><span class="tp"></span>`;
    chip.querySelector(".nm")!.textContent = label;
    chip.querySelector(".tp")!.textContent = detail;
    chips.set(id, chip);
    paletteEl.append(chip);
  };
  for (const s of styles) addChip(s.id, s.corpus.title, `${s.corpus.tempo.min}–${s.corpus.tempo.max}`, s.color);
  addChip(AUTO, "Auto", "set chooses");
  function arm(id: string | null): void {
    armed = id;
    for (const [k, chip] of chips) chip.setAttribute("aria-pressed", String(k === id));
    $("slots").classList.toggle("armed", id !== null);
    $("order-hint").textContent =
      id === null
        ? "Drag a style into a slot below, or click a style and then a slot. The set chooses the rest around it."
        : `${id === AUTO ? "Auto" : styleOf.get(id)?.corpus.title} picked up: click a scheduled slot to put it there (Esc to put it down).`;
  }
  paletteEl.addEventListener("click", (e) => {
    const chip = (e.target as Element).closest<HTMLElement>(".chip");
    if (chip) arm(armed === chip.dataset.style ? null : chip.dataset.style!);
  });
  paletteEl.addEventListener("dragstart", (e) => {
    const chip = (e.target as Element).closest<HTMLElement>(".chip");
    if (!chip || !e.dataTransfer) return;
    dragging = chip.dataset.style!;
    e.dataTransfer.setData("text/plain", dragging);
    e.dataTransfer.effectAllowed = "copy";
    chip.classList.add("dragging");
  });
  paletteEl.addEventListener("dragend", () => {
    dragging = null;
    for (const chip of chips.values()) chip.classList.remove("dragging");
    for (const el of document.querySelectorAll(".slot.over")) el.classList.remove("over");
  });

  /** Put `styleId` (or, null, the set's own choice) in slot `i`, if the music allows it. */
  function setSlot(i: number, styleId: string | null): void {
    const c = cond();
    const cur = player.position().piece;
    if (i <= cur) return toast(`Track ${i + 1} has already started.`);
    if (i <= c.settled) return toast(`Track ${i + 1} is already part of what is playing: it mixes in too soon to change.`);
    if (!c.pin(i, styleId)) return toast(`Track ${i + 1} cannot take that.`);
    if (styleId === null) pins.delete(i);
    else pins.set(i, styleId);
    refresh(true);
    persist();
    toast(styleId === null ? `Track ${i + 1}: the set chooses` : `Track ${i + 1}: ${styleOf.get(styleId)?.corpus.title}`);
  }
  const apply = (i: number, id: string) => setSlot(i, id === AUTO ? null : id);

  const slotsEl = $("slots");
  slotsEl.addEventListener("dragover", (e) => {
    const li = (e.target as Element).closest<HTMLElement>(".slot.drop");
    if (!li || !dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    li.classList.add("over");
  });
  slotsEl.addEventListener("dragleave", (e) => {
    const li = (e.target as Element).closest<HTMLElement>(".slot");
    if (li && !li.contains(e.relatedTarget as Node | null)) li.classList.remove("over");
  });
  slotsEl.addEventListener("drop", (e) => {
    const li = (e.target as Element).closest<HTMLElement>(".slot.drop");
    if (!li) return;
    e.preventDefault();
    li.classList.remove("over");
    const id = e.dataTransfer?.getData("text/plain") || dragging;
    dragging = null;
    if (id) apply(Number(li.dataset.index), id);
  });
  slotsEl.addEventListener("click", (e) => {
    const target = e.target as Element;
    const li = target.closest<HTMLElement>(".slot");
    if (!li || li.classList.contains("empty")) return;
    const i = Number(li.dataset.index);
    const button = target.closest<HTMLElement>("button");
    if (button?.classList.contains("go")) return void playTrack(i);
    if (button?.classList.contains("clear")) return setSlot(i, null);
    const ph = target.closest<HTMLElement>(".phrases i");
    if (ph) return jump({ piece: i, bar: Number(ph.dataset.phrase) * PHRASE_BARS, solo: false });
    if (armed) {
      if (li.classList.contains("drop")) {
        apply(i, armed);
        arm(null);
      } else setSlot(i, armed === AUTO ? null : armed); // says why not
    }
  });

  // --- The running order ----------------------------------------------------
  const keyOf = (t: TrackInfo) => keyLabel(t.key.tonic, t.key.mode);
  let slotsKey = "";
  function renderSlots(cur: number, liveTo: number): void {
    const c = cond();
    const order = slotIndices(cur);
    const items = order.map((i, n) => {
      const li = document.createElement("li");
      li.dataset.index = String(i);
      if (i < 0) {
        li.className = "slot empty";
        li.innerHTML = `<div class="slot-main"><span class="no">–</span><span class="swatch"></span><span class="name">No earlier track</span></div>`;
        return li;
      }
      const last = n === order.length - 1;
      const t = c.trackInfo(i, !last);
      const style = styleOf.get(t.styleId);
      const state = i < cur ? "past" : i === cur ? "cur" : "next";
      const locked = i > cur && i <= c.settled;
      li.className = `slot ${state}${locked ? " locked" : ""}${state === "next" && !locked ? " drop" : ""}${i === liveTo ? " coming" : ""}${last ? " last" : ""}`;
      li.style.setProperty("--c", style?.color ?? "var(--line)");
      li.innerHTML = `
        <div class="slot-main">
          <span class="no"></span><span class="swatch" aria-hidden="true"></span>
          <span class="name"><span class="title"></span></span>
          <span class="meta"></span>
          <span class="acts"></span>
        </div>`;
      li.querySelector(".no")!.textContent = String(i + 1).padStart(2, "0");
      li.querySelector(".title")!.textContent = style?.corpus.title ?? t.styleId;
      const name = li.querySelector(".name")!;
      if (t.pinned) name.insertAdjacentHTML("beforeend", `<span class="pinned" title="Picked by hand">Picked</span>`);
      if (i === liveTo) name.insertAdjacentHTML("beforeend", `<span class="lock">Coming in</span>`);
      else if (locked) name.insertAdjacentHTML("beforeend", `<span class="lock" title="Part of what is playing now: too late to change">Locked</span>`);
      li.querySelector(".meta")!.textContent = `${keyOf(t)} · ${tempo(t.bpm)} bpm · ${clock(t.seconds)} · ${t.bars} bars`;
      const acts = li.querySelector(".acts")!;
      const go = document.createElement("button");
      go.type = "button";
      go.className = "go";
      go.textContent = "▶";
      go.title = i === cur ? `Play track ${i + 1} again from its start` : `Play track ${i + 1} from its start`;
      go.setAttribute("aria-label", go.title);
      acts.append(go);
      if (t.pinned && state === "next" && !locked) {
        const x = document.createElement("button");
        x.type = "button";
        x.className = "clear";
        x.textContent = "×";
        x.title = "Hand this slot back to the set";
        x.setAttribute("aria-label", x.title);
        acts.append(x);
      }
      if (state === "cur") li.append(phraseStrip(t));
      if (!last && t.out) {
        const next = c.trackInfo(i + 1, false);
        const hand = document.createElement("div");
        hand.className = `handover${i + 1 === liveTo ? " live" : ""}`;
        const bpms = next.bpm === t.bpm ? "" : ` · ${tempo(t.bpm)} → ${tempo(next.bpm)} bpm`;
        hand.textContent = `${TRANSITION_LABEL[t.out.type]}${t.out.bars ? ` · ${t.out.bars} bars` : ""}${bpms}`;
        li.append(hand);
      }
      return li;
    });
    slotsEl.replaceChildren(...items);
  }

  /** The playing track in phrases: mix-in, body, mix-out, with its transition marked. Click one to jump there. */
  function phraseStrip(t: TrackInfo): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "phrases";
    strip.title = "The track in phrases: click one to jump to it";
    const from = Math.floor(transitionBar({ bars: t.bars, out: t.out! }) / PHRASE_BARS);
    for (let p = 0; p < Math.ceil(t.bars / PHRASE_BARS); p++) {
      const el = document.createElement("i");
      el.dataset.phrase = String(p);
      el.className = `${mixStage(p * PHRASE_BARS, t.bars)}${p >= from ? " x" : ""}`;
      strip.append(el);
    }
    return strip;
  }

  // --- Now playing ----------------------------------------------------------
  const pips = [...Array(PHRASE_BARS)].map(() => {
    const el = document.createElement("i");
    $("pips").append(el);
    return el;
  });
  let nowKey = "";
  function updateNow(pos: Position, tb: TimedBar | undefined): void {
    const c = cond();
    const t = c.trackInfo(pos.piece);
    const style = styleOf.get(t.styleId);
    const live = tb && tb.bar.info.pieceIndex === pos.piece && !player.seeking ? tb : undefined;
    const bpm = live ? live.bar.bpm : t.bpm;
    const tx = live?.bar.transition;
    const here = transitionBar({ bars: t.bars, out: t.out! });
    const key = [pos.piece, pos.bar, player.playing, bpm, tx?.bar ?? -1, player.started].join(":");
    if (key === nowKey) return;
    nowKey = key;
    $("state").textContent = player.playing ? (player.seeking ? "Cueing" : "On air") : player.started ? "Paused" : "Standby";
    $("now-track").textContent = `Track ${pos.piece + 1}`;
    $("now-style").textContent = `${style?.corpus.title ?? t.styleId} · ${keyOf(t)}`;
    const stage = mixStage(pos.bar, t.bars);
    const mix = $("mix");
    mix.textContent = STAGE_LABEL[stage];
    mix.dataset.stage = stage;
    $("bar").textContent = String(pos.bar + 1);
    $("bars").textContent = `/ ${t.bars}`;
    $("phrase").textContent = String(Math.floor(pos.bar / PHRASE_BARS) + 1);
    $("phrases").textContent = `/ ${Math.ceil(t.bars / PHRASE_BARS)}`;
    $("bpm").textContent = tempo(bpm);
    const left = here - pos.bar;
    $("next-x").textContent = `${TRANSITION_LABEL[t.out!.type]}${left > 0 ? `, ${plural(left, "bar")}` : tx ? ", under way" : ", now"}`;
    const line = $("transition");
    line.hidden = !tx;
    if (tx) {
      const rest = tx.bars - tx.bar;
      const swap = tx.type === "cut" ? ` · cut in ${plural(rest, "bar")}` : tx.bar < tx.swap ? ` · bass swap in ${tx.swap - tx.bar}` : "";
      line.textContent = `${TRANSITION_LABEL[tx.type]} into track ${tx.to + 1} · bar ${tx.bar + 1} of ${tx.bars}${swap}`;
    }
    const inPhrase = pos.bar % PHRASE_BARS;
    pips.forEach((el, k) => {
      el.classList.toggle("done", k < inPhrase);
      el.classList.toggle("here", k === inPhrase);
    });
    const hereP = Math.floor(pos.bar / PHRASE_BARS);
    slotsEl.querySelectorAll<HTMLElement>(".slot.cur .phrases i").forEach((el, p) => {
      el.classList.toggle("done", p < hereP);
      el.classList.toggle("here", p === hereP);
    });
    document.title = `${player.playing ? "▶" : "❚❚"} ${style?.corpus.title ?? ""} · Arranger`;
    persist();
  }

  /** Redraw what has changed (`force`: everything). */
  function refresh(force = false): void {
    if (!conductor) return;
    const pos = player.position();
    const tb = player.current();
    const liveTo = tb && tb.bar.info.pieceIndex === pos.piece && !player.seeking ? (tb.bar.transition?.to ?? -1) : -1;
    const key = [player.seed, pos.piece, conductor.settled, formatPins(pins), armed, liveTo].join("|");
    if (force || key !== slotsKey) {
      slotsKey = key;
      renderSlots(pos.piece, liveTo);
      nowKey = "";
    }
    updateNow(pos, tb);
    playBtn.setAttribute("aria-label", player.playing ? "Pause" : "Play");
    $("play-glyph").textContent = player.playing ? "❚❚" : "▶";
    document.documentElement.classList.toggle("playing", player.playing);
    holdMedia(player.playing);
  }

  player.onChange(() => {
    refresh();
    renderEngine();
  });
  setInterval(() => {
    refresh();
    if (player.pendingEngine !== null || player.loadProgress !== null) renderEngine();
  }, 200);
  renderEngine();
  arm(null);
  refresh(true);
  persist();

  Object.assign(window, { arranger: { player, booth, styles, pins, conductor: cond, setSlot, jump, playTrack, phrase, toTransition } });
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin", `<p style="padding:16px;color:#ff4d6d">Failed to start: ${String(err)}</p>`);
});
