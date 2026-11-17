/**
 * DJ Claudia: an endless, seeded DJ set. One track after another, each in a
 * compatible key and within a few percent of the last tempo, mixed into the
 * next on two decks. The set conductor makes the bars; the shared Player
 * plays them for weight, with the Synth or Samples engine.
 */
import { mediaAnchor } from "../app/media_anchor.js";
import { EXPRESSION, type Engine, Player, type Position, type TimedBar } from "../app/player.js";
import { ROLES } from "../corpus/constants.js";
import type { StyleBundle } from "../corpus/schema.js";
import { DEFAULT_SET_OPTIONS, MIX_BARS, PHRASE_BARS, SetConductor } from "../engine/set.js";
import { type Bar, type TransitionType, barSeconds } from "../engine/types.js";
import { randomSeed } from "../theory/seed.js";
import { BoothCam } from "./booth.js";
import type { ClipSet } from "./director.js";

const ENGINES: { id: Engine; label: string; desc: string }[] = [
  { id: "synth", label: "Synth", desc: "Modelled sounds, nothing to download." },
  { id: "samples", label: "Samples", desc: "Recorded one-shots and instruments, downloaded as the set needs them." },
];

const ROLE_LABELS: Record<(typeof ROLES)[number], string> = { drums: "Drums", bass: "Bass", comp: "Stab", pad: "Pad", arp: "Arp", counter: "Counter", lead: "Lead" };
/** Drums first and lead last: the order a mix-in brings parts in. */
const LIGHTS = ["drums", "bass", "comp", "pad", "arp", "counter", "lead"] as const;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

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

/** Where a bar sits in its track's mix: coming in, the body, or going out. */
function mixStage(barInPiece: number, pieceBars: number): "in" | "body" | "out" {
  if (barInPiece < MIX_BARS) return "in";
  if (pieceBars - barInPiece <= MIX_BARS) return "out";
  return "body";
}
const STAGE_LABEL = { in: "Mix-in", body: "Body", out: "Mix-out" };
const TRANSITION_LABEL: Record<TransitionType, string> = { blend: "Blend", filter: "Filter", cut: "Cut", breakdown: "Breakdown" };
/** A tempo as it reads: whole, or to a tenth while it ramps from one track's to the next. */
const tempo = (bpm: number) => (Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1));

