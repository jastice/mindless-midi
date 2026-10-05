/**
 * Page wiring: style picker, transport, now-playing, Media Session, and
 * persistence of the listener's choices (URL for sharing, localStorage for
 * convenience).
 */
import wasmUrl from "libadlmidi-js/dist/libadlmidi.nuked.browser.wasm";
import type { StyleBundle } from "../corpus/schema.js";
import { chordName } from "../theory/theory.js";
import { type Engine, Player, type TimedBar } from "./player.js";

const ENGINES: { id: Engine; label: string; desc: string }[] = [
  { id: "fm", label: "FM chip", desc: "An emulated OPL3 FM chip with classic DOS-era patch banks. The original beepy-boopy sound." },
  { id: "fm_bus", label: "FM + studio", desc: "The same chip, one track per instrument, mixed with reverb, echo, ducking and tape." },
  { id: "synth", label: "Synth", desc: "Modelled instruments (struck strings, plucks, analog voices), mixed in the studio. Nothing to download." },
  { id: "samples", label: "Samples", desc: "Recorded instruments, downloaded as the music needs them (a few MB per style), mixed in the studio." },
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

function randomSeed(): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(36)).join("").slice(0, 10);
}

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
  for (const s of styles) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "style-card";
    card.style.setProperty("--swatch", s.color);
    card.setAttribute("aria-pressed", String(selected.has(s.id)));
    card.innerHTML = `<span class="check" aria-hidden="true"></span><span><span class="title"></span><span class="desc"></span></span>`;
    card.querySelector(".title")!.textContent = s.corpus.title;
    card.querySelector(".desc")!.textContent = s.corpus.description;
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
  for (const e of ENGINES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.setAttribute("role", "radio");
    chip.textContent = e.label;
    chip.title = e.desc;
    chip.addEventListener("click", () => {
      void player.setEngine(e.id);
      persist();
    });
    chipFor.set(e.id, chip);
    chips.append(chip);
  }
  function renderEngine(): void {
    for (const [id, chip] of chipFor) {
      chip.setAttribute("aria-checked", String(id === player.engine));
      chip.tabIndex = id === player.engine ? 0 : -1;
    }
    const e = ENGINES.find((x) => x.id === player.engine)!;
    $("engine-desc").textContent = player.loading ? "Loading samples…" : e.desc;
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
    nowStyle.style.color = byId.get(i.styleId)?.color ?? "";
    meta.textContent = i.gap
      ? "next piece coming up"
      : `${i.area ? `${i.area} · ` : ""}${i.keyName} · ${tb.bar.bpm} bpm · ${i.section} · bar ${i.barInPiece + 1}/${i.pieceBars}${player.playing ? "" : " · paused"}`;
    const tonic = i.tonic;
    chord.replaceChildren(
      ...i.chords.flatMap((sym, k) => {
        const name = document.createElement("span");
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
    $("progress").style.width = `${((i.barInPiece + 1) / i.pieceBars) * 100}%`;
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
    playBtn.textContent = player.playing ? "❚❚ Pause" : "▶ Play";
    playBtn.setAttribute("aria-label", player.playing ? "Pause" : "Play");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = player.playing ? "playing" : "paused";
    lastKey = "";
    describe(player.current());
  }
  player.onChange(render);
  player.onChange(renderEngine);
  renderEngine();
  // Cheap enough to poll; keeps the display in step with what is audible.
  setInterval(() => describe(player.current()), 200);
  render();
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin", `<p style="padding:16px;color:#fc8181">Failed to start: ${String(err)}</p>`);
});
