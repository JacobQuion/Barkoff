// Precomputes CLAP text embeddings for Barkoff's zero-shot label set, so the
// server only needs CLAP's 34 MB audio encoder at runtime.
//
// Also recovers CLAP's learned temperature (logit_scale) by comparing the
// split-encoder computation against the reference zero-shot pipeline on the
// same audio, and checks that both produce identical label probabilities.
//
// Usage: node scripts/build-clap-prompts.mjs <dir with the full Xenova/clap-htsat-unfused download>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  env, pipeline, AutoTokenizer, AutoProcessor,
  ClapTextModelWithProjection, ClapAudioModelWithProjection,
} from '@huggingface/transformers';
import { CLAP_LABELS } from '../ml/clap-labels.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.resolve(process.argv[2] || path.join(ROOT, 'models', 'clap-dl'));
env.localModelPath = path.dirname(src) + path.sep;
env.allowRemoteModels = false;
const id = path.basename(src);

const labels = CLAP_LABELS.map((l) => l.text);
const tokenizer = await AutoTokenizer.from_pretrained(id);
const textModel = await ClapTextModelWithProjection.from_pretrained(id, { dtype: 'q8' });
const { text_embeds } = await textModel(tokenizer(labels, { padding: true, truncation: true }));
const dim = text_embeds.dims[1];
const raw = text_embeds.tolist();
const unit = raw.map((v) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
});

// Calibrate logit_scale against the reference pipeline (full model).
const sr = 48000;
const probe = Float32Array.from({ length: sr * 4 }, (_, i) => {
  const t = i / sr;
  const p = t % 0.55;
  return p < 0.16 ? 0.5 * Math.exp(-p * 9) * Math.sin(2 * Math.PI * 420 * t) + (Math.random() - 0.5) * 0.1 * Math.exp(-p * 9) : 0;
});
const ref = await pipeline('zero-shot-audio-classification', id, { dtype: 'q8' });
const refOut = await ref(probe, labels);
const refProb = Object.fromEntries(refOut.map((r) => [r.label, r.score]));

const processor = await AutoProcessor.from_pretrained(id);
const audioModel = await ClapAudioModelWithProjection.from_pretrained(id, { dtype: 'q8' });
const { audio_embeds } = await audioModel(await processor(probe));
const a = audio_embeds.tolist()[0];
const an = Math.hypot(...a);
const cos = unit.map((t) => t.reduce((s, x, i) => s + (x * a[i]) / an, 0));

// softmax(scale·cos) must reproduce refProb: solve for scale from the log-odds
// of each label against the first, then take the median.
const scales = labels.slice(1).map((l, i) => Math.log(refProb[l] / refProb[labels[0]]) / (cos[i + 1] - cos[0]))
  .filter(Number.isFinite).sort((x, y) => x - y);
const logitScale = scales[scales.length >> 1];
const ours = (() => {
  const z = cos.map((c) => Math.exp(logitScale * c));
  const s = z.reduce((x, y) => x + y, 0);
  return z.map((v) => v / s);
})();
const maxErr = Math.max(...labels.map((l, i) => Math.abs(ours[i] - refProb[l])));

const out = {
  model: 'laion/clap-htsat-unfused (Xenova ONNX, int8 text encoder)',
  dim,
  logitScale: Math.round(logitScale * 1e4) / 1e4,
  labels: CLAP_LABELS.map((l, i) => ({ ...l, embedding: unit[i].map((x) => Math.round(x * 1e6) / 1e6) })),
};
fs.writeFileSync(path.join(ROOT, 'models', 'clap', 'prompts.json'), JSON.stringify(out));
console.log(`labels ${labels.length} · dim ${dim} · logit_scale ${out.logitScale} · max |p_ours − p_pipeline| = ${maxErr.toExponential(2)}`);
