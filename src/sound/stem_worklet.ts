/**
 * AudioWorklet that plays streamed stems: one stereo output per role, fed by
 * the render worker in bar-sized chunks stamped with their absolute start
 * frame. Ticks the main thread like the OPL processor, so scheduling keeps
 * going in background tabs.
 */
import { STEM_PROCESSOR, type FromStems, type ToStems } from "./protocol.js";

declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

interface Chunk {
  start: number;
  end: number;
  roles: number[];
  data: Float32Array[];
}

class StemProcessor extends AudioWorkletProcessor {
  private chunks: Chunk[] = [];
  private blocks = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ type: "port"; port: MessagePort }>) => {
      if (e.data.type === "port") e.data.port.onmessage = (m: MessageEvent<ToStems>) => this.onStems(m.data);
    };
  }

  private onStems(msg: ToStems): void {
    if (msg.type === "pcm") {
      this.chunks.push({ start: msg.start, end: msg.start + msg.frames, roles: msg.roles, data: msg.data });
      this.chunks.sort((a, b) => a.start - b.start);
    } else {
      this.chunks = this.chunks.filter((c) => c.start < msg.from);
      for (const c of this.chunks) c.end = Math.min(c.end, msg.from);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const n = outputs[0]?.[0]?.length ?? 128;
    const from = currentFrame;
    const to = from + n;
    while (this.chunks.length && this.chunks[0]!.end <= from) this.chunks.shift();
    for (const c of this.chunks) {
      if (c.start >= to) break;
      const a = Math.max(from, c.start);
      const b = Math.min(to, c.end);
      c.roles.forEach((role, k) => {
        const out = outputs[role];
        if (!out) return;
        const l = c.data[k * 2]!;
        const r = c.data[k * 2 + 1]!;
        const ol = out[0]!;
        const or = out[1] ?? ol;
        for (let f = a; f < b; f++) {
          ol[f - from] = l[f - c.start]!;
          or[f - from] = r[f - c.start]!;
        }
      });
    }
    if (++this.blocks % 32 === 0) {
      const last = this.chunks[this.chunks.length - 1];
      const tick: FromStems = { type: "tick", frame: currentFrame, buffered: last ? last.end - currentFrame : 0 };
      this.port.postMessage(tick);
    }
    return true;
  }
}

registerProcessor(STEM_PROCESSOR, StemProcessor);
