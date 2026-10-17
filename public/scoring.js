// Bark analysis: turns a few seconds of microphone audio into features
// (loudness, bursts, pitch, pitch glide, noisiness, brightness) and scores
// how loud and how animal-like the sound was.

// Each target says what range a feature should fall in for that animal.
// Inside [lo, hi] scores 1; outside it falls off with `tol` (in semitones
// when `log` is set). `hint` is shown when that target is the weakest one.
export const ANIMALS = {
  dog: {
    name: 'Dog', emoji: '🐶', sound: 'BARK! BARK!', tip: 'Short, punchy barks',
    targets: [
      { f: 'onsets', lo: 2, hi: 6, tol: 1.5, hint: 'More separate barks — bark, bark, bark!' },
      { f: 'activeRatio', lo: 0.12, hi: 0.5, tol: 0.15, hint: 'Keep each bark short and sharp.' },
      { f: 'attack', lo: 18, hi: 80, tol: 8, hint: 'Hit each bark harder at the start.' },
      { f: 'pitch', lo: 180, hi: 700, tol: 5, log: true, nullScore: 0.5, hint: 'Find a mid-range bark voice.' },
    ],
  },
  wolf: {
    name: 'Wolf', emoji: '🐺', sound: 'AWOOOOOO', tip: 'One long howl that glides',
    targets: [
      { f: 'activeRatio', lo: 0.55, hi: 1, tol: 0.2, hint: 'Hold that howl longer!' },
      { f: 'onsets', lo: 1, hi: 2, tol: 1, hint: 'One continuous howl, no breaks.' },
      { f: 'voicedRatio', lo: 0.6, hi: 1, tol: 0.2, hint: 'Sing it — a howl is a tone, not a shout.' },
      { f: 'pitchRange', lo: 4, hi: 18, tol: 3, hint: 'Slide your pitch up and down: a-WOOOO-oo.' },
      { f: 'pitch', lo: 220, hi: 900, tol: 5, log: true, nullScore: 0.2, hint: 'Howl higher.' },
    ],
  },
  cat: {
    name: 'Cat', emoji: '🐱', sound: 'MEEOOW', tip: 'High, whiny, bendy',
    targets: [
      { f: 'onsets', lo: 1, hi: 3, tol: 1, hint: 'One or two meows, not a stream.' },
      { f: 'activeRatio', lo: 0.15, hi: 0.6, tol: 0.2, hint: 'A meow is about a second long.' },
      { f: 'pitch', lo: 350, hi: 1000, tol: 4, log: true, nullScore: 0.2, hint: 'Higher! Cats are squeaky.' },
      { f: 'pitchRange', lo: 3, hi: 14, tol: 3, hint: 'Bend the pitch: mee-OW.' },
      { f: 'voicedRatio', lo: 0.5, hi: 1, tol: 0.2, hint: 'Make it a clear, whiny tone.' },
    ],
  },
  cow: {
    name: 'Cow', emoji: '🐮', sound: 'MOOOOOO', tip: 'Deep and steady',
    targets: [
      { f: 'pitch', lo: 70, hi: 190, tol: 4, log: true, nullScore: 0.2, hint: 'Lower! Moo from your chest.' },
      { f: 'activeRatio', lo: 0.45, hi: 1, tol: 0.2, hint: 'Hold the moo longer.' },
      { f: 'voicedRatio', lo: 0.6, hi: 1, tol: 0.2, hint: 'Hum it — a smooth, steady tone.' },
      { f: 'pitchRange', lo: 0, hi: 5, tol: 3, hint: 'Keep the pitch steady.' },
      { f: 'centroid', lo: 0, hi: 900, tol: 300, hint: 'Darker, rounder sound — "oo" not "ee".' },
    ],
  },
  lion: {
    name: 'Lion', emoji: '🦁', sound: 'ROOAAARR', tip: 'Big, rough, growly',
    targets: [
      { f: 'activeRatio', lo: 0.35, hi: 1, tol: 0.2, hint: 'A longer roar!' },
      { f: 'onsets', lo: 1, hi: 2, tol: 1, hint: 'One big roar.' },
      { f: 'flatness', lo: 0.08, hi: 1, tol: 0.05, hint: 'Rougher — add some growl and rasp.' },
      { f: 'centroid', lo: 300, hi: 1800, tol: 400, hint: 'Open your mouth wide: RAAWR.' },
      { f: 'pitch', lo: 60, hi: 300, tol: 6, log: true, nullScore: 0.8, hint: 'Deeper roar.' },
    ],
  },
  rooster: {
    name: 'Rooster', emoji: '🐓', sound: 'COCK-A-DOODLE-DOO', tip: 'High, loud, in syllables',
    targets: [
      { f: 'activeRatio', lo: 0.4, hi: 1, tol: 0.2, hint: 'Crow longer — cock-a-doodle-dooooo.' },
      { f: 'onsets', lo: 2, hi: 5, tol: 1.5, hint: 'Break it into syllables.' },
      { f: 'pitch', lo: 400, hi: 1100, tol: 4, log: true, nullScore: 0.2, hint: 'Higher! Way higher.' },
      { f: 'pitchRange', lo: 6, hi: 24, tol: 3, hint: 'Swoop your pitch around more.' },
    ],
  },
  duck: {
    name: 'Duck', emoji: '🦆', sound: 'QUACK QUACK', tip: 'Short, nasal quacks',
    targets: [
      { f: 'onsets', lo: 2, hi: 6, tol: 1.5, hint: 'More quacks!' },
      { f: 'activeRatio', lo: 0.12, hi: 0.5, tol: 0.15, hint: 'Keep each quack short.' },
      { f: 'centroid', lo: 1200, hi: 4000, tol: 500, hint: 'More nasal — quack through your nose.' },
      { f: 'attack', lo: 12, hi: 80, tol: 8, hint: 'Snappier quacks.' },
    ],
  },
};

