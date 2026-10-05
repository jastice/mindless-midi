/**
 * Synthesis bench: render the same score five ways (OPL3 today, OPL3 through
 * the new mix bus, DSP synths, samples, samples + neural lead), loudness-match
 * them, and A/B them sample-synchronously, optionally blind.
 */
import wasmUrl from "libadlmidi-js/dist/libadlmidi.nuked.browser.wasm";
import type { Role } from "../corpus/constants.js";
import type { StyleBundle } from "../corpus/schema.js";
import { spectrogram } from "./analysis.js";
import { type Stereo, yieldToUi } from "./dsp.js";
import { matchLoudness, wav } from "./loudness.js";
import { mixStems } from "./mix.js";
import { renderNeuralLead } from "./neural.js";
import { renderOpl } from "./opl.js";
import { SampleCache, type Soundfont, renderSampleStems } from "./sampler.js";
import { LEADS, type LeadId, type Score, buildScore } from "./score.js";
import { renderSynthStems } from "./synth.js";

type VariantId = "opl" | "opl_bus" | "synth" | "samples" | "neural";

interface Variant {
  id: VariantId;
  name: string;
  desc: string;
  status: "idle" | "queued" | "rendering" | "ready" | "error" | "n/a";
  progress: number;
  note: string;
  renderMs?: number;
  bytes?: number;
  lufs?: number;
  peakDb?: number;
  /** What plays now: the full mix or a solo. */
  mix?: Stereo;
  buffer?: AudioBuffer;
  peaks?: Float32Array;
  spec?: { key: string; img: ImageData };
  full?: { mix: Stereo; buffer: AudioBuffer };
  /** Pre-bus stems, for solos. */
  stems?: Map<Role, Stereo>;
  solos: Map<Role, { mix: Stereo; buffer: AudioBuffer }>;
}

const VARIANTS: Variant[] = [
  { id: "opl", name: "OPL3 FM (today)", desc: "The shipping path: libADLMIDI / Nuked OPL3 and the app's output stage, no mix bus." },
  { id: "opl_bus", name: "OPL3 + mix bus", desc: "The same FM, one stem per role, through the new mix bus. Separates production from instrument sound." },
  { id: "synth", name: "① DSP synths", desc: "Modal piano, FM e-piano, modal mallets, Karplus-Strong, PolyBLEP subtractive voices, analog kit. Zero downloads." },
  { id: "samples", name: "② Samples", desc: "Splendid Grand, jRhodes, VCSL mallets & sax, Smolken upright, GM soundfont fallback, drum-machine kits." },
  { id: "neural", name: "③ Samples + neural lead", desc: "Magenta DDSP lead (performed pitch & loudness curves, WebGL) over the sampled bed." },
].map((v) => ({ ...v, status: "idle", progress: 0, note: "", solos: new Map() }) as Variant);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`mm-bench:${key}`);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`mm-bench:${key}`, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  },
};

type Ratings = Record<string, number>;

