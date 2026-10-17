// Match report: per-round signal analysis for both players, the judge's
// reasoning, and capture / clock / network diagnostics.

import { linePlot, heatmap, makeRamp } from './plot.js';
import { decodeMel, MEL_CENTERS } from './dsp/analyze.js';
import { ANIMALS } from './dsp/score.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const specRamp = makeRamp(['#120e19', '#3a2238', '#7d3f2a', '#d07a2a', '#ffc978', '#fff3df']);
const mfccRamp = makeRamp(['#199e70', '#3b3743', '#d55181']);
const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

const fmt = (v, digits = 1, unit = '') => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${unit ? ` ${unit}` : ''}`);
const pct = (v, digits = 1) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);
const signed = (v, digits = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`);

function chartBox(title, note) {
  const canvas = el('canvas');
  const box = el('figure', { class: 'chart' }, el('figcaption', {}, el('span', { class: 'chart-title' }, title), note ? el('span', { class: 'chart-note' }, note) : null), el('div', { class: 'chart-wrap' }, canvas));
  return { box, canvas };
}

function legend(items) {
  return el('div', { class: 'legend' }, items.map(([name, color, dashed]) => el('span', {}, el('i', { class: dashed ? 'swatch dashed' : 'swatch', style: `--c:${color}` }), name)));
}

// ---------- per-player panels ----------

function scoreHead(name, color, rep, outcome) {
  const s = rep.score;
  return el('div', { class: 'r-head' },
    el('div', { class: 'r-name' }, el('i', { class: 'swatch', style: `--c:${color}` }), name, outcome === 'win' ? el('span', { class: 'pill win' }, 'Round winner') : null),
    el('div', { class: 'r-score' }, el('span', { class: 'r-big' }, s.score), el('span', { class: 'r-label' }, s.label)),
    el('div', { class: 'r-hint' }, s.hint),
  );
}

function waterfall(score) {
  const rows = score.waterfall.map((w) =>
    el('div', { class: 'wf-row' },
      el('span', { class: 'wf-label' }, w.label, el('small', {}, w.kind === 'delivery' ? ' delivery' : '')),
      el('span', { class: 'wf-track' }, el('span', { class: `wf-fill ${w.kind}`, style: `width:${Math.min(100, w.lost)}%` })),
      el('span', { class: 'wf-val' }, w.lost >= 0.05 ? `−${w.lost.toFixed(1)}` : '0.0'),
    ),
  );
  return el('div', { class: 'waterfall' },
    el('div', { class: 'wf-row wf-total' }, el('span', { class: 'wf-label' }, 'Start'), el('span'), el('span', { class: 'wf-val' }, '100.0')),
    rows,
    el('div', { class: 'wf-row wf-total' }, el('span', { class: 'wf-label' }, 'Final score'), el('span'), el('span', { class: 'wf-val' }, score.score)),
  );
}

function targetText(t) {
  if (t.id === 'contour') return `mean |Δ| ≤ ${t.hi} st`;
  const d = t.digits;
  if (t.hi >= 79) return `≥ ${t.lo.toFixed(d)}${t.unit ? ' ' + t.unit : ''}`;
  if (t.lo <= 0 && t.id !== 'hnr') return `≤ ${t.hi.toFixed(d)}${t.unit ? ' ' + t.unit : ''}`;
  return `${t.lo.toFixed(d)}–${t.hi.toFixed(d)}${t.unit ? ' ' + t.unit : ''}`;
}

function termsTable(score) {
  return el('div', { class: 'table-scroll' }, el('table', { class: 'terms' },
    el('thead', {}, el('tr', {}, ['Feature', 'Measured', 'Target', 'Match', 'Weight', 'Pts lost'].map((h) => el('th', {}, h)))),
    el('tbody', {}, score.terms.map((t) => el('tr', {},
      el('td', {}, t.label),
      el('td', { class: 'num' }, fmt(t.value, t.digits, t.unit)),
      el('td', { class: 'num muted' }, targetText(t) + (t.log ? ` · σ ${t.tol} st` : t.tol != null ? ` · σ ${t.tol}` : '')),
      el('td', {}, el('span', { class: 'meter' }, el('span', { style: `width:${(t.sub * 100).toFixed(0)}%` })), el('span', { class: 'num meter-val' }, t.sub.toFixed(2))),
      el('td', { class: 'num' }, pct(t.weight, 0)),
      el('td', { class: 'num' }, t.lost.toFixed(1)),
    ))),
  ));
}

