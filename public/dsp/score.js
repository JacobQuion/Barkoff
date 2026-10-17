// The judge. Each animal is a weighted set of feature targets plus, for tonal
// animals, a pitch-contour template matched with DTW. The result explains
// itself: every term reports its sub-score and exactly how many points it cost.

export const FEATURE_INFO = {
  onsets: { label: 'Onsets', unit: '', digits: 0 },
  activeRatio: { label: 'Active ratio', unit: '', digits: 2 },
  meanSegmentSec: { label: 'Mean burst length', unit: 's', digits: 2 },
  ioiCv: { label: 'Rhythm irregularity (IOI CV)', unit: '', digits: 2 },
  attackDb: { label: 'Attack rise', unit: 'dB', digits: 1 },
  f0Median: { label: 'Median f0', unit: 'Hz', digits: 0 },
  f0RangeSt: { label: 'f0 range (p10–p90)', unit: 'st', digits: 1 },
  voicedRatio: { label: 'Voiced ratio', unit: '', digits: 2 },
  centroid: { label: 'Spectral centroid', unit: 'Hz', digits: 0 },
  hnr: { label: 'Harmonics-to-noise (est.)', unit: 'dB', digits: 1 },
  contour: { label: 'Pitch contour match (DTW)', unit: 'st', digits: 2 },
};

// Template contours are semitone offsets over normalised time.
export const ANIMALS = {
  dog: {
    name: 'Dog', emoji: '🐶', sound: 'BARK! BARK!', tip: 'Short, punchy barks',
    targets: [
      { f: 'onsets', lo: 2, hi: 7, tol: 1.5, w: 1, hint: 'More separate barks — bark, bark, bark!' },
      { f: 'meanSegmentSec', lo: 0.08, hi: 0.35, tol: 0.12, w: 1, hint: 'Keep each bark short and sharp.' },
      { f: 'attackDb', lo: 14, hi: 80, tol: 6, w: 1, hint: 'Hit each bark harder at the start.' },
      { f: 'f0Median', lo: 180, hi: 700, tol: 5, log: true, nullScore: 0.5, w: 0.5, hint: 'Find a mid-range bark voice.' },
      { f: 'ioiCv', lo: 0, hi: 0.45, tol: 0.25, nullScore: 0.6, w: 0.5, hint: 'Bark in a steadier rhythm.' },
    ],
  },
  wolf: {
    name: 'Wolf', emoji: '🐺', sound: 'AWOOOOOO', tip: 'One long howl that glides',
    contour: [-5, -2, 0, 1, 1.5, 1.5, 1, 0, -3, -7],
    targets: [
      { f: 'activeRatio', lo: 0.55, hi: 1, tol: 0.2, w: 1, hint: 'Hold that howl longer!' },
      { f: 'onsets', lo: 1, hi: 2, tol: 1, w: 0.5, hint: 'One continuous howl, no breaks.' },
      { f: 'voicedRatio', lo: 0.6, hi: 1, tol: 0.2, w: 1, hint: 'Sing it — a howl is a tone, not a shout.' },
      { f: 'f0RangeSt', lo: 4, hi: 18, tol: 3, w: 1, hint: 'Slide your pitch up and down: a-WOOOO-oo.' },
      { f: 'f0Median', lo: 220, hi: 900, tol: 5, log: true, nullScore: 0.2, w: 0.5, hint: 'Howl higher.' },
      { f: 'contour', w: 1.5, hint: 'Shape it: rise, hold, then fall away.' },
    ],
  },
  cat: {
    name: 'Cat', emoji: '🐱', sound: 'MEEOOW', tip: 'High, whiny, bendy',
    contour: [-3, 0, 2, 3, 2.5, 1, -1, -4, -6],
    targets: [
      { f: 'onsets', lo: 1, hi: 3, tol: 1, w: 0.5, hint: 'One or two meows, not a stream.' },
      { f: 'activeRatio', lo: 0.15, hi: 0.6, tol: 0.2, w: 0.5, hint: 'A meow is about a second long.' },
      { f: 'f0Median', lo: 350, hi: 1000, tol: 4, log: true, nullScore: 0.2, w: 1, hint: 'Higher! Cats are squeaky.' },
      { f: 'f0RangeSt', lo: 3, hi: 14, tol: 3, w: 1, hint: 'Bend the pitch: mee-OW.' },
      { f: 'voicedRatio', lo: 0.5, hi: 1, tol: 0.2, w: 0.5, hint: 'Make it a clear, whiny tone.' },
      { f: 'contour', w: 1.5, hint: 'Rise into the "OW", then drop off.' },
    ],
  },
  cow: {
    name: 'Cow', emoji: '🐮', sound: 'MOOOOOO', tip: 'Deep and steady',
    contour: [0.5, 0.5, 0.3, 0, 0, 0, -0.3, -0.8, -1.5],
    targets: [
      { f: 'f0Median', lo: 70, hi: 190, tol: 4, log: true, nullScore: 0.2, w: 1.5, hint: 'Lower! Moo from your chest.' },
      { f: 'activeRatio', lo: 0.45, hi: 1, tol: 0.2, w: 1, hint: 'Hold the moo longer.' },
      { f: 'voicedRatio', lo: 0.6, hi: 1, tol: 0.2, w: 0.5, hint: 'Hum it — a smooth, steady tone.' },
      { f: 'f0RangeSt', lo: 0, hi: 5, tol: 3, w: 0.5, hint: 'Keep the pitch steady.' },
      { f: 'centroid', lo: 0, hi: 900, tol: 300, w: 0.5, hint: 'Darker, rounder sound — "oo" not "ee".' },
      { f: 'contour', w: 1, hint: 'Flat and steady, sagging only at the end.' },
    ],
  },
  lion: {
    name: 'Lion', emoji: '🦁', sound: 'ROOAAARR', tip: 'Big, rough, growly',
    targets: [
      { f: 'activeRatio', lo: 0.35, hi: 1, tol: 0.2, w: 1, hint: 'A longer roar!' },
      { f: 'onsets', lo: 1, hi: 2, tol: 1, w: 0.5, hint: 'One big roar.' },
      { f: 'hnr', lo: -10, hi: 8, tol: 3, w: 1.5, hint: 'Rougher — add some growl and rasp.' },
      { f: 'centroid', lo: 300, hi: 1800, tol: 400, w: 1, hint: 'Open your mouth wide: RAAWR.' },
      { f: 'f0Median', lo: 60, hi: 300, tol: 6, log: true, nullScore: 0.8, w: 0.5, hint: 'Deeper roar.' },
    ],
  },
  rooster: {
    name: 'Rooster', emoji: '🐓', sound: 'COCK-A-DOODLE-DOO', tip: 'High, loud, in syllables',
    contour: [0, 2, 1, 3, 2, 4, 3, 6, 6, 5, 3, -2],
    targets: [
      { f: 'activeRatio', lo: 0.4, hi: 1, tol: 0.2, w: 1, hint: 'Crow longer — cock-a-doodle-dooooo.' },
      { f: 'onsets', lo: 3, hi: 6, tol: 1.5, w: 1, hint: 'Break it into syllables.' },
      { f: 'f0Median', lo: 400, hi: 1100, tol: 4, log: true, nullScore: 0.2, w: 1, hint: 'Higher! Way higher.' },
      { f: 'f0RangeSt', lo: 6, hi: 24, tol: 3, w: 0.5, hint: 'Swoop your pitch around more.' },
      { f: 'contour', w: 1, hint: 'Climb through the syllables, peak on "DOO".' },
    ],
  },
  duck: {
    name: 'Duck', emoji: '🦆', sound: 'QUACK QUACK', tip: 'Short, nasal quacks',
    targets: [
      { f: 'onsets', lo: 2, hi: 7, tol: 1.5, w: 1, hint: 'More quacks!' },
      { f: 'meanSegmentSec', lo: 0.06, hi: 0.3, tol: 0.12, w: 1, hint: 'Keep each quack short.' },
      { f: 'centroid', lo: 1200, hi: 4000, tol: 500, w: 1, hint: 'More nasal — quack through your nose.' },
      { f: 'hnr', lo: -10, hi: 10, tol: 4, w: 0.5, hint: 'Raspier quacks.' },
      { f: 'attackDb', lo: 10, hi: 80, tol: 6, w: 0.5, hint: 'Snappier quacks.' },
    ],
  },
};

