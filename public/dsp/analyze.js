// Barkoff analysis pipeline. Runs identically in the browser (practice mode)
// and in Node (authoritative match scoring).
//
//   PCM @16 kHz ─┬─ DC removal ─ framing (32 ms Hann, 10 ms hop) ─ FFT ─┬─ centroid / roll-off / flatness / tilt
//                │                                                     ├─ 40-band mel ─ log ─ DCT-II ─ 13 MFCCs
//                │                                                     └─ log-magnitude spectral flux ─ onsets
//                ├─ YIN f0 + aperiodicity (de Cheveigné & Kawahara 2002) ─ HNR estimate
//                ├─ RMS envelope ─ noise floor ─ hysteresis voice-activity segments
//                └─ K-weighting (ITU-R BS.1770) ─ momentary / gated integrated LUFS

import { powerSpectrum } from './fft.js';

export const SAMPLE_RATE = 16000;
export const WIN = 512;
export const HOP = 160;
const N_BINS = WIN / 2 + 1;

const MEL_BANDS = 40;
const MEL_FMIN = 60;
const MEL_FMAX = 7600;
const N_MFCC = 13;
const SPEC_FMIN = 60;
const SPEC_FMAX = 7800;

const F0_MIN = 70;
const F0_MAX = 1100;
const YIN_WIN = 400; // 25 ms integration window
const YIN_THRESHOLD = 0.2;

const hann = new Float32Array(WIN).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1)));
const binHz = SAMPLE_RATE / WIN;

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);

// Triangular HTK-style mel filterbank over the FFT bins.
const melFilters = (() => {
  const lo = hzToMel(MEL_FMIN);
  const hi = hzToMel(MEL_FMAX);
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (MEL_BANDS + 1)));
  return Array.from({ length: MEL_BANDS }, (_, m) => {
    const [l, c, r] = [edges[m], edges[m + 1], edges[m + 2]];
    const start = Math.floor(l / binHz);
    const end = Math.ceil(r / binHz);
    const weights = [];
    for (let k = start; k <= end; k++) {
      const f = k * binHz;
      const w = f <= c ? (f - l) / (c - l) : (r - f) / (r - c);
      weights.push(Math.max(0, w));
    }
    return { start, weights, center: c };
  });
})();
export const MEL_CENTERS = melFilters.map((f) => f.center);

// Orthonormal DCT-II basis for the MFCCs.
const dct = Array.from({ length: N_MFCC }, (_, n) =>
  Float64Array.from({ length: MEL_BANDS }, (_, m) =>
    Math.cos((Math.PI * n * (m + 0.5)) / MEL_BANDS) * Math.sqrt((n === 0 ? 1 : 2) / MEL_BANDS),
  ),
);

// Regression abscissa for spectral tilt: octave position of each mel band.
const tiltX = MEL_CENTERS.map((f) => Math.log2(f));
const tiltXMean = tiltX.reduce((a, b) => a + b, 0) / MEL_BANDS;
const tiltXVar = tiltX.reduce((a, x) => a + (x - tiltXMean) ** 2, 0);

// ---------- helpers ----------

export function percentile(values, p) {
  const v = Array.from(values).filter(Number.isFinite);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const idx = p * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

const median = (v) => percentile(v, 0.5);

function medianFilter(values, size) {
  const half = size >> 1;
  return values.map((_, i) => median(values.slice(Math.max(0, i - half), i + half + 1)));
}

// RBJ biquad, Direct Form I.
function biquad(x, [b0, b1, b2, a0, a1, a2]) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i];
    y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

// BS.1770 K-weighting re-derived for an arbitrary sample rate: a +4 dB high
// shelf at ~1.68 kHz (head acoustics) followed by an RLB high-pass at ~38 Hz.
function kWeightCoeffs(fs) {
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const A = 10 ** (G / 40), w0 = (2 * Math.PI * f0) / fs, alpha = Math.sin(w0) / (2 * Q), c = Math.cos(w0), s = 2 * Math.sqrt(A) * alpha;
    return [
      A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s),
      A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s,
    ];
  })();
  const highpass = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const w0 = (2 * Math.PI * f0) / fs, alpha = Math.sin(w0) / (2 * Q), c = Math.cos(w0);
    return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha];
  })();
  return [shelf, highpass];
}

