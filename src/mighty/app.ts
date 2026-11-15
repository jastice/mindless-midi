/**
 * Mighty Midi: the same endless, seeded music as Mindless Midi, played for
 * weight. It shares the arranger, the corpora and the engines; what differs is
 * how the notes are performed (velocity range, slides, swells, chokes) and
 * mixed (a kick-driven, low-end-aware mix that keeps the dynamics). Everything
 * it adds still fits in a MIDI file, so the download is the piece.
 */
import wasmUrl from "libadlmidi-js/dist/libadlmidi.nuked.browser.wasm";
import { mediaAnchor } from "../app/media_anchor.js";
import { EXPRESSION, type Engine, Player, type Position, type TimedBar } from "../app/player.js";
import type { StyleBundle } from "../corpus/schema.js";
import { randomSeed } from "../theory/seed.js";
import { chordName } from "../theory/theory.js";
import { Stage } from "./stage.js";

const ENGINES: { id: Engine; label: string; tag: string; desc: string }[] = [
  { id: "synth", label: "Synth", tag: "Modelled, nothing to download", desc: "Modelled instruments. A harder note is brighter and snappier, lines glide, long notes swell." },
  { id: "samples", label: "Samples", tag: "Recorded, a few MB per style", desc: "Recorded instruments, downloaded as the music needs them. Hard hits use the harder recordings; soft notes are darker." },
  { id: "fm_bus", label: "Chip", tag: "OPL3 FM, one chip per part", desc: "The FM chip from Mindless Midi, with real pitch bends and volume swells, through the same heavy mix." },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`mighty-midi:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`mighty-midi:${key}`, value);
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

  // The URL is the session (seed, place, styles, sound); a bare visit resumes the last one.
  const params = new URLSearchParams(location.search);
  const linked = params.get("seed");
  const savedSeed = linked ? null : store.get("seed");
  const seed = linked || savedSeed || randomSeed();
  const at = parseAt(linked ? params.get("at") : savedSeed ? store.get("at") : null);
  const wanted = (params.get("styles") ?? (linked ? "" : store.get("styles")) ?? "").split(",").filter((id) => byId.has(id));
  const selected = new Set(wanted.length ? wanted : styles.map((s) => s.id));
  const volume = Number(store.get("volume") ?? "0.8");
  const wantedEngine = params.get("sound") ?? store.get("sound") ?? "synth";
  const engine: Engine = ENGINES.some((e) => e.id === wantedEngine) ? (wantedEngine as Engine) : "synth";

  const player = new Player(
    styles.filter((s) => selected.has(s.id)),
    {
      seed,
      ...(at && { at }),
      engine,
      // The plain chip is not offered here; the stem engines never load this.
      processorUrl: new URL("worklet.js", import.meta.url).href,
      wasmUrl: new URL(wasmUrl, import.meta.url).href,
      stemWorkletUrl: new URL("stem-worklet.js", import.meta.url).href,
      workerUrl: new URL("render-worker.js", import.meta.url).href,
      expression: EXPRESSION,
      weighted: true,
      title: "Mighty Midi",
    },
  );
  player.setVolume(volume);
  Object.assign(window, { mightyMidi: { player, styles } });
  new Stage($<HTMLCanvasElement>("stage"), player).start();

  // --- Styles -------------------------------------------------------------
  const cards = new Map<string, HTMLButtonElement>();
  for (const s of styles) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "style";
    card.style.setProperty("--swatch", s.color);
    card.setAttribute("aria-pressed", String(selected.has(s.id)));
    card.title = s.corpus.description;
    card.textContent = s.corpus.title;
    card.addEventListener("click", () => {
      if (selected.has(s.id)) {
        if (selected.size === 1) return toast("Keep at least one style");
        selected.delete(s.id);
      } else selected.add(s.id);
      card.setAttribute("aria-pressed", String(selected.has(s.id)));
      player.setStyles(styles.filter((x) => selected.has(x.id)));
      layoutKey = "";
      renderWhere();
      remember();
    });
    cards.set(s.id, card);
    $("styles").append(card);
  }
  const setAll = (on: boolean) => {
    const keep = on ? null : (player.current()?.bar.info.styleId ?? [...selected][0]!);
    for (const s of styles) {
      if (on || s.id === keep) selected.add(s.id);
      else selected.delete(s.id);
      cards.get(s.id)!.setAttribute("aria-pressed", String(selected.has(s.id)));
    }
    player.setStyles(styles.filter((x) => selected.has(x.id)));
    remember();
  };
  $("all").addEventListener("click", () => setAll(true));
  $("only").addEventListener("click", () => setAll(false));

  // --- Sound --------------------------------------------------------------
  const chipFor = new Map<Engine, HTMLButtonElement>();
  for (const e of ENGINES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "engine";
    chip.setAttribute("role", "radio");
    chip.innerHTML = `<span class="nm"></span><span class="tag"></span><span class="fill" aria-hidden="true"></span>`;
    chip.querySelector(".nm")!.textContent = e.label;
    chip.querySelector(".tag")!.textContent = e.tag;
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
      desc = when === null ? `Getting ${label} ready: ${mb(bytes)} down${rate ? ` at ${mb(rate)}/s` : ""}. It takes over at the next phrase.` : `${label} takes over in ${Math.ceil(when)} s.`;
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
    const next = ENGINES[(i + (ev.key === "ArrowRight" ? 1 : ENGINES.length - 1)) % ENGINES.length]!;
    void player.setEngine(next.id);
    chipFor.get(next.id)?.focus();
    remember();
  });

  // --- Session ------------------------------------------------------------
  function shareUrl(): string {
    const u = new URL(location.href);
    u.search = "";
    u.searchParams.set("seed", player.seed);
    const here = player.position();
    if (here.piece || here.bar) u.searchParams.set("at", formatAt(here));
    if (selected.size !== styles.length) u.searchParams.set("styles", [...selected].join(","));
    if (player.engine !== "synth") u.searchParams.set("sound", player.engine);
    return u.href;
  }
  function remember(): void {
    store.set("styles", [...selected].join(","));
    store.set("sound", player.engine);
    persist();
  }
  function persist(): void {
    if (player.started) {
      store.set("seed", player.seed);
      store.set("at", formatAt(player.position()));
    }
    history.replaceState(null, "", shareUrl());
  }
  persist();
  addEventListener("pagehide", persist);
  $("seed").textContent = seed;
  $("share").addEventListener("click", () => {
    navigator.clipboard?.writeText(shareUrl()).then(
      () => toast("Link copied: same seed, same place"),
      () => toast(shareUrl()),
    );
  });

  // --- Transport ----------------------------------------------------------
  const playBtn = $<HTMLButtonElement>("play");
  const holdMedia = mediaAnchor();
  async function toggle(): Promise<void> {
    if (!player.playing) holdMedia(true); // inside the click, before any await
    try {
      await player.toggle();
      $("curtain").hidden = true;
    } catch (err) {
      console.error(err);
      toast(`Could not start audio: ${(err as Error).message}`);
    }
    render();
  }
  playBtn.addEventListener("click", toggle);
  $("curtain").addEventListener("click", toggle);
  function jump(move: () => void): void {
    move();
    renderWhere();
    renderCurtain();
    persist();
  }
  $("next").addEventListener("click", () => {
    jump(() => player.stepPiece(1));
    if (!player.playing) void toggle();
  });
  $("back").addEventListener("click", () => jump(() => player.step(-1)));
  $("on").addEventListener("click", () => jump(() => player.step(1)));
  const vol = $<HTMLInputElement>("volume");
  vol.value = String(volume);
  vol.addEventListener("input", () => {
    player.setVolume(Number(vol.value));
    store.set("volume", vol.value);
  });
  $("reseed").addEventListener("click", () => {
    jump(() => player.reseed(randomSeed()));
    $("seed").textContent = player.seed;
    lastKey = "";
    toast(`New seed: ${player.seed}`);
  });
  $("midi").addEventListener("click", () => {
    const bytes = player.exportMidi(10);
    if (!bytes) return toast("Nothing played yet");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/midi" }));
    a.download = `mighty-midi-${player.seed}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.mid`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.repeat || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") {
      e.preventDefault();
      void toggle();
    } else if (e.key === "n" || e.key === "N") jump(() => player.stepPiece(1));
    else if (e.key === "ArrowRight") jump(() => player.step(1));
    else if (e.key === "ArrowLeft") jump(() => player.step(-1));
  });
  function renderCurtain(): void {
    const here = player.position();
    const resuming = here.piece > 0 || here.bar > 0;
    $("curtain-word").textContent = resuming ? "Continue" : "Play";
    $("curtain-note").textContent = resuming ? `Picks up at piece ${here.piece + 1}, bar ${here.bar + 1}.` : "Composed and played in this tab. Nothing is streamed.";
  }
  renderCurtain();

  // --- Where in the piece: one block per section, click to jump ------------
  const map = $("map");
  let layoutKey = "";
  let shownWhere = "";
  function renderWhere(): void {
    const s = player.segment();
    const key = `${player.seed}/${s.piece}`;
    if (key !== layoutKey) {
      layoutKey = key;
      const layout = player.layout(s.piece) ?? [];
      map.replaceChildren(
        ...layout.map((seg, i) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "seg";
          b.style.flexGrow = String(seg.bars);
          b.title = `Jump to ${seg.label}`;
          b.setAttribute("aria-label", `Section ${i + 1} of ${layout.length}: ${seg.label}`);
          b.innerHTML = "<span></span>";
          b.querySelector("span")!.textContent = seg.label;
          b.addEventListener("click", () => jump(() => player.goTo(s.piece, i)));
          return b;
        }),
      );
      shownWhere = "";
    }
    const where = `${s.index}/${player.seeking}`;
    if (where === shownWhere) return;
    shownWhere = where;
    [...map.children].forEach((el, i) => {
      el.classList.toggle("here", i === s.index);
      el.classList.toggle("done", i < s.index);
      el.classList.toggle("seeking", i === s.index && player.seeking);
    });
    $("place").textContent = `${s.piece + 1}.${s.index + 1}`;
  }

  // --- Now playing --------------------------------------------------------
  let lastKey = "";
  function describe(tb: TimedBar | undefined): void {
    if (!tb) {
      if (player.started) $("now-meta").textContent = player.playing ? "…" : "Paused";
      return;
    }
    const i = tb.bar.info;
    const key = `${i.pieceSeed}:${i.barInPiece}:${player.playing}`;
    if (key === lastKey) return;
    lastKey = key;
    persist();
    $("now-style").textContent = i.styleTitle;
    $("now-style").style.setProperty("--swatch", byId.get(i.styleId)?.color ?? "");
    $("now-meta").textContent = i.gap
      ? "Next piece coming up"
      : `${i.area ? `${i.area} · ` : ""}${i.keyName} · ${tb.bar.beats}/4 · ${tb.bar.bpm} bpm · ${i.section}, bar ${i.barInPiece + 1} of ${i.pieceBars}${player.playing ? "" : " · paused"}`;
    $("now-chord").textContent = i.chords.map((sym) => chordName(i.tonic, sym)).join("  →  ");
    $("lean").style.setProperty("--v", String(i.gap ? 0 : i.intensity));
    $("lean-n").textContent = i.gap ? "" : `${Math.round(i.intensity * 100)}`;
    for (const [id, card] of cards) card.classList.toggle("playing", id === i.styleId);
    document.title = `${player.playing ? "▶" : "❚❚"} ${i.styleTitle} · Mighty Midi`;
    if ("mediaSession" in navigator && i.barInPiece === 0) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: `${i.styleTitle} · ${i.keyName}`, artist: "Mighty Midi", album: `Session ${player.seed}, piece ${i.pieceIndex + 1}` });
    }
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => void player.play());
    navigator.mediaSession.setActionHandler("pause", () => void player.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => jump(() => player.stepPiece(-1)));
    navigator.mediaSession.setActionHandler("nexttrack", () => jump(() => player.stepPiece(1)));
  }

  // --- Meters: peak over body (crest) and the share of energy under 100 Hz ----
  const time = new Float32Array(2048);
  let spectrum: Float32Array<ArrayBuffer> | null = null;
  let peakHold = 0;
  let body = 0;
  let low = 0;
  let metered = 0;
  function meters(t: number): void {
    requestAnimationFrame(meters);
    const a = player.playing ? player.analyser : null;
    const dt = Math.min(0.1, (t - metered) / 1000);
    metered = t;
    let peak = 0;
    let ms = 0;
    if (a) {
      a.getFloatTimeDomainData(time);
      for (const x of time) {
        peak = Math.max(peak, Math.abs(x));
        ms += x * x;
      }
      ms /= time.length;
      spectrum ??= new Float32Array(a.frequencyBinCount);
      a.getFloatFrequencyData(spectrum);
      const hz = a.context.sampleRate / a.fftSize;
      let under = 0;
      let all = 0;
      for (let k = 1; k < spectrum.length; k++) {
        const p = Math.pow(10, spectrum[k]! / 10);
        all += p;
        if (k * hz < 100) under += p;
      }
      if (all > 0) low += (under / all - low) * Math.min(1, dt / 1.5);
    }
    // The peak falls back over a few seconds; the body is the level over about a second.
    peakHold = Math.max(peak, peakHold * Math.exp(-dt / 2.5));
    body += (ms - body) * Math.min(1, dt / 1);
    const rms = Math.sqrt(body);
    const bar = (x: number) => String(Math.max(0, Math.min(1, 1 + (20 * Math.log10(Math.max(x, 1e-5))) / 48)));
    $("m-peak").style.setProperty("--v", bar(peakHold));
    $("m-body").style.setProperty("--v", bar(rms));
    $("m-low").style.setProperty("--v", String(a ? Math.min(1, low * 1.4) : 0));
    const quiet = !a || rms < 1e-4;
    $("m-crest").textContent = quiet ? "–" : `${(20 * Math.log10(peakHold / rms)).toFixed(0)} dB`;
    $("m-low-n").textContent = quiet ? "–" : `${Math.round(low * 100)}%`;
  }
  requestAnimationFrame(meters);

  function render(): void {
    $("play-glyph").textContent = player.playing ? "❚❚" : "▶";
    playBtn.setAttribute("aria-label", player.playing ? "Pause" : "Play");
    document.documentElement.classList.toggle("playing", player.playing);
    holdMedia(player.playing);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = player.playing ? "playing" : "paused";
    lastKey = "";
    describe(player.current());
    renderWhere();
  }
  player.onChange(render);
  player.onChange(renderEngine);
  renderEngine();
  setInterval(() => {
    describe(player.current());
    renderWhere();
    if (player.pendingEngine !== null || player.loadProgress !== null) renderEngine();
  }, 200);
  render();
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin", `<p style="padding:16px;color:#ff5b2e">Failed to start: ${String(err)}</p>`);
});
