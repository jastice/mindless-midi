/** Spectrogram rendering for the bench's waveform panel. */
import type { Stereo } from "../sound/dsp.js";

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Log-frequency spectrogram (40 Hz .. 16 kHz) as RGBA pixels, `w` columns by
 * `h` rows, magnitudes in dB mapped from -90..-10.
 */
export function spectrogram(s: Stereo, sr: number, w: number, h: number, ink: [number, number, number], bg: [number, number, number]): ImageData {
  const N = 2048;
  const img = new ImageData(w, h);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const lo = Math.log(40);
  const hi = Math.log(16000);
  const binOf = (y: number) => (Math.exp(lo + ((h - 1 - y) / (h - 1)) * (hi - lo)) * N) / sr;
  for (let x = 0; x < w; x++) {
    const center = Math.floor(((x + 0.5) / w) * s.l.length);
    for (let i = 0; i < N; i++) {
      const j = center - N / 2 + i;
      re[i] = j >= 0 && j < s.l.length ? ((s.l[j]! + s.r[j]!) / 2) * win[i]! : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let y = 0; y < h; y++) {
      const b = binOf(y);
      const b0 = Math.floor(b);
      const b1 = Math.max(b0 + 1, Math.floor(binOf(y - 1)));
      let m = 0;
      for (let k = b0; k <= Math.min(b1, N / 2 - 1); k++) m = Math.max(m, Math.hypot(re[k]!, im[k]!));
      const db = 20 * Math.log10((m / N) * 4 + 1e-9);
      const t = Math.max(0, Math.min(1, (db + 90) / 80));
      const o = (y * w + x) * 4;
      img.data[o] = bg[0] + (ink[0] - bg[0]) * t;
      img.data[o + 1] = bg[1] + (ink[1] - bg[1]) * t;
      img.data[o + 2] = bg[2] + (ink[2] - bg[2]) * t;
      img.data[o + 3] = 255;
    }
  }
  return img;
}
