/**
 * Media keys, headset buttons and the OS now-playing widget are only routed to
 * a page that has a media element playing; sound made with the Web Audio API
 * alone doesn't count, so the Media Session handlers never fire. This plays a
 * silent looping clip for as long as the music plays, which makes the browser
 * treat the tab as a player. (The music itself still goes straight to the
 * AudioContext, so its latency and the piano roll's sync are untouched.)
 */

/** A silent mono WAV as an object URL. Browsers ignore very short clips as media worth controlling. */
function silence(seconds: number): string {
  const rate = 8000;
  const bytes = rate * seconds * 2;
  const wav = new DataView(new ArrayBuffer(44 + bytes));
  const tag = (at: number, text: string) => [...text].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  wav.setUint32(4, 36 + bytes, true);
  tag(8, "WAVEfmt ");
  wav.setUint32(16, 16, true); // fmt chunk size
  wav.setUint16(20, 1, true); // PCM
  wav.setUint16(22, 1, true); // mono
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate * 2, true); // bytes per second
  wav.setUint16(32, 2, true); // bytes per frame
  wav.setUint16(34, 16, true); // bits per sample
  tag(36, "data");
  wav.setUint32(40, bytes, true);
  return URL.createObjectURL(new Blob([wav.buffer], { type: "audio/wav" }));
}

/**
 * Returns a function that starts or stops the silent clip to match `playing`.
 * Call it with `true` straight from a click handler, before any await: Safari
 * only lets a user gesture start media.
 */
export function mediaAnchor(): (playing: boolean) => void {
  let el: HTMLAudioElement | null = null;
  return (playing) => {
    if (!el) {
      if (!playing) return;
      el = new Audio(silence(10));
      el.loop = true;
    }
    if (playing === !el.paused) return;
    if (playing) el.play().catch(() => undefined); // blocked or interrupted: the next state change retries
    else el.pause();
  };
}
