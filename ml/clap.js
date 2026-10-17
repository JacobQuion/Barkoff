// CLAP zero-shot audio classification (LAION clap-htsat-unfused, int8 ONNX)
// via Transformers.js. Server-only.
//
// The text side is precomputed (scripts/build-clap-prompts.mjs →
// models/clap/prompts.json), so at runtime we only run the 34 MB HTS-AT audio
// encoder: embed the clip, take cosine similarity to each label embedding,
// scale by CLAP's learned temperature and softmax — the same computation as
// pipeline('zero-shot-audio-classification').

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resample } from '../public/dsp/resample.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODEL_DIR = path.join(ROOT, 'models', 'clap');
const CLAP_RATE = 48000;
const CROP_MARGIN_SEC = 0.2;

let processor = null;
let audioModel = null;
let prompts = null;
let loadError = null;

export async function loadClap() {
  try {
    const { env, AutoFeatureExtractor, ClapAudioModelWithProjection } = await import('@huggingface/transformers');
    env.localModelPath = path.dirname(MODEL_DIR) + path.sep;
    env.allowRemoteModels = false;
    prompts = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'prompts.json'), 'utf8'));
    processor = await AutoFeatureExtractor.from_pretrained('clap');
    audioModel = await ClapAudioModelWithProjection.from_pretrained('clap', { dtype: 'q8' });
    await embed(new Float32Array(CLAP_RATE)); // warm-up
    return true;
  } catch (err) {
    loadError = err;
    audioModel = null;
    return false;
  }
}

export const clapStatus = () => (audioModel ? 'ready' : loadError ? `unavailable: ${loadError.message}` : 'not loaded');

async function embed(audio48k) {
  const inputs = await processor(audio48k);
  const { audio_embeds } = await audioModel(inputs);
  const v = Array.from(audio_embeds.data);
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

// pcm16k: the round's 16 kHz PCM. active: the DSP voice-activity track
// (10 ms frames). Returns null when CLAP isn't loaded or nothing was voiced.
export async function clapScores(pcm16k, active, hopSec = 0.01) {
  if (!audioModel) return null;
  const first = active.indexOf(1);
  const last = active.lastIndexOf(1);
  if (first < 0) return null;

  // Crop to the voiced span (plus a margin) so padding silence doesn't dominate.
  const s = Math.max(0, Math.floor((first * hopSec - CROP_MARGIN_SEC) * 16000));
  const e = Math.min(pcm16k.length, Math.ceil(((last + 1) * hopSec + 0.032 + CROP_MARGIN_SEC) * 16000));
  const t0 = performance.now();
  const audio48k = resample(pcm16k.subarray(s, e), 16000, CLAP_RATE);
  const a = await embed(audio48k);

  const logits = prompts.labels.map((l) => prompts.logitScale * l.embedding.reduce((acc, x, i) => acc + x * a[i], 0));
  const m = Math.max(...logits);
  const z = logits.map((x) => Math.exp(x - m));
  const zs = z.reduce((x, y) => x + y, 0);
  const probs = prompts.labels.map((l, i) => ({ text: l.text, animal: l.animal, kind: l.kind, p: z[i] / zs }));

  return { probs, cropSec: (e - s) / 16000, ms: performance.now() - t0 };
}

// Recognition for one target animal, in [0, 1]:
//   p_target = p(real animal) + p(person imitating it)
//   match    = 0 unless the target is the most likely of the seven animals,
//              else clamp((p_target − P_FLOOR) / (P_FULL − P_FLOOR))
// Calibrated on 80 synthetic-voice imitation clips: the right animal earned a
// bonus 20% of the time (mean 0.74), a wrong animal 8%, plain speech 3%.
export const CLAP_P_FLOOR = 0.03;
export const CLAP_P_FULL = 0.35;

export function clapRecognition(result, animal) {
  if (!result) return null;
  const pTarget = result.probs.filter((r) => r.animal === animal).reduce((a, r) => a + r.p, 0);
  const byAnimal = {};
  for (const r of result.probs) if (r.animal) byAnimal[r.animal] = (byAnimal[r.animal] || 0) + r.p;
  const best = Object.entries(byAnimal).sort((x, y) => y[1] - x[1])[0][0];
  const match = best !== animal ? 0 : Math.min(1, Math.max(0, (pTarget - CLAP_P_FLOOR) / (CLAP_P_FULL - CLAP_P_FLOOR)));
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  return {
    model: 'CLAP · laion/clap-htsat-unfused · int8 ONNX (Transformers.js)',
    pTarget: r4(pTarget),
    topAnimal: best,
    match: r4(match),
    byAnimal: Object.fromEntries(Object.entries(byAnimal).map(([k, v]) => [k, r4(v)])),
    top: [...result.probs].sort((x, y) => y.p - x.p).slice(0, 6).map((r) => ({ text: r.text, p: r4(r.p) })),
    cropSec: Math.round(result.cropSec * 100) / 100,
    ms: Math.round(result.ms * 10) / 10,
  };
}
