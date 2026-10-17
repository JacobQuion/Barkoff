// Band-limited sample-rate conversion by direct windowed-sinc interpolation.
// The kernel is Blackman-windowed with 16 zero crossings per side; when
// downsampling, the cutoff is scaled to 0.94x the output Nyquist so the
// 48 kHz -> 16 kHz path doesn't alias speech harmonics above 8 kHz.

const ZERO_CROSSINGS = 16;
const ROLLOFF = 0.94;

export function resample(input, inRate, outRate) {
  if (inRate === outRate) return Float32Array.from(input);
  const ratio = inRate / outRate;
  const fc = Math.min(1, outRate / inRate) * ROLLOFF; // normalised to input Nyquist
  const halfWidth = Math.ceil(ZERO_CROSSINGS / fc); // in input samples
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const t = i * ratio;
    const k0 = Math.floor(t);
    let sum = 0;
    let norm = 0;
    for (let k = k0 - halfWidth + 1; k <= k0 + halfWidth; k++) {
      if (k < 0 || k >= input.length) continue;
      const d = t - k;
      const x = Math.PI * fc * d;
      const sinc = d === 0 ? 1 : Math.sin(x) / x;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / halfWidth) + 0.08 * Math.cos((2 * Math.PI * d) / halfWidth);
      const h = sinc * w;
      sum += input[k] * h;
      norm += h;
    }
    out[i] = norm ? sum / norm : 0; // unity DC gain, also at the buffer edges
  }
  return out;
}

export function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function fromInt16(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / (i16[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}