function toast(text: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

async function main(): Promise<void> {
  const res = await fetch(new URL("styles.json", document.baseURI));
  const { styles } = (await res.json()) as { styles: StyleBundle[] };

  // The URL is the session (seed, place, sound); a bare visit resumes the last one.
  const params = new URLSearchParams(location.search);
  const linked = params.get("seed");
  const savedSeed = linked ? null : store.get("seed");
  const seed = linked || savedSeed || randomSeed();
  const at = parseAt(linked ? params.get("at") : savedSeed ? store.get("at") : null);
  const volume = Number(store.get("volume") ?? "0.8");
  const wantedEngine = params.get("sound") ?? store.get("sound") ?? "synth";
  const engine: Engine = ENGINES.some((e) => e.id === wantedEngine) ? (wantedEngine as Engine) : "synth";

  // The set conductor the player plays from, for each track's own tempo.
  let conductor: SetConductor | null = null;
  const player = new Player(styles, {
    source: (pool, s, pieces) => (conductor = new SetConductor(pool, s, { ...pieces, ...DEFAULT_SET_OPTIONS })),
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

  // --- Booth cam ----------------------------------------------------------
  // Clips come from the content-addressed store; until it exists, the dev server serves them at clips/.
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
  $("cam").parentElement!.hidden = !booth;
  function renderCam(on: boolean): void {
    booth?.setEnabled(on);
    camToggle.setAttribute("aria-pressed", String(on));
    camToggle.textContent = on ? "Hide booth cam" : "Show booth cam";
  }
  let camOn = store.get("booth") !== "off";
  renderCam(camOn);
  camToggle.addEventListener("click", () => {
    camOn = !camOn;
    store.set("booth", camOn ? "on" : "off");
    renderCam(camOn);
  });
  Object.assign(window, { djClaudia: { player, styles, booth } });

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
      remember();
    });
    chipFor.set(e.id, chip);
    $("engines").append(chip);
  }
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  function renderEngine(): void {
    const pending = player.pendingEngine;
    const shown = player.audibleEngine;
    const progress = player.loadProgress;
    const loading = pending ?? (progress !== null ? shown : null);
    for (const [id, chip] of chipFor) {
      chip.setAttribute("aria-checked", String(id === shown));
      chip.classList.toggle("pending", id === pending);
      chip.style.setProperty("--progress", id === loading && progress !== null ? String(progress) : "0");
      chip.tabIndex = id === shown ? 0 : -1;
    }
    let desc = player.loading ? "Loading samples…" : (ENGINES.find((x) => x.id === shown)?.desc ?? "");
    if (pending) {
      const label = ENGINES.find((x) => x.id === pending)!.label;
      const { bytes, rate } = player.downloads;
      const when = player.switchIn;
      desc = when === null ? `Getting ${label} ready: ${mb(bytes)} down${rate ? ` at ${mb(rate)}/s` : ""}. It takes over on a phrase.` : `${label} takes over in ${Math.ceil(when)} s.`;
    }
    $("engine-desc").textContent = desc;
    const credits = player.sampleCredits;
    $("credits").hidden = !credits.length;
    if (credits.length) $("credits").textContent = `Sampled instruments: ${credits.join(", ")}.`;
  }
  $("engines").addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    ev.preventDefault();
    const i = ENGINES.findIndex((x) => x.id === player.engine);
    const next = ENGINES[(i + 1) % ENGINES.length]!;
    void player.setEngine(next.id);
    chipFor.get(next.id)?.focus();
    remember();
  });

  // --- Session ------------------------------------------------------------
  const seedInput = $<HTMLInputElement>("seed");
  function shareUrl(): string {
    const u = new URL(location.href);
    u.search = "";
    u.searchParams.set("seed", player.seed);
    const here = player.position();
    if (here.piece || here.bar) u.searchParams.set("at", formatAt(here));
    if (player.engine !== "synth") u.searchParams.set("sound", player.engine);
    return u.href;
  }
  function remember(): void {
    store.set("sound", player.engine);
    persist();
  }
  function persist(): void {
    store.set("sound", player.engine);
    if (player.started) {
      store.set("seed", player.seed);
      store.set("at", formatAt(player.position()));
    }
    history.replaceState(null, "", shareUrl());
  }
  persist();
  addEventListener("pagehide", persist);
  seedInput.value = seed;
  $("share").addEventListener("click", () => {
    navigator.clipboard?.writeText(shareUrl()).then(
      () => toast("Link copied: same set, same bar"),
      () => toast(shareUrl()),
    );
  });
  function newSet(s: string): void {
    player.reseed(s);
    seedInput.value = player.seed;
    tracklist.length = 0;
    setStart = null;
    $("tracks").replaceChildren();
    lastKey = "";
    after();
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
    describe(player.current());
    renderSkip();
    persist();
  }
  function skip(): void {
    player.nextPieceOnPhrase(PHRASE_BARS);
    after();
  }
  $("skip").addEventListener("click", skip);
  const vol = $<HTMLInputElement>("volume");
  vol.value = String(volume);
  vol.addEventListener("input", () => {
    player.setVolume(Number(vol.value));
    store.set("volume", vol.value);
  });
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.repeat || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") {
      e.preventDefault();
      void toggle();
    } else if (e.key === "n" || e.key === "N" || e.key === "ArrowRight") skip();
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
    $("skip-note").textContent = s
      ? s.in === null
        ? `Track ${s.piece + 1} comes in on the next phrase. Press again to cut now.`
        : `Track ${s.piece + 1} in ${Math.ceil(s.in)} s, on the phrase.`
      : player.started
        ? ""
        : `Starts at track ${player.position().piece + 1}, bar ${player.position().bar + 1}.`;
  }

  // --- The decks ----------------------------------------------------------
  // Each deck shows its track and one light per part where its style has parts (lit while the arrangement grid has
  // the part in), else one per role. The deck with the low end is the one the big readout follows.
  const decks = ([0, 1] as const).map((d) => {
    const el = $(`deck-${d}`);
    return { el, roles: el.querySelector<HTMLElement>(".roles")!, lights: new Map<string, HTMLElement>(), lightsFor: "" };
  });
  function setLights(deck: (typeof decks)[number], names: readonly string[], label: (name: string) => string): void {
    if (names.join() === deck.lightsFor) return;
    deck.lightsFor = names.join();
    deck.lights.clear();
    deck.roles.replaceChildren();
    for (const name of names) {
      const el = document.createElement("span");
      el.className = "light";
      el.innerHTML = `<i aria-hidden="true"></i>`;
      el.append(label(name));
      deck.lights.set(name, el);
      deck.roles.append(el);
    }
  }
  /** What the two decks hold in the bar heard now: the bar's own, and in a transition the other beside it. */
  function renderDecks(bar: Bar): void {
    const t = bar.transition;
    for (const [d, deck] of decks.entries()) {
      const own = (bar.deck ?? 0) === d ? bar : bar.with?.deck === d ? bar.with : undefined;
      deck.el.classList.toggle("live", own !== undefined);
      deck.el.classList.toggle("dominant", own === bar);
      const set = (cls: string, text: string) => (deck.el.querySelector(cls)!.textContent = text);
      if (!own) {
        set(".dc-track", "");
        set(".dc-tag", "Idle");
        set(".dc-meta", "–");
        deck.el.dataset.role = "";
        for (const el of deck.lights.values()) el.classList.remove("on");
        continue;
      }
      const i = own.info;
      const coming = t !== undefined && i.pieceIndex === t.to;
      deck.el.dataset.role = own === bar ? "" : coming ? "in" : "out";
      set(".dc-track", `Track ${i.pieceIndex + 1}`);
      set(".dc-tag", own === bar ? (bar.with ? "Low end" : "On air") : coming ? "Coming in" : "Going out");
      set(".dc-meta", `${tempo(own.bpm)} bpm · ${i.keyName} · ${i.styleTitle}`);
      const parts = styles.find((s) => s.id === i.styleId)?.corpus.parts;
      if (parts) setLights(deck, parts.map((p) => p.id), (id) => id);
      else setLights(deck, LIGHTS, (role) => ROLE_LABELS[role as (typeof ROLES)[number]]);
      const sounding = new Set<string>(parts ? (i.parts ?? []).filter((id) => !i.thin?.includes(id)) : own.notes.map((n) => n.role));
      for (const [name, el] of deck.lights) el.classList.toggle("on", sounding.has(name));
    }
    // The transition in progress, counted down from the bar's own data.
    const line = $("transition");
    line.hidden = !t;
    if (t) {
      const left = t.bars - t.bar;
      const swap = t.type === "cut" ? ` · cut in ${left} bar${left === 1 ? "" : "s"}` : t.bar < t.swap ? ` · bass swap in ${t.swap - t.bar}` : "";
      line.textContent = `${TRANSITION_LABEL[t.type]} into track ${t.to + 1} · bar ${t.bar + 1} of ${t.bars}, ${left} left${swap}`;
    }
  }
  const pips = [...Array(PHRASE_BARS)].map(() => {
    const el = document.createElement("i");
    $("pips").append(el);
    return el;
  });
  const beats = [...Array(4)].map(() => {
    const el = document.createElement("i");
    $("beats").append(el);
    return el;
  });

  let stripKey = "";
  function renderStrip(info: TimedBar["bar"]["info"]): void {
    const phrases = Math.ceil(info.pieceBars / PHRASE_BARS);
    const key = `${info.pieceSeed}`;
    const strip = $("strip");
    if (key !== stripKey) {
      stripKey = key;
      strip.replaceChildren(
        ...[...Array(phrases)].map((_, p) => {
          const el = document.createElement("i");
          el.className = mixStage(p * PHRASE_BARS, info.pieceBars);
          return el;
        }),
      );
    }
    const here = Math.floor(info.barInPiece / PHRASE_BARS);
    [...strip.children].forEach((el, p) => {
      el.classList.toggle("done", p < here);
      el.classList.toggle("here", p === here);
    });
  }

  // --- Tracklist ----------------------------------------------------------
  /** Tracks heard this session, in order. */
  const tracklist: { piece: number; row: HTMLLIElement }[] = [];
  /** Audio time the first track heard began at; times are counted from it, so pauses do not count. */
  let setStart: number | null = null;
  function noteTrack(tb: TimedBar): void {
    const i = tb.bar.info;
    const last = tracklist[tracklist.length - 1];
    if (last?.piece === i.pieceIndex) return;
    const began = tb.start - i.barInPiece * barSeconds(tb.bar);
    setStart ??= began;
    const row = document.createElement("li");
    row.innerHTML = `<span class="t"></span><span class="n"></span><span class="s"></span><span class="k"></span><span class="b"></span>`;
    row.querySelector(".t")!.textContent = clock(began - setStart);
    row.querySelector(".n")!.textContent = String(i.pieceIndex + 1).padStart(2, "0");
    row.querySelector(".s")!.textContent = i.styleTitle;
    row.querySelector(".k")!.textContent = i.keyName;
    row.querySelector(".b")!.textContent = tempo(conductor?.trackPlan(i.pieceIndex)?.bpm ?? Math.round(tb.bar.bpm));
    for (const t of tracklist) t.row.classList.remove("now");
    row.classList.add("now");
    tracklist.push({ piece: i.pieceIndex, row });
    $("tracks").append(row);
    $("tracks-empty").hidden = true;
  }

  // --- Now playing --------------------------------------------------------
  let lastKey = "";
  function describe(tb: TimedBar | undefined): void {
    if (!tb) {
      if (player.started) $("state").textContent = player.playing ? "Cueing" : "Paused";
      return;
    }
    const i = tb.bar.info;
    const key = `${i.pieceSeed}:${i.barInPiece}:${player.playing}`;
    if (key === lastKey) return;
    lastKey = key;
    persist();
    noteTrack(tb);
    const stage = mixStage(i.barInPiece, i.pieceBars);
    $("title").textContent = i.styleTitle;
    $("track-no").textContent = `Track ${i.pieceIndex + 1}`;
    $("key").textContent = i.keyName;
    $("bpm").textContent = tempo(tb.bar.bpm);
    $("bar").textContent = `${i.barInPiece + 1}`;
    $("bars").textContent = `/ ${i.pieceBars}`;
    $("phrase").textContent = `${Math.floor(i.barInPiece / PHRASE_BARS) + 1}`;
    $("phrases").textContent = `/ ${Math.ceil(i.pieceBars / PHRASE_BARS)}`;
    // A build in progress, counted down to its drop, from the bar's own data.
    const build = i.build ? ` · Build, ${i.build.bars} bars (${i.build.bars - i.build.bar} to go)` : i.turn === "drop" ? " · Drop" : "";
    $("section").textContent = `Section ${i.section}${build}`;
    const mix = $("mix");
    mix.textContent = STAGE_LABEL[stage];
    mix.dataset.stage = stage;
    $("state").textContent = player.playing ? "On air" : "Paused";
    renderStrip(i);
    const inPhrase = i.barInPiece % PHRASE_BARS;
    pips.forEach((el, k) => {
      el.classList.toggle("done", k < inPhrase);
      el.classList.toggle("here", k === inPhrase);
    });
    renderDecks(tb.bar);
    document.title = `${player.playing ? "▶" : "❚❚"} ${i.styleTitle} · DJ Claudia`;
    if ("mediaSession" in navigator && (i.barInPiece === 0 || !navigator.mediaSession.metadata)) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: `${i.styleTitle} · ${i.keyName} · ${tb.bar.bpm} bpm`, artist: "DJ Claudia", album: `Set ${player.seed}, track ${i.pieceIndex + 1}` });
    }
  }

  // Beats of the bar, from the audio clock.
  function beat(): void {
    requestAnimationFrame(beat);
    const tb = player.playing ? player.current() : undefined;
    const b = tb ? Math.floor(((player.now - tb.start) / (tb.end - tb.start)) * tb.bar.beats) : -1;
    beats.forEach((el, k) => el.classList.toggle("on", k === b));
  }
  requestAnimationFrame(beat);

  function render(): void {
    $("play-glyph").textContent = player.playing ? "❚❚" : "▶";
    playBtn.setAttribute("aria-label", player.playing ? "Pause" : "Play");
    document.documentElement.classList.toggle("playing", player.playing);
    holdMedia(player.playing);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = player.playing ? "playing" : "paused";
    lastKey = "";
    describe(player.current());
    renderSkip();
  }
  player.onChange(render);
  player.onChange(renderEngine);
  renderEngine();
  setInterval(() => {
    describe(player.current());
    renderSkip();
    if (player.pendingEngine !== null || player.loadProgress !== null) renderEngine();
  }, 200);
  render();
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin", `<p style="padding:16px;color:#ff4d6d">Failed to start: ${String(err)}</p>`);
});