export const ANIMAL_IDS = Object.keys(ANIMALS);

const CONTOUR_POINTS = 48;
const DTW_BAND = 0.2;
const CONTOUR_SCALE_ST = 3; // mean |Δ| of this many semitones scores 1/e

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[(s.length - 1) >> 1] : 0;
};

function resampleLinear(values, n) {
  if (values.length === 1) return new Array(n).fill(values[0]);
  return Array.from({ length: n }, (_, i) => {
    const t = (i * (values.length - 1)) / (n - 1);
    const lo = Math.floor(t);
    const hi = Math.min(values.length - 1, lo + 1);
    return values[lo] + (values[hi] - values[lo]) * (t - lo);
  });
}

// Dynamic time warping with a Sakoe–Chiba band. Returns the mean absolute
// semitone deviation along the optimal path, and the path itself.
export function dtw(a, b, bandFrac = DTW_BAND) {
  const n = a.length, m = b.length;
  const band = Math.max(Math.abs(n - m), Math.ceil(bandFrac * Math.max(n, m)));
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  D[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(1, i - band); j <= Math.min(m, i + band); j++) {
      const cost = Math.abs(a[i - 1] - b[j - 1]);
      let best = D[i - 1][j - 1], len = L[i - 1][j - 1];
      if (D[i - 1][j] < best) { best = D[i - 1][j]; len = L[i - 1][j]; }
      if (D[i][j - 1] < best) { best = D[i][j - 1]; len = L[i][j - 1]; }
      D[i][j] = cost + best;
      L[i][j] = len + 1;
    }
  }
  const path = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const diag = D[i - 1][j - 1], up = D[i - 1][j], left = D[i][j - 1];
    if (diag <= up && diag <= left) { i--; j--; }
    else if (up < left) i--;
    else j--;
  }
  path.reverse();
  return { cost: D[n][m] / L[n][m], path };
}