// |H(e^jw)|^2 of a biquad cascade at frequency f.
function cascadePowerGain(stages, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  return stages.reduce((g, [b0, b1, b2, a0, a1, a2]) => {
    const num = (b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w)) ** 2 + (b1 * Math.sin(w) + b2 * Math.sin(2 * w)) ** 2;
    const den = (a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w)) ** 2 + (a1 * Math.sin(w) + a2 * Math.sin(2 * w)) ** 2;
    return (g * num) / den;
  }, 1);
}

const K_STAGES = kWeightCoeffs(SAMPLE_RATE);
// The cookbook re-derivation (plus bilinear warping near the 8 kHz Nyquist)
// doesn't land exactly on the BS.1770 response. The standard defines the
// K-weighted gain at 1 kHz as +0.691 dB (so a full-scale 1 kHz sine reads
// -3.01 LUFS); calibrate to that.
const K_CAL_DB = 0.691 - 10 * Math.log10(cascadePowerGain(K_STAGES, 1000, SAMPLE_RATE));

const kWeight = (x) => K_STAGES.reduce((sig, stage) => biquad(sig, stage), x);
const lufsOf = (meanSquare) => -0.691 + K_CAL_DB + 10 * Math.log10(meanSquare + 1e-12);

// YIN: cumulative-mean-normalised difference function with absolute threshold
// and parabolic refinement. Returns { f0, aperiodicity } (f0 null if unvoiced).
function yin(x, start, fs) {
  const minLag = Math.floor(fs / F0_MAX);
  const maxLag = Math.ceil(fs / F0_MIN);
  if (start + YIN_WIN + maxLag + 1 > x.length) return { f0: null, aperiodicity: 1 };
  const d = new Float64Array(maxLag + 2);
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    let s = 0;
    for (let j = start; j < start + YIN_WIN; j++) {
      const diff = x[j] - x[j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  const cmnd = new Float64Array(maxLag + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }

  let tau = -1;
  for (let t = minLag; t <= maxLag; t++) {
    if (cmnd[t] < YIN_THRESHOLD) {
      while (t + 1 <= maxLag && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = minLag;
    for (let t = minLag; t <= maxLag; t++) if (cmnd[t] < cmnd[best]) best = t;
    return { f0: null, aperiodicity: Math.min(1, cmnd[best]) };
  }
  const [a, b, c] = [cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (a - c) / (2 * denom) : 0;
  return { f0: fs / (tau + Math.max(-1, Math.min(1, shift))), aperiodicity: Math.max(0, b) };
}

// ---------- main entry ----------

export function analyze(pcm, fs = SAMPLE_RATE) {
  const t0 = performance.now();
  if (fs !== SAMPLE_RATE) throw new Error(`analyze() expects ${SAMPLE_RATE} Hz input`);

  // DC removal
  let dc = 0;
  for (let i = 0; i < pcm.length; i++) dc += pcm[i];
  dc /= pcm.length || 1;
  const x = Float32Array.from(pcm, (v) => v - dc);

  const nFrames = Math.max(0, Math.floor((x.length - WIN) / HOP) + 1);
  const rmsDb = new Float32Array(nFrames);
  const zcr = new Float32Array(nFrames);
  const centroid = new Float32Array(nFrames);
  const rolloff = new Float32Array(nFrames);
  const flatness = new Float32Array(nFrames);
  const tilt = new Float32Array(nFrames);
  const fluxRaw = new Float32Array(nFrames);
  const f0 = new Float32Array(nFrames);
  const aperiodicity = new Float32Array(nFrames);
  const melDb = new Float32Array(nFrames * MEL_BANDS);
  const mfcc = Array.from({ length: N_MFCC }, () => new Float32Array(nFrames));

  const frame = new Float32Array(WIN);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const P = new Float64Array(N_BINS);
  let prevLogMag = new Float64Array(N_BINS);
  let curLogMag = new Float64Array(N_BINS);
  const kLo = Math.ceil(SPEC_FMIN / binHz);
  const kHi = Math.floor(SPEC_FMAX / binHz);
  const melE = new Float64Array(MEL_BANDS);

  for (let t = 0; t < nFrames; t++) {
    const off = t * HOP;
    let sq = 0, crossings = 0;
    for (let i = 0; i < WIN; i++) {
      const v = x[off + i];
      sq += v * v;
      if (i && (v >= 0) !== (x[off + i - 1] >= 0)) crossings++;
      frame[i] = v * hann[i];
    }
    rmsDb[t] = 10 * Math.log10(sq / WIN + 1e-12);
    zcr[t] = crossings / (WIN - 1);

    powerSpectrum(frame, P, re, im);

    let pSum = 0, mSum = 0, fmSum = 0, logPSum = 0;
    for (let k = kLo; k <= kHi; k++) {
      const m = Math.sqrt(P[k]);
      pSum += P[k];
      mSum += m;
      fmSum += k * binHz * m;
      logPSum += Math.log(P[k] + 1e-20);
    }
    const nb = kHi - kLo + 1;
    centroid[t] = mSum > 0 ? fmSum / mSum : 0;
    flatness[t] = pSum > 0 ? Math.exp(logPSum / nb) / (pSum / nb) : 0;
    let cum = 0;
    rolloff[t] = SPEC_FMAX;
    for (let k = kLo; k <= kHi; k++) {
      cum += P[k];
      if (cum >= 0.85 * pSum) {
        rolloff[t] = k * binHz;
        break;
      }
    }

    // Half-wave rectified log-magnitude flux.
    let flux = 0;
    for (let k = 0; k < N_BINS; k++) {
      curLogMag[k] = Math.log1p((100 * Math.sqrt(P[k])) / (WIN / 2));
      if (t > 0) flux += Math.max(0, curLogMag[k] - prevLogMag[k]);
    }
    fluxRaw[t] = flux;
    [prevLogMag, curLogMag] = [curLogMag, prevLogMag];

    // Mel energies -> log-mel (dB) and MFCCs (natural log).
    let yMean = 0;
    for (let m = 0; m < MEL_BANDS; m++) {
      const { start, weights } = melFilters[m];
      let e = 0;
      for (let j = 0; j < weights.length; j++) e += P[start + j] * weights[j];
      melE[m] = e;
      const db = 10 * Math.log10(e + 1e-12);
      melDb[t * MEL_BANDS + m] = db;
      yMean += db;
    }
    yMean /= MEL_BANDS;
    let cov = 0;
    for (let m = 0; m < MEL_BANDS; m++) cov += (tiltX[m] - tiltXMean) * (melDb[t * MEL_BANDS + m] - yMean);
    tilt[t] = cov / tiltXVar; // dB per octave
    for (let n = 0; n < N_MFCC; n++) {
      let c = 0;
      for (let m = 0; m < MEL_BANDS; m++) c += dct[n][m] * Math.log(melE[m] + 1e-12);
      mfcc[n][t] = c;
    }

    const p = yin(x, off + (WIN - YIN_WIN) / 2, fs);
    f0[t] = p.f0 || 0;
    aperiodicity[t] = p.aperiodicity;
  }

  // ---- voice activity: noise floor + hysteresis, merge short gaps ----
  const noiseFloorDb = percentile(rmsDb, 0.1) ?? -100;
  const thrOn = Math.min(-30, Math.max(-62, noiseFloorDb + 12));
  const thrOff = thrOn - 6;
  const active = new Uint8Array(nFrames);
  let on = false;
  for (let t = 0; t < nFrames; t++) {
    if (!on && rmsDb[t] > thrOn) on = true;
    else if (on && rmsDb[t] < thrOff) on = false;
    active[t] = on ? 1 : 0;
  }
  let segments = [];
  for (let t = 0; t < nFrames; t++) {
    if (active[t] && (t === 0 || !active[t - 1])) segments.push([t, t]);
    if (active[t]) segments[segments.length - 1][1] = t;
  }
  segments = segments.reduce((acc, s) => {
    const last = acc[acc.length - 1];
    if (last && s[0] - last[1] <= 5) last[1] = s[1];
    else acc.push([...s]);
    return acc;
  }, []).filter(([a, b]) => b - a + 1 >= 4);
  active.fill(0);
  for (const [a, b] of segments) active.fill(1, a, b + 1);

  // ---- f0 cleanup: voiced only inside activity, median-smoothed, runs >= 3 ----
  for (let t = 0; t < nFrames; t++) if (!active[t]) f0[t] = 0;
  const runs = [];
  for (let t = 0; t < nFrames; t++) {
    if (f0[t] && (t === 0 || !f0[t - 1])) runs.push([t, t]);
    if (f0[t]) runs[runs.length - 1][1] = t;
  }
  for (const [a, b] of runs) {
    if (b - a + 1 < 3) {
      f0.fill(0, a, b + 1);
      continue;
    }
    const smooth = medianFilter(Array.from(f0.slice(a, b + 1)), 5);
    f0.set(smooth, a);
  }

  // ---- onsets: adaptive-threshold peak picking on normalised flux, energy-confirmed ----
  const fluxScale = percentile(fluxRaw, 0.99) || 1;
  const flux = Float32Array.from(fluxRaw, (v) => Math.min(1.5, v / fluxScale));
  const onsets = [];
  for (let t = 3; t < nFrames - 3; t++) {
    let isPeak = true;
    for (let k = -3; k <= 3; k++) if (flux[t + k] > flux[t]) isPeak = false;
    if (!isPeak || flux[t] < 0.15) continue;
    let local = 0;
    const lo = Math.max(0, t - 10);
    for (let k = lo; k <= t + 3; k++) local += flux[k];
    if (flux[t] < local / (t + 4 - lo) + 0.1) continue;
    if (!active[Math.min(nFrames - 1, t + 2)]) continue;
    const before = Math.min(...rmsDb.slice(Math.max(0, t - 5), t + 1));
    const after = Math.max(...rmsDb.slice(t, t + 6));
    if (after - before < 4) continue;
    if (onsets.length && t - onsets[onsets.length - 1] < 8) continue;
    onsets.push(t);
  }
  for (const [a] of segments) {
    if (!onsets.some((o) => Math.abs(o - a) <= 6)) onsets.push(a);
  }
  onsets.sort((a, b) => a - b);

  const rises = onsets.map((o) => {
    const before = Math.min(...rmsDb.slice(Math.max(0, o - 5), o + 1));
    let peakT = o;
    for (let k = o; k < Math.min(nFrames, o + 15); k++) if (rmsDb[k] > rmsDb[peakT]) peakT = k;
    return { db: rmsDb[peakT] - before, ms: ((peakT - o) * HOP * 1000) / fs };
  });

  // ---- loudness (BS.1770) ----
  const y = kWeight(x);
  const cumSq = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) cumSq[i + 1] = cumSq[i] + y[i] * y[i];
  const meanSq = (a, b) => {
    a = Math.max(0, a);
    b = Math.min(y.length, b);
    return b > a ? (cumSq[b] - cumSq[a]) / (b - a) : 0;
  };
  const halfWin = Math.round(0.2 * fs);
  const lufsM = Float32Array.from({ length: nFrames }, (_, t) => {
    const c = t * HOP + WIN / 2;
    return lufsOf(meanSq(c - halfWin, c + halfWin));
  });
  const blocks = [];
  for (let s = 0; s + 0.4 * fs <= y.length; s += 0.1 * fs) blocks.push(meanSq(s, s + 0.4 * fs));
  const absGated = blocks.filter((b) => lufsOf(b) > -70);
  let lufsIntegrated = null;
  if (absGated.length) {
    const relGate = lufsOf(absGated.reduce((a, b) => a + b, 0) / absGated.length) - 10;
    const gated = absGated.filter((b) => lufsOf(b) > relGate);
    lufsIntegrated = lufsOf(gated.reduce((a, b) => a + b, 0) / gated.length);
  }

  // ---- signal quality ----
  let peak = 0, clipped = 0, totalSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
    if (a >= 0.98) clipped++;
  }
  const activeIdx = [];
  for (let t = 0; t < nFrames; t++) if (active[t]) activeIdx.push(t);
  for (const t of activeIdx) totalSq += 10 ** (rmsDb[t] / 10);
  const activeRmsDb = activeIdx.length ? 10 * Math.log10(totalSq / activeIdx.length) : null;
  const peakDbfs = 20 * Math.log10(peak + 1e-9);
  const signalDb = percentile(rmsDb, 0.95);

  // ---- features over active frames ----
  const pick = (arr, idx) => idx.map((t) => arr[t]);
  const voicedIdx = activeIdx.filter((t) => f0[t] > 0);
  const voicedF0 = pick(f0, voicedIdx);
  const st = voicedF0.map((f) => 12 * Math.log2(f / 440));
  const iois = onsets.slice(1).map((o, i) => ((o - onsets[i]) * HOP) / fs);
  const ioiMean = iois.length ? iois.reduce((a, b) => a + b, 0) / iois.length : 0;
  const ioiStd = iois.length ? Math.sqrt(iois.reduce((a, b) => a + (b - ioiMean) ** 2, 0) / iois.length) : 0;
  const stSteps = [];
  for (let i = 1; i < voicedIdx.length; i++) if (voicedIdx[i] === voicedIdx[i - 1] + 1) stSteps.push(Math.abs(st[i] - st[i - 1]));
  const hnr = pick(aperiodicity, activeIdx).map((a) => {
    const p = Math.min(0.9999, Math.max(1e-4, 1 - a));
    return 10 * Math.log10(p / (1 - p));
  });
  const frameSec = HOP / fs;
  const voiced = voicedF0.length >= 10;

  const features = {
    activeFrames: activeIdx.length,
    activeSec: activeIdx.length * frameSec,
    activeRatio: nFrames ? activeIdx.length / nFrames : 0,
    segments: segments.length,
    meanSegmentSec: segments.length ? (activeIdx.length * frameSec) / segments.length : 0,
    onsets: onsets.length,
    onsetRate: onsets.length / ((nFrames * HOP) / fs || 1),
    ioiCv: iois.length >= 2 && ioiMean > 0 ? ioiStd / ioiMean : null,
    lufsMax: nFrames ? Math.max(...lufsM) : -100,
    lufsIntegrated,
    peakDbfs,
    attackDb: rises.length ? median(rises.map((r) => r.db)) : 0,
    attackMs: rises.length ? median(rises.map((r) => r.ms)) : null,
    f0Median: voiced ? median(voicedF0) : null,
    f0RangeSt: voiced ? percentile(st, 0.9) - percentile(st, 0.1) : 0,
    f0Instability: stSteps.length ? median(stSteps) : null,
    voicedRatio: activeIdx.length ? voicedIdx.length / activeIdx.length : 0,
    centroid: median(pick(centroid, activeIdx)),
    rolloff: median(pick(rolloff, activeIdx)),
    flatness: median(pick(flatness, activeIdx)),
    zcr: median(pick(zcr, activeIdx)),
    hnr: median(hnr),
    tilt: median(pick(tilt, activeIdx)),
  };

  const quality = {
    durationSec: pcm.length / fs,
    dcOffset: dc,
    peakDbfs,
    clipRatio: pcm.length ? clipped / pcm.length : 0,
    noiseFloorDb,
    signalDb,
    snrDb: signalDb != null ? signalDb - noiseFloorDb : null,
    crestDb: activeRmsDb != null ? peakDbfs - activeRmsDb : null,
    vadThresholdDb: thrOn,
  };

  return {
    sr: fs, hop: HOP, win: WIN, frameCount: nFrames,
    tracks: { rmsDb, lufsM, f0, aperiodicity, centroid, rolloff, flux, zcr, active },
    mel: { bands: MEL_BANDS, fmin: MEL_FMIN, fmax: MEL_FMAX, db: melDb },
    mfcc,
    onsets,
    segments,
    contour: { frames: voicedIdx, st },
    features,
    quality,
    analysisMs: performance.now() - t0,
  };
}

// ---------- transport ----------

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const encodePcm16 = (i16) => bytesToBase64(new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength));
export function decodePcm16(b64) {
  const bytes = base64ToBytes(b64);
  const out = new Int16Array(bytes.length >> 1);
  new Uint8Array(out.buffer).set(bytes.subarray(0, out.length * 2));
  return out;
}

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const roundArr = (a, d) => Array.from(a, (v) => round(v, d));

// Compact, JSON-safe report: tracks rounded, the mel spectrogram quantised to
// 8 bits over an 80 dB range, MFCCs decimated 2x in time.
export function serializeAnalysis(a) {
  const melMax = a.mel.db.length ? Math.max(...a.mel.db) : 0;
  const range = 80;
  const melBytes = Uint8Array.from(a.mel.db, (v) => Math.max(0, Math.min(255, Math.round(((v - (melMax - range)) / range) * 255))));
  const roundObj = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round(v, 4) : v]));
  return {
    sr: a.sr, hop: a.hop, win: a.win, frameCount: a.frameCount,
    tracks: {
      rmsDb: roundArr(a.tracks.rmsDb, 1),
      lufsM: roundArr(a.tracks.lufsM, 1),
      f0: roundArr(a.tracks.f0, 1),
      aperiodicity: roundArr(a.tracks.aperiodicity, 3),
      centroid: roundArr(a.tracks.centroid, 0),
      flux: roundArr(a.tracks.flux, 3),
      active: Array.from(a.tracks.active),
    },
    mel: { bands: a.mel.bands, fmin: a.mel.fmin, fmax: a.mel.fmax, dbMax: round(melMax, 1), dbRange: range, data: bytesToBase64(melBytes) },
    mfcc: { step: 2, data: a.mfcc.map((row) => roundArr(row.filter((_, i) => i % 2 === 0), 1)) },
    onsets: a.onsets,
    segments: a.segments,
    features: roundObj(a.features),
    quality: roundObj(a.quality),
    analysisMs: round(a.analysisMs, 1),
  };
}

export function decodeMel(mel) {
  return base64ToBytes(mel.data);
}
