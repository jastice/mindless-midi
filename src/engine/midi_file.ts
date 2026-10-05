/**
 * Standard MIDI File (format 0) writer for a run of generated bars, so a
 * listener can keep something they liked.
 */
import type { Bar } from "./types.js";

export const PPQ = 480;

interface TimedBytes {
  tick: number;
  order: number;
  bytes: number[];
}

export function barsToMidi(bars: readonly Bar[], title = "Mindless Midi"): Uint8Array {
  const events: TimedBytes[] = [];
  let barTick = 0;
  let bpm = -1;
  const meta = (tick: number, type: number, data: number[]) => events.push({ tick, order: 0, bytes: [0xff, type, ...vlq(data.length), ...data] });
  meta(0, 0x03, [...new TextEncoder().encode(title)]);

  for (const bar of bars) {
    const at = (beat: number) => barTick + Math.max(0, Math.round(beat * PPQ));
    if (bar.bpm !== bpm) {
      bpm = bar.bpm;
      const us = Math.round(60_000_000 / bpm);
      meta(barTick, 0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
    }
    if (bar.info.barInPiece === 0) {
      meta(barTick, 0x58, [bar.beats & 0xff, 2, 24, 8]);
      meta(barTick, 0x06, [...new TextEncoder().encode(`${bar.info.styleTitle} - ${bar.info.keyName}`)]);
    }
    for (const c of bar.controls) {
      const tick = at(c.beat);
      if (c.kind === "program") events.push({ tick, order: 1, bytes: [0xc0 | c.ch, c.value & 0x7f] });
      else if (c.kind === "cc") events.push({ tick, order: 1, bytes: [0xb0 | c.ch, c.cc & 0x7f, c.value & 0x7f] });
      else if (c.kind === "reset") for (let ch = 0; ch < 16; ch++) events.push({ tick, order: 1, bytes: [0xb0 | ch, 123, 0] });
    }
    for (const n of bar.notes) {
      const on = at(n.beat);
      const off = Math.max(on + 1, at(n.beat + n.dur));
      events.push({ tick: on, order: 3, bytes: [0x90 | n.ch, n.key & 0x7f, n.vel & 0x7f] });
      events.push({ tick: off, order: 2, bytes: [0x80 | n.ch, n.key & 0x7f, 0] });
    }
    barTick += Math.round(bar.beats * PPQ);
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = [];
  let last = 0;
  for (const e of events) {
    track.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  track.push(0, 0xff, 0x2f, 0);

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, ...u32(track.length)];
  return new Uint8Array([...header, ...trackHeader, ...track]);
}

export function vlq(n: number): number[] {
  let v = Math.max(0, Math.floor(n));
  const out = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