const MIN_PITCH = 70;
const MAX_PITCH = 1000;

// Records analyser frames on every audio-thread tick for `durationMs`.
export class BarkRecorder {
  constructor(analyser, sampleRate, subscribeTick, frameMs) {
    this.analyser = analyser;
    this.sampleRate = sampleRate;
    this.subscribeTick = subscribeTick;
    this.frameMs = frameMs;
    this.time = new Float32Array(analyser.fftSize);
    this.freq = new Float32Array(analyser.frequencyBinCount);
    this.unsubscribe = null;
  }

  record(durationMs) {
    const frames = [];
    const needed = Math.round(durationMs / this.frameMs);
    return new Promise((resolve) => {
      this.unsubscribe = this.subscribeTick(() => {
        frames.push(this.frame());
        if (frames.length >= needed) {
          this.cancel();
          resolve(summarize(frames, this.frameMs));
        }
      });
    });
  }

  cancel() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  frame() {
    const { analyser, time, freq, sampleRate } = this;
    analyser.getFloatTimeDomainData(time);
    analyser.getFloatFrequencyData(freq);

    let sum = 0;
    for (let i = 0; i < time.length; i++) sum += time[i] * time[i];
    const rms = Math.sqrt(sum / time.length);
    const db = 20 * Math.log10(rms + 1e-9);

    // Spectral centroid (brightness) and flatness (noisiness), 80 Hz–8 kHz.
    const binHz = sampleRate / analyser.fftSize;
    const lo = Math.ceil(80 / binHz);
    const hi = Math.min(freq.length - 1, Math.floor(8000 / binHz));
    let wSum = 0, mSum = 0, pSum = 0, logPSum = 0;
    for (let i = lo; i <= hi; i++) {
      const dB = Math.max(freq[i], -160);
      const m = Math.pow(10, dB / 20);
      wSum += i * binHz * m;
      mSum += m;
      pSum += m * m;
      logPSum += (dB / 10) * Math.LN10;
    }
    const count = hi - lo + 1;
    const centroid = mSum > 0 ? wSum / mSum : 0;
    const flatness = pSum > 0 ? Math.exp(logPSum / count) / (pSum / count) : 0;

    return { db, centroid, flatness, pitch: detectPitch(time, sampleRate) };
  }
}