async function main(): Promise<void> {
  const res = await fetch(new URL("styles.json", document.baseURI));
  const { styles } = (await res.json()) as { styles: StyleBundle[] };
  const byId = new Map(styles.map((s) => [s.id, s]));
  const ctx = new AudioContext({ latencyHint: "playback" });
  const sr = ctx.sampleRate;
  const cache = new SampleCache(ctx);
  const wasmBytes = fetch(new URL(wasmUrl, import.meta.url)).then((r) => r.arrayBuffer()).then((b) => b.byteLength);

  // --- Controls -----------------------------------------------------------
  const styleSel = $<HTMLSelectElement>("style");
  for (const s of styles) styleSel.append(new Option(s.corpus.title, s.id));
  const leadSel = $<HTMLSelectElement>("lead");
  leadSel.append(new Option("Corpus instrument", ""));
  for (const [id, l] of Object.entries(LEADS)) leadSel.append(new Option(l.label, id));
  const params = new URLSearchParams(location.search);
  styleSel.value = params.get("style") ?? store.get("style", "minimalist");
  $<HTMLInputElement>("seed").value = params.get("seed") ?? store.get("seed", "bench-1");
  $<HTMLSelectElement>("seconds").value = params.get("seconds") ?? store.get("seconds", "40");
  $<HTMLSelectElement>("font").value = store.get("font", "MusyngKite");
  // Default: the corpus instrument, so every track plays as written.
  leadSel.value = params.get("lead") ?? "";
  $("dice").addEventListener("click", () => {
    $<HTMLInputElement>("seed").value = Math.random().toString(36).slice(2, 8);
  });

  // --- Variant rows ---------------------------------------------------------
  let blind = false;
  let order = VARIANTS.map((_, i) => i);
  let selected = 0;
  const list = $("variants");
  const rows: HTMLElement[] = [];
  const ratings = (): Ratings => store.get<Ratings>("ratings", {});
  const ratingKey = (v: Variant) => `${score?.style.id}|${score?.lead ?? "-"}|${$<HTMLInputElement>("seed").value}|${v.id}`;

  const renderRows = () => {
    list.replaceChildren();
    rows.length = 0;
    order.forEach((vi, slot) => {
      const v = VARIANTS[vi]!;
      const row = document.createElement("div");
      row.className = "variant";
      row.dataset.status = v.status;
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      if (vi === selected) row.classList.add("on");
      const stars = ratings()[ratingKey(v)] ?? 0;
      const stats = v.status === "ready" && !blind
        ? [
            `${fmtMs(v.renderMs!)} render`,
            `${((score!.seconds * 1000) / v.renderMs!).toFixed(1)}× realtime`,
            fmtBytes(v.bytes ?? 0),
            `${v.lufs!.toFixed(1)} LUFS raw`,
          ]
        : [];
      row.innerHTML = `
        <span class="key">${slot + 1}</span>
        <span class="body">
          <span class="name"></span>
          <span class="desc"></span>
          <span class="stats"></span>
          <span class="bar"><span style="width:${Math.round(v.progress * 100)}%"></span></span>
        </span>
        <span class="side">
          <span class="stars" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${n <= stars ? "lit" : ""}" aria-label="${n} star">★</button>`).join("")}</span>
          <button type="button" class="wav" ${v.status === "ready" ? "" : "disabled"} title="Download WAV">WAV</button>
        </span>`;
      row.querySelector(".name")!.textContent = blind ? `Mystery ${slot + 1}` : v.name;
      row.querySelector(".desc")!.textContent = blind ? statusText(v) : v.note ? `${statusText(v)} · ${v.note}` : v.status === "ready" ? v.desc : `${statusText(v)} · ${v.desc}`;
      row.querySelector(".stats")!.textContent = stats.join(" · ");
      row.addEventListener("click", (e) => {
        const star = (e.target as HTMLElement).closest<HTMLElement>("[data-star]");
        if (star) {
          const r = ratings();
          r[ratingKey(v)] = Number(star.dataset.star);
          store.set("ratings", r);
          renderRows();
          renderBoard();
          return;
        }
        if ((e.target as HTMLElement).closest(".wav")) return download(v);
        select(vi);
      });
      list.append(row);
      rows.push(row);
    });
  };

  const statusText = (v: Variant) =>
    ({ idle: "not rendered", queued: "queued", rendering: `rendering ${Math.round(v.progress * 100)}%`, ready: "ready", error: "failed", "n/a": "n/a" })[v.status];

  const renderBoard = () => {
    const r = ratings();
    const board = $("board");
    const style = styleSel.value;
    const rowsHtml = VARIANTS.map((v) => {
      const mine = Object.entries(r).filter(([k]) => k.startsWith(`${style}|`) && k.endsWith(`|${v.id}`)).map(([, s]) => s);
      const all = Object.entries(r).filter(([k]) => k.endsWith(`|${v.id}`)).map(([, s]) => s);
      const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : "–");
      return `<tr><td>${v.name}</td><td>${avg(mine)} <small>(${mine.length})</small></td><td>${avg(all)} <small>(${all.length})</small></td></tr>`;
    }).join("");
    board.innerHTML = `<table><thead><tr><th>Variant</th><th>This style</th><th>All styles</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  };

  // --- Playback -------------------------------------------------------------
  let sources: { src: AudioBufferSourceNode; gain: GainNode; vi: number }[] = [];
  let playing = false;
  let startedAt = 0;
  let offset = 0;
  const duration = () => VARIANTS.find((v) => v.buffer)?.buffer?.duration ?? 0;
  const position = () => (playing ? Math.min(duration(), offset + ctx.currentTime - startedAt) : offset);

  const startSource = (vi: number, when: number, at: number) => {
    const v = VARIANTS[vi]!;
    if (!v.buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = v.buffer;
    const gain = ctx.createGain();
    gain.gain.value = vi === selected ? 1 : 0;
    src.connect(gain).connect(ctx.destination);
    src.start(when, at);
    sources.push({ src, gain, vi });
  };
  const stopAll = () => {
    for (const s of sources) s.src.stop();
    sources = [];
  };
  const play = async (at = position()) => {
    await ctx.resume();
    stopAll();
    if (at >= duration() - 0.05) at = 0;
    const when = ctx.currentTime + 0.03;
    VARIANTS.forEach((_, vi) => startSource(vi, when, at));
    startedAt = when;
    offset = at;
    playing = true;
    $("play").textContent = "❚❚ Pause";
  };
  const pause = () => {
    offset = position();
    stopAll();
    playing = false;
    $("play").textContent = "▶ Play";
  };
  const select = (vi: number) => {
    selected = vi;
    for (const s of sources) s.gain.gain.setTargetAtTime(s.vi === vi ? 1 : 0, ctx.currentTime, 0.008);
    renderRows();
    drawWave();
  };
  const seek = (t: number) => {
    if (playing) void play(t);
    else offset = t;
  };
  $("play").addEventListener("click", () => (playing ? pause() : void play()));

  // --- Waveform ---------------------------------------------------------------
  const canvas = $<HTMLCanvasElement>("wave");
  const viewSel = $<HTMLSelectElement>("view");
  viewSel.addEventListener("change", () => drawWave());
  const drawWave = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d")!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue("--wave-bg");
    g.fillRect(0, 0, w, h);
    const v = VARIANTS[selected]!;
    if (v.mix && viewSel.value === "spec") {
      const key = `${canvas.width}x${canvas.height}`;
      if (v.spec?.key !== key) v.spec = { key, img: spectrogram(v.mix, sr, canvas.width, canvas.height, rgb(css.getPropertyValue("--accent")), rgb(css.getPropertyValue("--wave-bg"))) };
      g.putImageData(v.spec.img, 0, 0);
    } else if (v.mix) {
      if (!v.peaks || v.peaks.length !== w) v.peaks = peaks(v.mix, w);
      g.fillStyle = css.getPropertyValue("--wave");
      for (let x = 0; x < w; x++) {
        const p = v.peaks[x]! * (h / 2 - 2);
        g.fillRect(x, h / 2 - p, 1, Math.max(1, p * 2));
      }
    }
    const d = duration();
    if (d) {
      const x = (position() / d) * w;
      g.fillStyle = viewSel.value === "spec" ? css.getPropertyValue("--text") : css.getPropertyValue("--accent");
      g.fillRect(x, 0, 2, h);
    }
    $("time").textContent = `${fmtTime(position())} / ${fmtTime(d)}`;
  };
  const tick = () => {
    if (playing && position() >= duration()) pause();
    drawWave();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * duration());
  });

  // --- Keyboard -----------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === "Space") {
      e.preventDefault();
      playing ? pause() : void play();
    } else if (/^Digit[1-5]$/.test(e.code)) {
      const slot = Number(e.code.slice(5)) - 1;
      if (order[slot] !== undefined) select(order[slot]!);
    } else if (e.code === "ArrowRight") seek(Math.min(duration(), position() + 5));
    else if (e.code === "ArrowLeft") seek(Math.max(0, position() - 5));
  });

  // --- Blind mode -----------------------------------------------------------------
  const blindBox = $<HTMLInputElement>("blind");
  blindBox.addEventListener("change", () => {
    blind = blindBox.checked;
    order = VARIANTS.map((_, i) => i);
    if (blind) for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    document.body.classList.toggle("blind", blind);
    renderRows();
  });

  // --- Solo a role -------------------------------------------------------------------
  const soloSel = $<HTMLSelectElement>("solo");
  const toBuffer = (m: Stereo) => {
    const buf = ctx.createBuffer(2, m.l.length, sr);
    buf.copyToChannel(m.l, 0);
    buf.copyToChannel(m.r, 1);
    return buf;
  };
  /** Point a variant at its full mix or at one role through the same bus, loudness-matched. */
  const applySoloTo = async (v: Variant) => {
    if (v.status !== "ready" || !v.full || !score) return;
    const role = soloSel.value as Role | "";
    let target = v.full;
    if (role) {
      let hit = v.solos.get(role);
      if (!hit) {
        // Today's path has no bus: its solo is the dry FM stem.
        const raw = v.id === "opl" ? VARIANTS.find((x) => x.id === "opl_bus")?.stems?.get(role) : v.stems?.get(role);
        if (!raw) return;
        const mix = v.id === "opl" ? { l: raw.l.slice(), r: raw.r.slice() } : await mixStems(new Map([[role, raw]]), score, sr);
        matchLoudness(mix, sr);
        hit = { mix, buffer: toBuffer(mix) };
        v.solos.set(role, hit);
      }
      target = hit;
    }
    v.mix = target.mix;
    v.buffer = target.buffer;
    v.peaks = undefined;
    v.spec = undefined;
  };
  soloSel.addEventListener("change", async () => {
    const at = position();
    const was = playing;
    if (was) pause();
    for (const v of VARIANTS) await applySoloTo(v);
    offset = at;
    if (was) void play(at);
    drawWave();
  });

  // --- Rendering --------------------------------------------------------------------
  let score: Score | null = null;
  let token = 0;

  const download = (v: Variant) => {
    if (!v.mix) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(wav(v.mix, sr));
    a.download = `${score?.style.id}-${$<HTMLInputElement>("seed").value}-${v.id}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const render = async () => {
    const my = ++token;
    pause();
    offset = 0;
    const style = byId.get(styleSel.value)!;
    const seed = $<HTMLInputElement>("seed").value || "bench-1";
    const seconds = Number($<HTMLSelectElement>("seconds").value);
    const lead = (leadSel.value || null) as LeadId | null;
    const font = $<HTMLSelectElement>("font").value as Soundfont;
    store.set("style", style.id);
    store.set("seed", seed);
    store.set("seconds", String(seconds));
    store.set("font", font);
    history.replaceState(null, "", `?style=${style.id}&seed=${encodeURIComponent(seed)}&seconds=${seconds}&lead=${lead ?? ""}`);
    for (const v of VARIANTS) Object.assign(v, { status: "queued", progress: 0, note: "", mix: undefined, buffer: undefined, peaks: undefined, spec: undefined, full: undefined, stems: undefined, solos: new Map(), renderMs: undefined, bytes: undefined });
    score = buildScore(style, seed, seconds, lead);
    const s = score;
    const inst = [...s.instruments.values()].filter((i) => s.notes.some((n) => n.role === i.role)).map((i) => `${i.role}: ${i.name}`);
    $("summary").textContent = `${s.summary} — ${inst.join(" · ")}`;
    const keep = soloSel.value;
    soloSel.replaceChildren(new Option("Full mix", ""), ...[...new Set(s.notes.map((n) => n.role))].map((r) => new Option(`Solo ${r}`, r)));
    soloSel.value = [...soloSel.options].some((o) => o.value === keep) ? keep : "";
    renderRows();
    renderBoard();

    let sampleStems: Map<Role, Stereo> | null = null;
    const run = async (id: VariantId, fn: (progress: (f: number) => void) => Promise<{ mix: Stereo; bytes: number; ms?: number; note?: string; stems?: Map<Role, Stereo> } | null>) => {
      if (my !== token) return;
      const v = VARIANTS.find((x) => x.id === id)!;
      v.status = "rendering";
      renderRows();
      await yieldToUi();
      const t0 = performance.now();
      try {
        const out = await fn((f) => {
          v.progress = f;
          const row = rows[order.indexOf(VARIANTS.indexOf(v))];
          const bar = row?.querySelector<HTMLElement>(".bar > span");
          if (bar) bar.style.width = `${Math.round(f * 100)}%`;
        });
        if (my !== token) return;
        if (!out) {
          v.status = "n/a";
          v.note = "pick a Lead instrument to try the DDSP model";
        } else {
          v.renderMs = out.ms ?? performance.now() - t0;
          v.bytes = out.bytes;
          const m = matchLoudness(out.mix, sr);
          v.lufs = m.lufs;
          v.peakDb = m.peakDb;
          v.note = out.note ?? "";
          v.full = { mix: out.mix, buffer: toBuffer(out.mix) };
          v.mix = v.full.mix;
          v.buffer = v.full.buffer;
          v.stems = out.stems;
          v.status = "ready";
          v.progress = 1;
          await applySoloTo(v);
          if (playing) startSource(VARIANTS.indexOf(v), ctx.currentTime, position());
        }
      } catch (err) {
        console.error(id, err);
        v.status = "error";
        v.note = String(err instanceof Error ? err.message : err);
      }
      renderRows();
      drawWave();
    };

    await run("opl", async () => ({ mix: await renderOpl(s, sr, new URL(wasmUrl, import.meta.url).href, { leveler: true }), bytes: await wasmBytes }));
    await run("opl_bus", async (p) => {
      const roles = [...new Set(s.notes.map((n) => n.role))];
      const stems = new Map<Role, Stereo>();
      for (const [i, role] of roles.entries()) {
        stems.set(role, await renderOpl(s, sr, new URL(wasmUrl, import.meta.url).href, { role }));
        p((i + 1) / (roles.length + 1));
      }
      return { mix: await mixStems(stems, s, sr), bytes: await wasmBytes, stems };
    });
    await run("synth", async (p) => {
      const stems = await renderSynthStems(s, sr, p);
      return { mix: await mixStems(stems, s, sr), bytes: 0, stems };
    });
    await run("samples", async (p) => {
      const { stems, report } = await renderSampleStems(s, sr, cache, font, [], p);
      sampleStems = stems;
      return { mix: await mixStems(stems, s, sr), bytes: report.bytes, stems, note: `${report.files} files: ${report.instruments.join(", ")}` };
    });
    await run("neural", async (p) => {
      if (!s.lead) return null;
      if (!sampleStems) throw new Error("needs the sampled bed");
      const line = s.notes.filter((n) => n.role === "lead");
      const t0 = performance.now();
      const { stem, report } = await renderNeuralLead(line, s.seconds, s.lead, sr, p);
      const frames = sampleStems.values().next().value!.l.length;
      const fit = (x: Float32Array) => {
        const y = new Float32Array(frames);
        y.set(x.subarray(0, frames));
        return y;
      };
      const stems = new Map(sampleStems);
      stems.set("lead", { l: fit(stem.l), r: fit(stem.r) });
      const mix = await mixStems(stems, s, sr);
      const ms = performance.now() - t0;
      return { mix, bytes: report.bytes, ms, stems, note: `DDSP ${LEADS[s.lead].label}: ${fmtMs(report.inferMs)} inference` };
    });
  };
  $("render").addEventListener("click", () => void render());

  renderRows();
  renderBoard();
  window.addEventListener("resize", drawWave);
  Object.assign(window, { bench: { VARIANTS, get score() { return score; }, render, select, play, pause } });
}

function peaks(s: Stereo, w: number): Float32Array {
  const out = new Float32Array(w);
  const per = Math.max(1, Math.floor(s.l.length / w));
  for (let x = 0; x < w; x++) {
    let p = 0;
    for (let i = x * per; i < (x + 1) * per && i < s.l.length; i++) p = Math.max(p, Math.abs(s.l[i]!), Math.abs(s.r[i]!));
    out[x] = p;
  }
  return out;
}

function rgb(hex: string): [number, number, number] {
  const m = /#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [128, 128, 128];
}

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtBytes = (b: number) => (b === 0 ? "0 B" : b < 1e6 ? `${(b / 1e3).toFixed(0)} kB` : `${(b / 1e6).toFixed(1)} MB`);
const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

main().catch((err) => {
  console.error(err);
  document.body.prepend(Object.assign(document.createElement("pre"), { textContent: String(err), className: "fatal" }));
});
