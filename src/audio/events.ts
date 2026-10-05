/**
 * Sample-accurate synth events, shared by the AudioWorklet (live playback)
 * and the Node renderer (offline tests), so both play exactly the same way.
 */
import { type Bar, barSeconds } from "../engine/types.js";

export const EV_RESET = 0;
export const EV_BANK = 1;
export const EV_PROGRAM = 2;
export const EV_CC = 3;
export const EV_OFF = 4;
export const EV_ON = 5;
export const EV_GAIN = 6;

export interface SynthEvent {
  /** Absolute sample frame. */
  frame: number;
  type: number;
  ch: number;
  a: number;
  b: number;
  /** Note id, pairs a note-off with the note-on it ends. */
  id: number;
}

/** What actually makes sound: the worklet's WASM instance or the Node core. */
export interface SynthSink {
  noteOn(ch: number, key: number, vel: number): void;
  noteOff(ch: number, key: number): void;
  controlChange(ch: number, cc: number, value: number): void;
  programChange(ch: number, program: number): void;
  setBank(bank: number): void;
  reset(): void;
  /** Output gain for the piece that starts here (not a MIDI message). */
  setGain(gain: number): void;
}

let nextNoteId = 1;

/** Convert one bar, starting at `startFrame`, into synth events. */
export function barEvents(bar: Bar, startFrame: number, sampleRate: number): SynthEvent[] {
  const framesPerBeat = (sampleRate * 60) / bar.bpm;
  const at = (beat: number) => startFrame + Math.round(beat * framesPerBeat);
  const out: SynthEvent[] = [];
  for (const c of bar.controls) {
    const frame = at(c.beat);
    switch (c.kind) {
      case "reset":
        out.push({ frame, type: EV_RESET, ch: 0, a: 0, b: 0, id: 0 });
        break;
      case "bank":
        out.push({ frame, type: EV_BANK, ch: 0, a: c.value, b: 0, id: 0 });
        break;
      case "program":
        out.push({ frame, type: EV_PROGRAM, ch: c.ch, a: c.value, b: 0, id: 0 });
        break;
      case "cc":
        out.push({ frame, type: EV_CC, ch: c.ch, a: c.cc, b: c.value, id: 0 });
        break;
      case "gain":
        out.push({ frame, type: EV_GAIN, ch: 0, a: c.value, b: 0, id: 0 });
        break;
    }
  }
  for (const n of bar.notes) {
    const id = nextNoteId++;
    const on = at(n.beat);
    out.push({ frame: on, type: EV_ON, ch: n.ch, a: n.key, b: n.vel, id });
    out.push({ frame: Math.max(on + 1, at(n.beat + n.dur)), type: EV_OFF, ch: n.ch, a: n.key, b: 0, id });
  }
  return out.sort(compareEvents);
}

export function compareEvents(x: SynthEvent, y: SynthEvent): number {
  return x.frame - y.frame || x.type - y.type;
}

export function barFrames(bar: Pick<Bar, "beats" | "bpm">, sampleRate: number): number {
  return Math.round(barSeconds(bar) * sampleRate);
}

/**
 * A time-ordered queue of events that renders audio in chunks, applying
 * each event at its exact frame.
 */
export class EventQueue {
  private q: SynthEvent[] = [];
  private head = 0;
  /** Latest note id per channel/key: a stale note-off must not cut a re-struck note. */
  private readonly owner = new Int32Array(16 * 128);

  push(events: readonly SynthEvent[]): void {
    if (!events.length) return;
    const last = this.q[this.q.length - 1];
    this.q.push(...events);
    if (last && compareEvents(events[0]!, last) < 0) {
      const pending = this.q.slice(this.head).sort(compareEvents);
      this.q = pending;
      this.head = 0;
    }
  }

  /** Drop everything not yet played. Returns the number of dropped events. */
  clear(): number {
    const n = this.q.length - this.head;
    this.q = [];
    this.head = 0;
    return n;
  }

  get pending(): number {
    return this.q.length - this.head;
  }

  /** Frame of the last queued event (or -1). */
  get horizon(): number {
    return this.q.length > this.head ? this.q[this.q.length - 1]!.frame : -1;
  }

  /**
   * Render frames [start, start + frames). `render(offset, count)` must
   * synthesize `count` frames into the output at `offset`.
   */
  run(start: number, frames: number, sink: SynthSink, render: (offset: number, count: number) => void): void {
    const end = start + frames;
    let done = 0;
    while (this.head < this.q.length && this.q[this.head]!.frame < end) {
      const ev = this.q[this.head++]!;
      const offset = Math.max(0, ev.frame - start);
      if (offset > done) {
        render(done, offset - done);
        done = offset;
      }
      this.apply(ev, sink);
    }
    if (done < frames) render(done, frames - done);
    if (this.head > 4096) {
      this.q = this.q.slice(this.head);
      this.head = 0;
    }
  }

  private apply(ev: SynthEvent, sink: SynthSink): void {
    const slot = ev.ch * 128 + ev.a;
    switch (ev.type) {
      case EV_ON:
        this.owner[slot] = ev.id;
        sink.noteOn(ev.ch, ev.a, ev.b);
        break;
      case EV_OFF:
        if (this.owner[slot] === ev.id) {
          this.owner[slot] = 0;
          sink.noteOff(ev.ch, ev.a);
        }
        break;
      case EV_CC:
        sink.controlChange(ev.ch, ev.a, ev.b);
        break;
      case EV_PROGRAM:
        sink.programChange(ev.ch, ev.a);
        break;
      case EV_BANK:
        sink.setBank(ev.a);
        break;
      case EV_RESET:
        this.owner.fill(0);
        sink.reset();
        break;
      case EV_GAIN:
        sink.setGain(ev.a);
        break;
    }
  }
}
