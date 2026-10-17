// YAMNet (Google, AudioSet-521 classifier on a MobileNet-v1 backbone) running
// on TF.js's WebAssembly backend. Server-only: the 15 MB model is loaded once
// from ./models/yamnet at startup.
//
// YAMNet frames 16 kHz audio into 0.96 s windows with a 0.48 s hop, computes
// a 64-band log-mel patch per window, embeds it (1024-d) and applies a
// 521-way sigmoid classifier. We read the scores of the AudioSet classes that
// correspond to each Barkoff animal.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODEL_DIR = path.join(ROOT, 'models', 'yamnet');

export const HOP_SEC = 0.48;
export const WINDOW_SEC = 0.96;

// AudioSet class indices (yamnet_class_map.csv) per Barkoff animal.
export const ANIMAL_CLASSES = {
  dog: [69, 70, 71, 73],     // Dog, Bark, Yip, Bow-wow
  wolf: [72, 117],           // Howl, Canidae (dogs, wolves)
  cat: [76, 78, 80],         // Cat, Meow, Caterwaul
  cow: [85, 86],             // Cattle (bovinae), Moo
  lion: [104, 105, 74],      // Roaring cats (lions, tigers), Roar, Growling
  rooster: [94, 96],         // Chicken (rooster), Crowing (cock-a-doodle-doo)
  duck: [99, 100],           // Duck, Quack
};

let tf = null;
let model = null;
let classNames = [];
let loadError = null;

function parseClassMap(csv) {
  return csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const m = line.match(/^(\d+),([^,]+),(.*)$/);
    return m ? m[3].replace(/^"|"$/g, '') : line;
  });
}

export async function loadYamnet() {
  try {
    tf = require('@tensorflow/tfjs');
    const { setWasmPaths } = require('@tensorflow/tfjs-backend-wasm');
    setWasmPaths(path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm')), path.sep));
    await tf.setBackend('wasm');
    await tf.ready();

    const mj = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'model.json'), 'utf8'));
    const weightSpecs = mj.weightsManifest.flatMap((g) => g.weights);
    const buf = Buffer.concat(mj.weightsManifest.flatMap((g) => g.paths).map((p) => fs.readFileSync(path.join(MODEL_DIR, p))));
    const weightData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    model = await tf.loadGraphModel(tf.io.fromMemory({ ...mj, weightSpecs, weightData }));
    classNames = parseClassMap(fs.readFileSync(path.join(MODEL_DIR, 'yamnet_class_map.csv'), 'utf8'));

    // Warm-up so the first real round doesn't pay for kernel compilation.
    await classify(new Float32Array(16000));
    return true;
  } catch (err) {
    loadError = err;
    model = null;
    return false;
  }
}

export const yamnetStatus = () => (model ? 'ready' : loadError ? `unavailable: ${loadError.message}` : 'not loaded');

// pcm: Float32Array at 16 kHz in [-1, 1].
export async function classify(pcm) {
  if (!model) return null;
  const t0 = performance.now();
  const input = tf.tensor1d(pcm);
  const outputs = model.execute(input);
  input.dispose();
  // Outputs are [log-mel (T×64), embeddings (N×1024), scores (N×521)]; pick by width.
  const byWidth = Object.fromEntries(outputs.map((t) => [t.shape[1], t]));
  const scores = await byWidth[521].array();
  const embeddings = await byWidth[1024].array();
  outputs.forEach((t) => t.dispose());

  const perFrame = Object.fromEntries(
    Object.entries(ANIMAL_CLASSES).map(([animal, idx]) => [animal, scores.map((row) => Math.max(...idx.map((i) => row[i])))]),
  );
  const mean = new Float64Array(521);
  for (const row of scores) for (let i = 0; i < 521; i++) mean[i] += row[i] / scores.length;
  const peak = new Float64Array(521);
  for (const row of scores) for (let i = 0; i < 521; i++) peak[i] = Math.max(peak[i], row[i]);
  const top = Array.from(peak, (p, i) => ({ i, name: classNames[i], peak: p, mean: mean[i] }))
    .sort((a, b) => b.peak - a.peak)
    .slice(0, 8);

  // Embedding summary: mean L2 norm and frame-to-frame cosine similarity
  // (how stationary the sound is in YAMNet's learned space).
  const norm = (v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0) / (norm(a) * norm(b) || 1);
  const norms = embeddings.map(norm);
  const sims = embeddings.slice(1).map((e, i) => cos(e, embeddings[i]));

  return {
    frames: scores.length,
    hopSec: HOP_SEC,
    windowSec: WINDOW_SEC,
    perFrame,
    top,
    embedding: {
      dim: embeddings[0]?.length ?? 0,
      meanNorm: norms.reduce((a, b) => a + b, 0) / (norms.length || 1),
      stationarity: sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : null,
    },
    ms: performance.now() - t0,
  };
}