// Autocorrelation pitch detector on a 2x-downsampled buffer. Returns Hz or
// null when the frame isn't clearly pitched.
function detectPitch(buf, sampleRate) {
  const n = buf.length >> 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * (buf[2 * i] + buf[2 * i + 1]);
  const sr = sampleRate / 2;

  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += x[i] * x[i];
  if (r0 / n < 1e-5) return null;

  const minLag = Math.floor(sr / MAX_PITCH);
  const maxLag = Math.min(n - 2, Math.ceil(sr / MIN_PITCH));
  const r = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += x[i] * x[i + lag];
    r[lag] = s / (r0 * (n - lag) / n);
  }

  // Take the first local peak that is close to the best one, which avoids
  // picking a multiple of the real period (octave errors).
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] > best) best = r[lag];
  }
  if (best < 0.6) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] >= 0.9 * best) return sr / lag;
  }
  return null;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(frames, frameMs) {
  const dbs = frames.map((f) => f.db);
  const floor = percentile(dbs, 0.1);
  const thrOn = Math.max(-55, Math.min(floor + 12, -30));
  const thrOff = thrOn - 6;

  // Count separate sounds, ignoring dips shorter than ~60 ms.
  let active = false;
  let onsets = 0;
  let lastOff = -Infinity;
  const isActive = frames.map((f, i) => {
    if (!active && f.db > thrOn) {
      active = true;
      if (i - lastOff >= 3) onsets++;
    } else if (active && f.db < thrOff) {
      active = false;
      lastOff = i;
    }
    return active;
  });

  const act = frames.filter((_, i) => isActive[i]);
  const pitches = act.filter((f) => f.pitch).map((f) => f.pitch);
  const voiced = pitches.length >= 3;

  let attack = 0;
  for (let i = 2; i < dbs.length; i++) attack = Math.max(attack, dbs[i] - dbs[i - 2]);

  return {
    activeFrames: act.length,
    activeSec: (act.length * frameMs) / 1000,
    activeRatio: frames.length ? act.length / frames.length : 0,
    onsets,
    loudness: percentile(dbs, 0.95),
    attack,
    pitch: voiced ? percentile(pitches, 0.5) : null,
    pitchRange: voiced ? 12 * Math.log2(percentile(pitches, 0.9) / percentile(pitches, 0.1)) : 0,
    voicedRatio: act.length ? pitches.length / act.length : 0,
    centroid: percentile(act.map((f) => f.centroid), 0.5),
    flatness: percentile(act.map((f) => f.flatness), 0.5),
  };
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

function targetScore(t, value) {
  if (value == null) return t.nullScore ?? 0;
  if (value >= t.lo && value <= t.hi) return 1;
  const bound = value < t.lo ? t.lo : t.hi;
  const d = t.log ? 12 * Math.abs(Math.log2(Math.max(value, 1) / Math.max(bound, 1))) : Math.abs(value - bound);
  return Math.exp(-0.5 * (d / t.tol) ** 2);
}

export function scoreBark(animalId, features) {
  const animal = ANIMALS[animalId];
  if (features.activeFrames < 5) {
    return {
      score: 0,
      breakdown: { volume: 0, accuracy: 0, gusto: 0 },
      label: 'Silent 🦗',
      hint: "We didn't hear anything. Is your mic on?",
      features,
    };
  }

  // Loudness in dBFS: -45 is a mumble, -8 is yelling right at the mic.
  const volume = clamp01((features.loudness + 45) / 37);
  const scored = animal.targets.map((t) => ({ t, s: targetScore(t, features[t.f]) }));
  const accuracy = scored.reduce((sum, x) => sum + x.s, 0) / scored.length;
  const gusto = 0.5 * clamp01(features.activeSec / 1.5) + 0.5 * clamp01(features.attack / 25);

  // Accuracy multiplies everything, so yelling the wrong animal doesn't win.
  const score = Math.round(100 * accuracy * (0.6 + 0.3 * volume + 0.1 * gusto));
  const weakest = scored.reduce((a, b) => (b.s < a.s ? b : a));
  const hint = volume < 0.4 ? 'LOUDER! Get closer to the mic.' : weakest.s < 0.8 ? weakest.t.hint : 'Textbook. 👌';

  return { score, breakdown: { volume, accuracy, gusto }, label: labelFor(score), hint, features };
}

export function labelFor(score) {
  if (score >= 85) return 'Alpha 👑';
  if (score >= 70) return 'Feral';
  if (score >= 50) return 'Good boy';
  if (score >= 30) return 'Puppy';
  if (score > 0) return 'Squeak';
  return 'Silent 🦗';
}
