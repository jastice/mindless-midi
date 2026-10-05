import assert from "node:assert/strict";
import { test } from "node:test";
import { EV_OFF, EV_ON, EventQueue, type SynthEvent, type SynthSink } from "./events.js";

/** Counts sounding voices like libADLMIDI: every note-on adds one, a note-off frees one. */
class VoiceCounter implements SynthSink {
  voices = new Map<string, number>();
  noteOn(ch: number, key: number): void {
    const k = `${ch}/${key}`;
    this.voices.set(k, (this.voices.get(k) ?? 0) + 1);
  }
  noteOff(ch: number, key: number): void {
    const k = `${ch}/${key}`;
    this.voices.set(k, Math.max(0, (this.voices.get(k) ?? 0) - 1));
  }
  get sounding(): number {
    return [...this.voices.values()].reduce((a, b) => a + b, 0);
  }
  controlChange(): void {}
  programChange(): void {}
  setBank(): void {}
  reset(): void {}
  setGain(): void {}
}

const ev = (frame: number, type: number, id: number, key = 60): SynthEvent => ({ frame, type, ch: 3, a: key, b: 90, id });

function play(q: EventQueue, sink: SynthSink, frames: number): void {
  q.run(0, frames, sink, () => {});
}

test("re-striking a sounding key does not leave an orphaned voice", () => {
  // Pad chords overlap the next bar's: A 0..150, B 100..250 on the same key.
  const q = new EventQueue();
  const sink = new VoiceCounter();
  q.push([ev(0, EV_ON, 1), ev(100, EV_ON, 2), ev(150, EV_OFF, 1), ev(250, EV_OFF, 2)]);
  play(q, sink, 300);
  assert.equal(sink.sounding, 0);
});

test("a stale note-off still cannot cut the re-struck note", () => {
  const q = new EventQueue();
  const sink = new VoiceCounter();
  q.push([ev(0, EV_ON, 1), ev(100, EV_ON, 2), ev(150, EV_OFF, 1), ev(250, EV_OFF, 2)]);
  q.run(0, 200, sink, () => {});
  assert.equal(sink.sounding, 1);
});

test("clear forgets sounding notes so the next piece starts clean", () => {
  const q = new EventQueue();
  const sink = new VoiceCounter();
  q.push([ev(0, EV_ON, 1)]);
  play(q, sink, 10);
  q.clear();
  sink.voices.clear(); // the synth panics on clear
  q.push([ev(20, EV_ON, 2), ev(40, EV_OFF, 2)]);
  q.run(10, 100, sink, () => {});
  assert.equal(sink.sounding, 0);
});

test("clearFrom keeps what plays before the frame and silences everything at it", () => {
  // Switching engines mid-stream: notes before frame 100 still play; later ones are dropped.
  const q = new EventQueue();
  const sink = new VoiceCounter();
  let resets = 0;
  sink.reset = () => {
    resets++;
    sink.voices.clear();
  };
  q.push([ev(0, EV_ON, 1), ev(50, EV_ON, 2, 62), ev(150, EV_OFF, 1), ev(200, EV_ON, 3, 64), ev(250, EV_OFF, 3, 64)]);
  q.clearFrom(100);
  q.run(0, 99, sink, () => {});
  assert.equal(sink.sounding, 2);
  q.run(99, 300, sink, () => {});
  assert.equal(resets, 1);
  assert.equal(sink.sounding, 0);
  assert.equal(q.pending, 0);
});