function contourMatch(analysis, template) {
  const st = analysis.contour.st;
  if (st.length < 10) return { similarity: 0, cost: null, user: [], template: [], path: [] };
  const sm = st.map((_, i) => median(st.slice(Math.max(0, i - 2), i + 3)));
  const center = (v) => {
    const m = median(v);
    return v.map((x) => x - m);
  };
  const user = center(resampleLinear(sm, CONTOUR_POINTS));
  const tpl = center(resampleLinear(template, CONTOUR_POINTS));
  const { cost, path } = dtw(user, tpl);
  return { similarity: Math.exp(-cost / CONTOUR_SCALE_ST), cost, user, template: tpl, path };
}

function targetScore(t, value) {
  if (value == null) return t.nullScore ?? 0;
  if (value >= t.lo && value <= t.hi) return 1;
  const bound = value < t.lo ? t.lo : t.hi;
  const d = t.log ? 12 * Math.abs(Math.log2(Math.max(value, 1) / Math.max(bound, 1))) : Math.abs(value - bound);
  return Math.exp(-0.5 * (d / t.tol) ** 2);
}

// Delivery terms, mapped onto [0, 1].
const volumeOf = (f) => clamp01((f.lufsMax + 45) / 33); // -45 LUFS → 0, -12 LUFS → 1
const gustoOf = (f) => 0.5 * clamp01(f.activeSec / 1.5) + 0.5 * clamp01(f.attackDb / 20);

// score = 100 · accuracy · (0.6 + 0.3·volume + 0.1·gusto)
//
// Points lost are reported as an exact additive waterfall from 100:
//   accuracy term k loses 100 · w_k(1 − s_k)/Σw
//   volume  loses 100 · accuracy · 0.3(1 − volume)
//   gusto   loses 100 · accuracy · 0.1(1 − gusto)
export function scoreBark(animalId, analysis) {
  const animal = ANIMALS[animalId];
  const f = analysis.features;
  const silent = f.activeFrames < 8;
  const contour = animal.contour && !silent ? contourMatch(analysis, animal.contour) : null;

  const totalW = animal.targets.reduce((a, t) => a + t.w, 0);
  const terms = animal.targets.map((t) => {
    const isContour = t.f === 'contour';
    const value = isContour ? contour?.cost ?? null : f[t.f];
    const sub = silent ? 0 : isContour ? contour?.similarity ?? 0 : targetScore(t, value);
    return {
      id: t.f,
      label: FEATURE_INFO[t.f].label,
      unit: FEATURE_INFO[t.f].unit,
      digits: FEATURE_INFO[t.f].digits,
      value,
      lo: isContour ? 0 : t.lo,
      hi: isContour ? CONTOUR_SCALE_ST : t.hi,
      tol: t.tol ?? null,
      log: !!t.log,
      weight: t.w / totalW,
      sub,
      lost: (100 * t.w * (1 - sub)) / totalW,
      hint: t.hint,
    };
  });

  const accuracy = terms.reduce((a, t) => a + t.weight * t.sub, 0);
  const volume = silent ? 0 : volumeOf(f);
  const gusto = silent ? 0 : gustoOf(f);
  const score = Math.round(100 * accuracy * (0.6 + 0.3 * volume + 0.1 * gusto));

  const waterfall = [
    ...terms.map((t) => ({ label: t.label, lost: t.lost, kind: 'accuracy' })),
    { label: 'Volume', lost: 100 * accuracy * 0.3 * (1 - volume), kind: 'delivery' },
    { label: 'Gusto', lost: 100 * accuracy * 0.1 * (1 - gusto), kind: 'delivery' },
  ];

  const worst = terms.reduce((a, b) => (b.lost > a.lost ? b : a));
  const hint = silent
    ? "We didn't hear anything. Is your mic on?"
    : volume < 0.4
      ? 'LOUDER! Get closer to the mic.'
      : worst.sub < 0.8
        ? worst.hint
        : 'Textbook. 👌';

  return {
    animal: animalId,
    score,
    breakdown: { volume, accuracy, gusto },
    terms,
    waterfall,
    contour: contour && {
      ...contour,
      user: contour.user.map((v) => Math.round(v * 100) / 100),
      template: contour.template.map((v) => Math.round(v * 100) / 100),
    },
    hint,
    label: labelFor(score),
  };
}

export function labelFor(score) {
  if (score >= 85) return 'Alpha 👑';
  if (score >= 70) return 'Feral';
  if (score >= 50) return 'Good boy';
  if (score >= 30) return 'Puppy';
  if (score > 0) return 'Squeak';
  return 'Silent 🦗';
}