// ---------- recognition score ----------
//
// 1. Keep only YAMNet windows that overlap the DSP voice-activity mask by
//    ≥ 25% (otherwise padding silence dilutes everything).
// 2. Per animal, clip probability = mean of its two highest window scores.
// 3. evidence = log-scaled target probability: 1e-4 → 0, 0.3 → 1.
//    share    = target's share among the seven animals, with a 1e-3 prior per
//               animal so near-zero noise sits at 1/7 instead of swinging.
//    match    = evidence · share  (needs real evidence AND a clear lead over
//               the other animals; speech that is faintly 'doggy' scores ~0)
const LOG_LO = 1e-3;
const LOG_HI = 0.3;
const SHARE_PRIOR = 1e-3;
const MIN_ACTIVE_OVERLAP = 0.25;

export function recognitionFor(result, activeTrack, animal, frameHopSec = 0.01) {
  if (!result) return null;
  const animals = Object.keys(ANIMAL_CLASSES);
  const windows = Array.from({ length: result.frames }, (_, k) => {
    const s = Math.round((k * HOP_SEC) / frameHopSec);
    const e = Math.min(activeTrack.length, s + Math.round(WINDOW_SEC / frameHopSec));
    let on = 0;
    for (let t = s; t < e; t++) on += activeTrack[t] ? 1 : 0;
    const overlap = e > s ? on / (e - s) : 0;
    return { t: k * HOP_SEC, used: overlap >= MIN_ACTIVE_OVERLAP, p: result.perFrame[animal][k] };
  });
  const used = windows.map((w, k) => (w.used ? k : -1)).filter((k) => k >= 0);

  const clipProb = Object.fromEntries(animals.map((a) => {
    const v = used.map((k) => result.perFrame[a][k]).sort((x, y) => y - x);
    return [a, v.length ? (v[0] + (v[1] ?? v[0])) / 2 : 0];
  }));
  const p = clipProb[animal];
  const sum = animals.reduce((s, a) => s + clipProb[a], 0);
  const share = (p + SHARE_PRIOR) / (sum + animals.length * SHARE_PRIOR);
  const evidence = Math.min(1, Math.max(0, Math.log10(Math.max(p, LOG_LO) / LOG_LO) / Math.log10(LOG_HI / LOG_LO)));
  const match = used.length ? evidence * share : 0;
  const r4 = (x) => Math.round(x * 1e4) / 1e4;

  return {
    model: 'YAMNet · AudioSet-521 · MobileNet-v1 · TF.js WASM',
    target: animal,
    classes: ANIMAL_CLASSES[animal].map((i) => classNames[i]),
    p: r4(p),
    share: r4(share),
    evidence: r4(evidence),
    match: r4(match),
    clipProb: Object.fromEntries(Object.entries(clipProb).map(([a, v]) => [a, r4(v)])),
    windows: windows.map((w) => ({ t: Math.round(w.t * 100) / 100, p: r4(w.p), used: w.used })),
    usedWindows: used.length,
    top: result.top.map((t) => ({ name: t.name, peak: r4(t.peak), mean: r4(t.mean) })),
    embedding: { dim: result.embedding.dim, meanNorm: r4(result.embedding.meanNorm), stationarity: result.embedding.stationarity == null ? null : r4(result.embedding.stationarity) },
    params: { logLo: LOG_LO, logHi: LOG_HI, sharePrior: SHARE_PRIOR, minActiveOverlap: MIN_ACTIVE_OVERLAP },
    ms: Math.round(result.ms * 10) / 10,
  };
}
