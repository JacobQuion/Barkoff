// In-place iterative radix-2 Cooley–Tukey FFT. Twiddle factors and the
// bit-reversal permutation are cached per size.

const plans = new Map();

function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  if (n & (n - 1)) throw new Error(`FFT size must be a power of two, got ${n}`);
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  p = { rev, cos, sin };
  plans.set(n, p);
  return p;
}

export function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// Power spectrum |X[k]|^2 for k = 0..n/2 of a real frame.
export function powerSpectrum(frame, out, re, im) {
  const n = frame.length;
  re.set(frame);
  im.fill(0);
  fft(re, im);
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}