function featureDump(a) {
  const keys = Object.keys(a.features);
  return el('details', { class: 'dump' },
    el('summary', {}, `Full feature vector (${keys.length} features)`),
    el('div', { class: 'kv' }, keys.map((k) => [el('span', { class: 'muted' }, k), el('span', { class: 'num' }, typeof a.features[k] === 'number' ? +a.features[k].toFixed(4) : String(a.features[k]))])),
  );
}

function times(a) {
  return Array.from({ length: a.frameCount }, (_, t) => (t * a.hop + a.win / 2) / a.sr);
}

function spectrogram(a, color) {
  const { box, canvas } = chartBox('Log-mel spectrogram', '40 bands · 32 ms Hann / 10 ms hop · f0 (YIN) and onsets overlaid');
  const bytes = decodeMel(a.mel);
  const bands = a.mel.bands;
  const loMel = hzToMel(a.mel.fmin);
  const hiMel = hzToMel(a.mel.fmax);
  const rowOfHz = (f) => ((hzToMel(f) - loMel) / (hiMel - loMel)) * (bands + 1) - 1;
  const ts = times(a);
  const ticks = [100, 250, 500, 1000, 2000, 4000].map((f) => ({ row: rowOfHz(f), label: f >= 1000 ? `${f / 1000}k` : String(f) }));
  const render = () => heatmap(canvas, {
    height: 190,
    cols: a.frameCount,
    rows: bands,
    value: (c, r) => bytes[c * bands + r] / 255,
    ramp: specRamp,
    x: { min: ts[0], max: ts[ts.length - 1], format: (v) => `${v.toFixed(1)}s` },
    yTicks: ticks,
    overlay: (ctx, { colX, rowY, bottom, top }) => {
      ctx.fillStyle = css('--vad');
      for (const [s, e] of a.segments) ctx.fillRect(colX(s), bottom - 4, colX(e) - colX(s), 4);
      ctx.strokeStyle = css('--fg');
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      for (const o of a.onsets) {
        ctx.beginPath();
        ctx.moveTo(colX(o), top);
        ctx.lineTo(colX(o), bottom - 5);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = css('--surface');
      const f0 = a.tracks.f0;
      for (let t = 0; t < f0.length; t++) {
        if (!f0[t]) continue;
        ctx.beginPath();
        ctx.arc(colX(t), rowY(rowOfHz(f0[t])), 2.6, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.fillStyle = color;
      for (let t = 0; t < f0.length; t++) {
        if (!f0[t]) continue;
        ctx.beginPath();
        ctx.arc(colX(t), rowY(rowOfHz(f0[t])), 1.6, 0, 2 * Math.PI);
        ctx.fill();
      }
    },
    tooltip: (c, r) => {
      const db = a.mel.dbMax - a.mel.dbRange + (bytes[c * bands + r] / 255) * a.mel.dbRange;
      const f0 = a.tracks.f0[c];
      return `${ts[c].toFixed(2)} s · ${Math.round(MEL_CENTERS[r])} Hz band · ${db.toFixed(1)} dB${f0 ? ` · f0 ${f0.toFixed(1)} Hz` : ''}`;
    },
  });
  return { box, render };
}

function loudnessChart(a, color) {
  const { box, canvas } = chartBox('Level', 'momentary loudness (BS.1770, 400 ms) vs frame RMS');
  const ts = times(a);
  const render = () => linePlot(canvas, {
    height: 150,
    x: { min: ts[0], max: ts[ts.length - 1], format: (v) => `${v.toFixed(1)}s` },
    y: { min: -80, max: 0, label: 'dB', ticks: [-80, -60, -40, -20, 0] },
    series: [
      { name: 'RMS dBFS', color: css('--muted'), xs: ts, ys: a.tracks.rmsDb, width: 1 },
      { name: 'Momentary LUFS', color, xs: ts, ys: a.tracks.lufsM, width: 2 },
    ],
    hlines: [
      { y: a.quality.noiseFloorDb, label: `noise floor ${a.quality.noiseFloorDb.toFixed(0)} dB` },
      { y: a.quality.vadThresholdDb, label: `VAD on ${a.quality.vadThresholdDb.toFixed(0)} dB`, color: css('--vad') },
    ],
    vlines: a.onsets.map((o) => ({ x: ts[o], dash: [2, 3] })),
    format: { x: (v) => `${v.toFixed(2)} s`, y: (v) => `${v.toFixed(1)} dB` },
  });
  return { box: el('div', {}, box, legend([['Momentary LUFS', color], ['RMS dBFS', css('--muted')]])), render };
}

function contourChart(score, color) {
  const c = score.contour;
  const { box, canvas } = chartBox('Pitch contour vs template', `DTW, Sakoe–Chiba band 20% · mean |Δ| ${fmt(c.cost, 2, 'st')} → match ${c.similarity.toFixed(2)}`);
  const xs = c.user.map((_, i) => i / (c.user.length - 1));
  const all = [...c.user, ...c.template];
  const lo = Math.floor(Math.min(...all) - 1);
  const hi = Math.ceil(Math.max(...all) + 1);
  const render = () => linePlot(canvas, {
    height: 150,
    x: { min: 0, max: 1, format: (v) => `${Math.round(v * 100)}%` },
    y: { min: lo, max: hi, label: 'semitones re median' },
    series: [
      { name: 'Template', color: css('--muted'), xs, ys: c.template, dash: [5, 4] },
      { name: 'You', color, xs, ys: c.user },
    ],
    under: (ctx, xMap, yMap) => {
      ctx.strokeStyle = css('--grid-strong');
      ctx.lineWidth = 1;
      for (const [i, j] of c.path.filter((_, k) => k % 2 === 0)) {
        ctx.beginPath();
        ctx.moveTo(xMap(xs[i]), yMap(c.user[i]));
        ctx.lineTo(xMap(xs[j]), yMap(c.template[j]));
        ctx.stroke();
      }
    },
    format: { x: (v) => `t = ${Math.round(v * 100)}%`, y: (v) => `${signed(v, 2)} st` },
  });
  return { box: el('div', {}, box, legend([['Measured contour', color], ['Template', css('--muted'), true], ['DTW alignment', css('--grid-strong')]])), render };
}

function fluxChart(a, color) {
  const { box, canvas } = chartBox('Onset detection', `half-wave rectified log-magnitude spectral flux · ${a.onsets.length} onsets`);
  const ts = times(a);
  const render = () => linePlot(canvas, {
    height: 150,
    x: { min: ts[0], max: ts[ts.length - 1], format: (v) => `${v.toFixed(1)}s` },
    y: { min: 0, max: 1.5, label: 'novelty (norm. p99)' },
    series: [{ name: 'Spectral flux', color, xs: ts, ys: a.tracks.flux, width: 1.5 }],
    hlines: [{ y: 0.15, label: 'abs. threshold' }],
    vlines: a.onsets.map((o) => ({ x: ts[o], dash: [2, 3], color: css('--fg') })),
    format: { x: (v) => `${v.toFixed(2)} s`, y: (v) => v.toFixed(3) },
  });
  return { box, render };
}

function mfccChart(a) {
  const { box, canvas } = chartBox('MFCC c1–c12', 'DCT-II of log-mel energies · row-normalised · c0 (energy) omitted');
  const rows = a.mfcc.data.slice(1);
  const cols = rows[0]?.length || 0;
  const scale = rows.map((r) => Math.max(1e-6, ...r.map(Math.abs)));
  const step = a.mfcc.step;
  const ts = times(a);
  const render = () => heatmap(canvas, {
    height: 130,
    cols,
    rows: rows.length,
    value: (c, r) => 0.5 + (0.5 * rows[r][c]) / scale[r],
    ramp: mfccRamp,
    x: { min: ts[0], max: ts[ts.length - 1], format: (v) => `${v.toFixed(1)}s` },
    yTicks: [0, 5, 11].map((r) => ({ row: r, label: `c${r + 1}` })),
    tooltip: (c, r) => `c${r + 1} @ ${(ts[c * step] ?? 0).toFixed(2)} s = ${rows[r][c].toFixed(1)}`,
  });
  return { box: el('div', {}, box, legend([['negative', '#199e70'], ['0', '#3b3743'], ['positive', '#d55181']])), render };
}

function playerPanel(name, color, rep, outcome) {
  const renders = [];
  const add = (part) => {
    renders.push(part.render);
    return part.box;
  };
  const a = rep.analysis;
  const panel = el('div', { class: 'r-panel' }, scoreHead(name, color, rep, outcome), waterfall(rep.score));
  if (!a) {
    panel.append(el('p', { class: 'muted' }, 'No audio was received from this player for this round.'));
    return { panel, renders };
  }
  panel.append(
    add(spectrogram(a, color)),
    add(loudnessChart(a, color)),
    rep.score.contour && rep.score.contour.user.length ? add(contourChart(rep.score, color)) : add(fluxChart(a, color)),
    el('h4', {}, 'How the judge scored it'),
    termsTable(rep.score),
    add(mfccChart(a)),
    featureDump(a),
  );
  return { panel, renders };
}

// ---------- match-level sections ----------

function summaryTable(match) {
  const solo = match.mode === 'practice';
  return el('div', { class: 'table-scroll' }, el('table', { class: 'summary' },
    el('thead', {}, el('tr', {}, ['Round', 'Animal', 'You', solo ? null : match.them.name, solo ? null : 'Margin', solo ? null : 'Winner', 'Your biggest loss'].filter(Boolean).map((h) => el('th', {}, h)))),
    el('tbody', {}, match.rounds.map((r) => {
      const worst = r.you.score.terms.reduce((a, b) => (b.lost > a.lost ? b : a));
      const margin = r.them ? r.you.score.score - r.them.score.score : null;
      return el('tr', {},
        el('td', { class: 'num' }, r.round),
        el('td', {}, `${ANIMALS[r.animal].emoji} ${ANIMALS[r.animal].name}`),
        el('td', { class: 'num' }, r.you.score.score),
        solo ? null : el('td', { class: 'num' }, r.them.score.score),
        solo ? null : el('td', { class: 'num' }, signed(margin, 0)),
        solo ? null : el('td', {}, el('span', { class: `pill ${r.outcome}` }, { win: 'You', lose: match.them.name, tie: 'Tie' }[r.outcome])),
        el('td', { class: 'muted' }, `${worst.label} (−${worst.lost.toFixed(1)})`),
      );
    })),
  ));
}

function trajectoryChart(match) {
  if (match.rounds.length < 2) return null;
  const { box, canvas } = chartBox('Score by round');
  const xs = match.rounds.map((r) => r.round);
  const series = [{ name: 'You', color: css('--you'), xs, ys: match.rounds.map((r) => r.you.score.score) }];
  if (match.mode !== 'practice') series.push({ name: match.them.name, color: css('--them'), xs, ys: match.rounds.map((r) => r.them.score.score) });
  const markers = series.map((s) => ({ ...s, points: 4, noTip: true }));
  const render = () => linePlot(canvas, {
    height: 160,
    x: { min: xs[0] - 0.2, max: xs[xs.length - 1] + 0.2, ticks: xs, format: (v) => `R${v}` },
    y: { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] },
    series: [...series, ...markers],
    format: { x: (v) => `Round ${v}`, y: (v) => v.toFixed(0) },
  });
  return { box: el('div', {}, box, legend(series.map((s) => [s.name, s.color]))), render };
}

function diagnosticsTable(match) {
  const rows = [];
  for (const r of match.rounds) {
    for (const [who, rep] of [['You', r.you], [match.them?.name, r.them]]) {
      if (!rep || !who) continue;
      const q = rep.analysis?.quality || {};
      const m = rep.meta || {};
      rows.push(el('tr', {},
        el('td', {}, `R${r.round} · ${who}`),
        el('td', { class: 'num' }, m.inputRate ? `${(m.inputRate / 1000).toFixed(1)}k→16k` : '—'),
        el('td', { class: 'num' }, fmt(m.startErrorMs, 2, 'ms')),
        el('td', { class: 'num' }, fmt(m.scheduleLeadMs, 0, 'ms')),
        el('td', { class: 'num' }, fmt(m.rawPeakDbfs, 1)),
        el('td', { class: 'num' }, pct(m.rawClipRatio, 2)),
        el('td', { class: 'num' }, q.dcOffset != null ? q.dcOffset.toExponential(1) : '—'),
        el('td', { class: 'num' }, fmt(q.noiseFloorDb, 1)),
        el('td', { class: 'num' }, fmt(q.snrDb, 1)),
        el('td', { class: 'num' }, fmt(q.crestDb, 1)),
        el('td', { class: 'num' }, fmt(rep.analysis?.features.lufsIntegrated, 1)),
        el('td', { class: 'num' }, fmt(m.resampleMs, 1)),
        el('td', { class: 'num' }, fmt(m.serverMs ?? rep.analysis?.analysisMs, 1)),
        el('td', { class: 'num' }, m.uploadBytes ? `${(m.uploadBytes / 1024).toFixed(0)} KB / ${fmt(m.uploadDelayMs, 0, 'ms')}` : '—'),
      ));
    }
  }
  const heads = ['Capture', 'Resample', 'Start error', 'Scheduled ahead', 'Raw peak dBFS', 'Clipped', 'DC offset', 'Noise floor dB', 'SNR dB', 'Crest dB', 'Integrated LUFS', 'Resample ms', 'DSP ms', 'Upload'];
  return el('div', { class: 'table-scroll' }, el('table', { class: 'diag' }, el('thead', {}, el('tr', {}, heads.map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
}

function kvGrid(pairs) {
  return el('div', { class: 'kv' }, pairs.map(([k, v]) => [el('span', { class: 'muted' }, k), el('span', { class: 'num' }, v)]));
}

function networkSection(match) {
  const net = match.net;
  const renders = [];
  const parts = [];
  if (!net || !net.samples.length) {
    parts.push(el('p', { class: 'muted' }, match.mode === 'practice' ? 'Practice mode has no peer connection.' : 'No WebRTC statistics were collected (the call never connected).'));
    return { node: el('div', {}, parts), renders };
  }
  const s = net.samples;
  const t0 = s[0].t;
  const xs = s.map((p) => (p.t - t0) / 1000);
  const latency = chartBox('Peer link latency', 'ICE candidate-pair RTT and inbound audio jitter (RFC 3550)');
  renders.push(() => linePlot(latency.canvas, {
    height: 150,
    x: { min: 0, max: Math.max(1, xs[xs.length - 1]), format: (v) => `${v.toFixed(0)}s` },
    y: { min: 0, max: Math.max(20, ...s.map((p) => Math.max(p.rttMs ?? 0, p.jitterMs ?? 0))) * 1.15, label: 'ms' },
    series: [
      { name: 'RTT', color: css('--you'), xs, ys: s.map((p) => p.rttMs) },
      { name: 'Jitter', color: css('--them'), xs, ys: s.map((p) => p.jitterMs) },
    ],
    format: { x: (v) => `${v.toFixed(0)} s`, y: (v) => `${v.toFixed(1)} ms` },
  }));
  const loss = chartBox('Inbound audio impairment', 'packet loss and concealed (PLC) samples, per 1 s interval');
  renders.push(() => linePlot(loss.canvas, {
    height: 130,
    x: { min: 0, max: Math.max(1, xs[xs.length - 1]), format: (v) => `${v.toFixed(0)}s` },
    y: { min: 0, max: Math.max(2, ...s.map((p) => Math.max(p.lossPct ?? 0, p.concealPct ?? 0))) * 1.15, label: '%' },
    series: [
      { name: 'Packet loss', color: css('--you'), xs, ys: s.map((p) => p.lossPct) },
      { name: 'Concealed', color: css('--them'), xs, ys: s.map((p) => p.concealPct) },
    ],
    format: { x: (v) => `${v.toFixed(0)} s`, y: (v) => `${v.toFixed(2)}%` },
  }));
  const avg = (k) => {
    const v = s.map((p) => p[k]).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  parts.push(
    kvGrid([
      ['ICE path', net.path || '—'],
      ['Audio codec', net.audioCodec || '—'],
      ['Video codec', net.videoCodec || '—'],
      ['Mean RTT', fmt(avg('rttMs'), 1, 'ms')],
      ['Mean jitter', fmt(avg('jitterMs'), 1, 'ms')],
      ['Audio in / out', `${fmt(avg('audioKbpsIn'), 1)} / ${fmt(avg('audioKbpsOut'), 1)} kbps`],
      ['Total in / out', `${fmt(avg('kbpsIn'), 0)} / ${fmt(avg('kbpsOut'), 0)} kbps`],
      ['Samples', `${s.length} × 1 s`],
    ]),
    el('div', { class: 'grid-2' },
      el('div', {}, latency.box, legend([['RTT', css('--you')], ['Jitter', css('--them')]])),
      el('div', {}, loss.box, legend([['Packet loss', css('--you')], ['Concealed', css('--them')]])),
    ),
  );
  return { node: el('div', {}, parts), renders };
}

function syncSection(match) {
  const c = match.clock || {};
  return kvGrid([
    ['Server clock offset', c.offsetMs != null ? `${signed(c.offsetMs, 1)} ms ± ${(c.rttMs / 2).toFixed(1)} ms` : '—'],
    ['Min signalling RTT', fmt(c.rttMs, 1, 'ms')],
    ['Sync samples', c.samples ?? '—'],
    ['AudioContext rate', match.audio?.sampleRate ? `${match.audio.sampleRate} Hz` : '—'],
    ['Base latency', fmt(match.audio?.baseLatencyMs, 1, 'ms')],
    ['Output latency', fmt(match.audio?.outputLatencyMs, 1, 'ms')],
  ]);
}

function methodology() {
  return el('details', { class: 'dump method' },
    el('summary', {}, 'Methodology'),
    el('ol', {},
      el('li', {}, 'Capture: an AudioWorklet records exactly 4.000 s starting on the sample that matches the server-scheduled start, using an NTP-style clock offset (minimum-RTT filter over ping/pong samples) and AudioContext.getOutputTimestamp() to map wall-clock to audio-clock time. Mic DSP: echo cancellation on, AGC and noise suppression off so level is measurable.'),
      el('li', {}, 'Resampling: native rate → 16 kHz with a Blackman-windowed sinc interpolator (16 zero crossings, cutoff 0.94 × output Nyquist), then int16 PCM uploaded to the server. The server runs the DSP below and scores. Clients never report their own score.'),
      el('li', {}, 'Framing: DC removal, 512-sample (32 ms) Hann frames at a 160-sample (10 ms) hop, radix-2 FFT. Per frame: RMS, zero-crossing rate, spectral centroid / 85% roll-off / flatness over 60 Hz–7.8 kHz, spectral tilt (least-squares dB per octave across mel bands), 40-band HTK mel energies, 13 MFCCs (orthonormal DCT-II of log-mel).'),
      el('li', {}, 'Pitch: YIN with a 25 ms integration window, 70–1100 Hz search, CMND threshold 0.20, parabolic refinement; HNR estimated from aperiodicity as 10·log₁₀((1−d′)/d′); f0 median-filtered (5 frames), runs < 3 frames dropped.'),
      el('li', {}, 'Activity: noise floor = 10th-percentile frame RMS; hysteresis VAD at floor + 12 dB (on) / −6 dB (off), gaps ≤ 50 ms merged, segments < 40 ms dropped.'),
      el('li', {}, 'Onsets: half-wave rectified log-magnitude spectral flux normalised to its 99th percentile; peaks above a local mean + 0.1 and an absolute 0.15, ≥ 80 ms apart, confirmed by a ≥ 4 dB energy rise; VAD segment starts are added when no flux onset is within 60 ms.'),
      el('li', {}, 'Loudness: ITU-R BS.1770 K-weighting re-derived at 16 kHz and calibrated to +0.691 dB at 1 kHz; momentary loudness over 400 ms windows; integrated loudness with −70 LUFS absolute and −10 LU relative gates.'),
      el('li', {}, 'Judging: each feature target scores 1 inside its range and decays as a Gaussian of the distance outside it (in semitones for pitch). Tonal animals also match the pitch contour (48 points, median-centred) against a template with DTW; match = exp(−mean|Δ| / 3 st). Score = 100 · accuracy · (0.6 + 0.3 · volume + 0.1 · gusto); the waterfall gives the exact points each term cost.'),
    ),
  );
}

// ---------- entry ----------

export function renderReport(root, match, { onBack }) {
  root.replaceChildren();
  const solo = match.mode === 'practice';
  const youTotal = match.rounds.reduce((a, r) => a + r.you.score.score, 0);
  const themTotal = solo ? 0 : match.rounds.reduce((a, r) => a + r.them.score.score, 0);
  const pendingRenders = [];

  const download = el('button', { class: 'secondary', onclick: () => {
    const blob = new Blob([JSON.stringify(match, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `barkoff-report-${new Date(match.startedAt).toISOString().slice(0, 19).replace(/:/g, '')}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } }, 'Download raw data (JSON)');

  const headline = solo
    ? `${match.rounds.length} practice round${match.rounds.length === 1 ? '' : 's'}`
    : `You ${match.wins.you}–${match.wins.them} ${match.them.name}`;

  root.append(
    el('div', { class: 'rep-top' },
      el('div', {},
        el('p', { class: 'eyebrow' }, solo ? 'Practice report' : 'Match report'),
        el('h2', {}, headline),
        el('p', { class: 'muted' }, solo
          ? `Analysed in your browser · total ${youTotal} pts`
          : `${match.rounds.length} rounds · scored server-side · total points ${youTotal} vs ${themTotal}`),
      ),
      el('div', { class: 'buttons' }, download, el('button', { onclick: onBack }, solo ? 'Back to practice' : 'Back to the arena')),
    ),
  );

  const traj = trajectoryChart(match);
  root.append(el('section', { class: 'rep-sec' }, el('h3', {}, 'Rounds'), summaryTable(match), traj?.box));
  if (traj) pendingRenders.push(traj.render);

  // Round detail with tabs
  const detail = el('div', { class: 'round-detail' });
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  let current = match.rounds.length - 1;
  let detailRenders = [];
  const showRound = (i) => {
    current = i;
    [...tabs.children].forEach((b, j) => b.setAttribute('aria-selected', String(j === i)));
    const r = match.rounds[i];
    const a = ANIMALS[r.animal];
    const you = playerPanel('You', css('--you'), r.you, r.outcome === 'win' ? 'win' : null);
    const them = r.them ? playerPanel(match.them.name, css('--them'), r.them, r.outcome === 'lose' ? 'win' : null) : null;
    detail.replaceChildren(
      el('p', { class: 'round-brief' }, `Round ${r.round}: ${a.emoji} ${a.name} (“${a.sound}”) · ${a.tip}`),
      el('div', { class: them ? 'grid-2' : 'grid-1' }, you.panel, them?.panel),
    );
    detailRenders = [...you.renders, ...(them ? them.renders : [])];
    requestAnimationFrame(() => detailRenders.forEach((f) => f()));
  };
  match.rounds.forEach((r, i) => tabs.append(el('button', { class: 'tab', role: 'tab', onclick: () => showRound(i) }, `R${r.round} ${ANIMALS[r.animal].emoji} ${ANIMALS[r.animal].name}`)));
  root.append(el('section', { class: 'rep-sec' }, el('h3', {}, 'Round analysis'), tabs, detail));

  const net = networkSection(match);
  pendingRenders.push(...net.renders);
  root.append(
    el('section', { class: 'rep-sec' },
      el('h3', {}, 'Diagnostics'),
      el('h4', {}, 'Capture & signal chain'),
      diagnosticsTable(match),
      el('h4', {}, 'Clock synchronisation'),
      syncSection(match),
      el('h4', {}, 'Peer connection'),
      net.node,
    ),
    el('section', { class: 'rep-sec' }, methodology()),
  );

  showRound(current);
  requestAnimationFrame(() => pendingRenders.forEach((f) => f()));

  let pending = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => [...pendingRenders, ...detailRenders].forEach((f) => f()));
  });
  ro.observe(root);
  return () => ro.disconnect();
}

