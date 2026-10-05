/**
 * Page wiring: style picker, transport, now-playing, Media Session, and
 * persistence of the listener's choices (URL for sharing, localStorage for
 * convenience).
 */
import wasmUrl from "libadlmidi-js/dist/libadlmidi.nuked.browser.wasm";
import type { StyleBundle } from "../corpus/schema.js";
import { randomSeed } from "../theory/seed.js";
import { chordName } from "../theory/theory.js";
import { type Engine, Player, type TimedBar } from "./player.js";

/** Each engine is also an "edition" of the page: its look is in styles.css, keyed on `data-engine`. */
const ENGINES: { id: Engine; label: string; tag: string; edition: string; desc: string }[] = [
  { id: "fm", label: "FM chip", tag: "OPL3 sound card", edition: "Edition I · FM", desc: "An emulated OPL3 FM chip with classic DOS-era patch banks. The original beepy-boopy sound." },
  { id: "fm_bus", label: "FM + studio", tag: "studio-mixed chip", edition: "Edition II · Studio", desc: "The same chip, one track per instrument, mixed with reverb, echo, ducking and tape." },
  { id: "synth", label: "Synth", tag: "modelled instruments", edition: "Edition III · Schematic", desc: "Modelled instruments (struck strings, plucks, analog voices), mixed in the studio. Nothing to download." },
  { id: "samples", label: "Samples", tag: "recorded instruments", edition: "Edition IV · Field notes", desc: "Recorded instruments, downloaded as the music needs them (a few MB per style), mixed in the studio." },
];
import { Roll } from "./roll.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`mindless-midi:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`mindless-midi:${key}`, value);
    } catch {
      /* private mode etc. */
    }
  },
};

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
  const byId = new Map(styles.map((s) => [s.id, s]));

  const params = new URLSearchParams(location.search);
  const seed = params.get("seed") || randomSeed();
  const wanted = (params.get("styles") ?? store.get("styles") ?? "").split(",").filter((id) => byId.has(id));
  const selected = new Set(wanted.length ? wanted : styles.map((s) => s.id));
  const volume = Number(store.get("volume") ?? "0.8");
  const wantedEngine = params.get("sound") ?? store.get("sound") ?? "fm";
  const engine: Engine = ENGINES.some((e) => e.id === wantedEngine) ? (wantedEngine as Engine) : "fm";

  const player = new Player(
    styles.filter((s) => selected.has(s.id)),
    {
      seed,
      engine,
      processorUrl: new URL("worklet.js", import.meta.url).href,
      wasmUrl: new URL(wasmUrl, import.meta.url).href,
      stemWorkletUrl: new URL("stem-worklet.js", import.meta.url).href,
      workerUrl: new URL("render-worker.js", import.meta.url).href,
    },
  );
  player.setVolume(volume);
  // Handle for curious listeners in the dev console.
  Object.assign(window, { mindlessMidi: { player, styles } });
  const roll = new Roll($<HTMLCanvasElement>("roll"), player);
  roll.start();

  // --- Styles -------------------------------------------------------------
  const grid = $("styles");
  const cards = new Map<string, HTMLButtonElement>();
  for (const [n, s] of styles.entries()) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "style";
    card.style.setProperty("--swatch", s.color);
    card.setAttribute("aria-pressed", String(selected.has(s.id)));
    card.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="no" aria-hidden="true"></span><span class="nm"><span class="t"></span><span class="badge">Now playing</span></span><span class="ds"></span>`;
    card.querySelector(".no")!.textContent = String(n + 1).padStart(2, "0");
    card.querySelector(".t")!.textContent = s.corpus.title;
    card.querySelector(".ds")!.textContent = s.corpus.description;
    card.addEventListener("click", () => {
      if (selected.has(s.id)) {
        if (selected.size === 1) return toast("Keep at least one style");
        selected.delete(s.id);
      } else {
        selected.add(s.id);
      }
      card.setAttribute("aria-pressed", String(selected.has(s.id)));
      player.setStyles(styles.filter((x) => selected.has(x.id)));
      persist();
    });
    cards.set(s.id, card);
    grid.append(card);
  }

  // --- Sound engine -------------------------------------------------------
  const chips = $("engines");
  const chipFor = new Map<Engine, HTMLButtonElement>();
  for (const [n, e] of ENGINES.entries()) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "opt";
    chip.setAttribute("role", "radio");
    chip.innerHTML = `<span class="top"><span class="dot" aria-hidden="true"></span><span class="ltr" aria-hidden="true"></span></span><span class="nm"><span></span></span><span class="tag"></span>`;
    chip.querySelector(".ltr")!.textContent = String.fromCharCode(65 + n);
    chip.querySelector(".nm > span")!.textContent = e.label;
    chip.querySelector(".tag")!.textContent = e.tag;
    chip.title = e.desc;
    chip.addEventListener("click", () => {
      void player.setEngine(e.id);
      persist();
    });
    chipFor.set(e.id, chip);
    chips.append(chip);
  }
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  function renderEngine(): void {
    const pending = player.pendingEngine;
    const shown = player.audibleEngine;
    const progress = player.loadProgress;
    // The rule above the option that is loading fills up like a progress bar.
    const loadingChip = pending ?? (progress !== null ? shown : null);
    for (const [id, chip] of chipFor) {
      chip.setAttribute("aria-checked", String(id === shown));
      chip.classList.toggle("pending", id === pending);
      const filling = id === loadingChip && progress !== null;
      chip.classList.toggle("filling", filling);
      chip.style.setProperty("--progress", filling ? String(progress) : "0");
      if (filling) chip.setAttribute("aria-label", `${ENGINES.find((x) => x.id === id)!.label}, loading ${Math.round(progress * 100)}%`);
      else chip.removeAttribute("aria-label");
      chip.tabIndex = id === shown ? 0 : -1;
    }
    const e = ENGINES.find((x) => x.id === shown)!;
    // The page re-dresses itself for the engine that is actually audible.
    if (document.documentElement.dataset.engine !== shown) {
      document.documentElement.dataset.engine = shown;
      roll.readTheme();
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--paper").trim());
    }
    $("edition").textContent = e.edition;
    let desc = player.loading ? "Loading samples…" : e.desc;
    if (pending) {
      const { bytes, rate } = player.downloads;
      const speed = rate ? ` at ${mb(rate)}/s` : "";
      const when = player.switchIn;
      desc =
        when === null
          ? `Getting ${ENGINES.find((x) => x.id === pending)!.label} ready: ${mb(bytes)} downloaded${speed}. Switching at the next phrase once enough is in.`
          : `${ENGINES.find((x) => x.id === pending)!.label} ready: switching in ${Math.ceil(when)} s.`;
    }
    $("engine-desc").textContent = desc;
    const credits = player.sampleCredits;
    const el = $("credits");
    el.hidden = !credits.length;
    if (credits.length) {
      el.textContent = `Sampled instruments (streamed from danigb/samples and gleitz/midi-js-soundfonts): ${credits.join(", ")}.`;
    }
  }
  chips.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    ev.preventDefault();
    const i = ENGINES.findIndex((x) => x.id === player.engine);
    const next = ENGINES[(i + (ev.key === "ArrowRight" ? 1 : ENGINES.length - 1)) % ENGINES.length]!;
    void player.setEngine(next.id);
    chipFor.get(next.id)?.focus();
    persist();
  });

  function shareUrl(): string {
    const u = new URL(location.href);
    u.search = "";
    u.searchParams.set("seed", seed);
    if (selected.size !== styles.length) u.searchParams.set("styles", [...selected].join(","));
    if (player.engine !== "fm") u.searchParams.set("sound", player.engine);
    return u.href;
  }

  function persist(): void {
    store.set("styles", [...selected].join(","));
    store.set("sound", player.engine);
    history.replaceState(null, "", shareUrl());
  }
  persist();
  $("seed").textContent = seed;
  $("share").addEventListener("click", (e) => {
    e.preventDefault();
    navigator.clipboard?.writeText(shareUrl()).then(
      () => toast("Link copied — same seed, same music"),
      () => toast(shareUrl()),
    );
  });

  // --- Transport ----------------------------------------------------------
  const playBtn = $<HTMLButtonElement>("play");
  const splash = $("splash");
  async function toggle(): Promise<void> {
    try {
      await player.toggle();
      splash.hidden = true;
    } catch (err) {
      console.error(err);
      toast(`Could not start audio: ${(err as Error).message}`);
    }
    render();
  }
  playBtn.addEventListener("click", toggle);
  $("splash-play").addEventListener("click", toggle);
  $("skip").addEventListener("click", () => {
    player.skip();
    if (!player.playing) void player.play().then(() => (splash.hidden = true));
  });
  const vol = $<HTMLInputElement>("volume");
  vol.value = String(volume);
  vol.addEventListener("input", () => {
    player.setVolume(Number(vol.value));
    store.set("volume", vol.value);
  });
  $("midi").addEventListener("click", () => {
    const bytes = player.exportMidi(10);
    if (!bytes) return toast("Nothing played yet");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/midi" }));
    a.download = `mindless-midi-${seed}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.mid`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") {
      e.preventDefault();
      void toggle();
    } else if (e.key === "n" || e.key === "N" || e.key === "ArrowRight") {
      player.skip();
    }
  });

  // --- Now playing --------------------------------------------------------
  let lastKey = "";
  function describe(tb: TimedBar | undefined): void {
    const nowStyle = $("now-style");
    const meta = $("now-meta");
    const chord = $("now-chord");
    if (!tb) {
      if (!player.started) return;
      meta.textContent = player.playing ? "…" : "paused";
      return;
    }
    const i = tb.bar.info;
    const key = `${i.pieceIndex}:${i.barInPiece}:${player.playing}`;
    if (key === lastKey) return;
    lastKey = key;
    nowStyle.textContent = i.styleTitle;
    nowStyle.style.setProperty("--swatch", byId.get(i.styleId)?.color ?? "");
    meta.textContent = i.gap
      ? "next piece coming up"
      : `${i.area ? `${i.area} · ` : ""}${i.keyName} · ${tb.bar.bpm} bpm${player.playing ? "" : " · paused"}`;
    $("prog-piece").textContent = `Piece ${i.pieceIndex + 1}`;
    $("prog-where").textContent = i.gap ? "" : `${i.section} · bar ${i.barInPiece + 1} of ${i.pieceBars}`;
    const tonic = i.tonic;
    chord.replaceChildren(
      ...i.chords.flatMap((sym, k) => {
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = chordName(tonic, sym);
        const roman = document.createElement("span");
        roman.className = "roman";
        roman.textContent = sym;
        const parts: Node[] = [name, roman];
        if (k > 0) {
          const sep = document.createElement("span");
          sep.className = "sep";
          sep.textContent = "→";
          parts.unshift(sep);
        }
        return parts;
      }),
    );
    $("progress").style.setProperty("--p", String((i.barInPiece + 1) / i.pieceBars));
    for (const [id, card] of cards) card.classList.toggle("playing", id === i.styleId);
    document.title = `${player.playing ? "▶" : "❚❚"} ${i.styleTitle} · Mindless Midi`;
    if ("mediaSession" in navigator && i.barInPiece === 0) updateMediaSession(i.styleTitle, i.keyName, i.pieceIndex);
  }

  function updateMediaSession(title: string, keyName: string, piece: number): void {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${title} — ${keyName}`,
      artist: "Mindless Midi",
      album: `Session ${seed}, piece ${piece + 1}`,
    });
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => void player.play());
    navigator.mediaSession.setActionHandler("pause", () => void player.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => player.skip());
  }

  function render(): void {
    $("play-glyph").textContent = player.playing ? "❚❚" : "▶";
    $("play-word").textContent = player.playing ? "Pause" : "Play";
    playBtn.setAttribute("aria-label", player.playing ? "Pause" : "Play");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = player.playing ? "playing" : "paused";
    lastKey = "";
    describe(player.current());
  }
  player.onChange(render);
  player.onChange(renderEngine);
  renderEngine();
  // Count down a queued switch.
  let wasBusy = false;
  setInterval(() => {
    const busy = player.pendingEngine !== null || player.loadProgress !== null;
    if (busy || wasBusy) renderEngine();
    wasBusy = busy;
  }, 200);
  // Cheap enough to poll; keeps the display in step with what is audible.
  setInterval(() => describe(player.current()), 200);
  render();
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin", `<p style="padding:16px;color:#d93a18">Failed to start: ${String(err)}</p>`);
});
