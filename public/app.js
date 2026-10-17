import { analyze, serializeAnalysis, encodePcm16, SAMPLE_RATE } from './dsp/analyze.js';
import { resample, toInt16 } from './dsp/resample.js';
import { ANIMALS, ANIMAL_IDS, scoreBark } from './dsp/score.js';
import { renderReport } from './report.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wallNow = () => performance.timeOrigin + performance.now();
const PRACTICE_COUNTDOWN_MS = 3000;
const RECORD_MS = 4000;

let mode = null; // 'online' | 'practice' | null
let ws = null;
let pc = null;
let signalChain = Promise.resolve();
let pendingCandidates = [];

let localStream = null;
let audioCtx = null;
let localAnalyser = null;
let remoteAnalyser = null;
let remoteSource = null;
let captureNode = null;
let captureJobs = new Map();
let nextJobId = 1;

let roundToken = 0;
let match = null; // everything the report needs, accumulated during play
let disposeReport = null;

// ---------- clock sync (NTP-style, minimum-RTT filter) ----------

const clock = { samples: [], offsetMs: 0, rttMs: null, pending: new Map(), timer: null };

function ping() {
  const id = Math.random().toString(36).slice(2);
  clock.pending.set(id, wallNow());
  send({ type: 'ping', id });
}

function onPong({ id, ts }) {
  const t0 = clock.pending.get(id);
  if (t0 == null) return;
  clock.pending.delete(id);
  const t1 = wallNow();
  const rtt = t1 - t0;
  clock.samples.push({ rtt, offset: ts - (t0 + t1) / 2 });
  if (clock.samples.length > 30) clock.samples.shift();
  // The sample with the smallest round trip has the tightest error bound (±RTT/2).
  const best = clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  clock.offsetMs = best.offset;
  clock.rttMs = best.rtt;
}

async function startClockSync() {
  clearInterval(clock.timer);
  clock.samples = [];
  for (let i = 0; i < 10; i++) {
    ping();
    await sleep(80);
  }
  clock.timer = setInterval(ping, 5000);
}

const serverToPerf = (serverMs) => serverMs - clock.offsetMs - performance.timeOrigin;

// ---------- media & audio ----------

async function ensureMedia() {
  if (localStream) return;
  const audio = { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio, video: $('cam').checked });
  } catch (err) {
    if (!$('cam').checked) throw err;
    localStream = await navigator.mediaDevices.getUserMedia({ audio });
  }
  $('localVideo').srcObject = localStream;

  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('capture-worklet.js');
  const source = audioCtx.createMediaStreamSource(localStream);
  localAnalyser = makeAnalyser();
  source.connect(localAnalyser);

  // The capture node must be pulled by the graph to run; its output is silent.
  captureNode = new AudioWorkletNode(audioCtx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  source.connect(captureNode).connect(mute).connect(audioCtx.destination);
  captureNode.port.onmessage = ({ data }) => {
    const job = captureJobs.get(data.id);
    if (!job) return;
    captureJobs.delete(data.id);
    job.resolve(data);
  };

  startSpectrogram($('localSpec'), () => localAnalyser);
  startSpectrogram($('remoteSpec'), () => remoteAnalyser);
}

function makeAnalyser() {
  const a = audioCtx.createAnalyser();
  a.fftSize = 2048;
  a.smoothingTimeConstant = 0;
  return a;
}

// Map a performance.now() instant onto the AudioContext timeline.
function perfToContextTime(perfMs) {
  const ts = audioCtx.getOutputTimestamp ? audioCtx.getOutputTimestamp() : null;
  if (ts && ts.performanceTime) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
  return audioCtx.currentTime + (perfMs - performance.now()) / 1000;
}

// Schedule a sample-accurate capture on the audio thread.
function capture(startPerfMs, durationMs) {
  const id = nextJobId++;
  const startTime = perfToContextTime(startPerfMs);
  const frames = Math.round((durationMs / 1000) * audioCtx.sampleRate);
  const scheduleLeadMs = (startTime - audioCtx.currentTime) * 1000;
  const promise = new Promise((resolve, reject) => {
    captureJobs.set(id, { resolve });
    setTimeout(() => {
      if (captureJobs.delete(id)) reject(new Error('capture timed out'));
    }, Math.max(0, startPerfMs - performance.now()) + durationMs + 3000);
  });
  captureNode.port.postMessage({ cmd: 'start', id, startTime, frames });
  return {
    id,
    promise: promise.then((d) => ({ ...d, startErrorMs: (d.began - startTime) * 1000, scheduleLeadMs })),
  };
}

function cancelCaptures() {
  for (const id of captureJobs.keys()) captureNode?.port.postMessage({ cmd: 'cancel', id });
  captureJobs.clear();
}

function prepareUpload(cap) {
  const raw = cap.samples;
  let peak = 0, clipped = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = Math.abs(raw[i]);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
  }
  const t0 = performance.now();
  const pcm16k = resample(raw, cap.sampleRate, SAMPLE_RATE);
  const resampleMs = performance.now() - t0;
  return {
    pcm16k,
    meta: {
      inputRate: cap.sampleRate,
      captureFrames: raw.length,
      startErrorMs: cap.startErrorMs,
      scheduleLeadMs: cap.scheduleLeadMs,
      syncOffsetMs: clock.offsetMs,
      syncRttMs: clock.rttMs,
      baseLatencyMs: (audioCtx.baseLatency || 0) * 1000,
      outputLatencyMs: (audioCtx.outputLatency || 0) * 1000,
      rawPeakDbfs: 20 * Math.log10(peak + 1e-9),
      rawClipRatio: clipped / raw.length,
      resampleMs,
    },
  };
}

function startSpectrogram(canvas, getAnalyser) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const maxHz = 5000;
  const minHz = 60;
  let data = null;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  (function draw() {
    requestAnimationFrame(draw);
    const a = getAnalyser();
    ctx.drawImage(canvas, -2, 0);
    if (!a) {
      ctx.fillStyle = '#000';
      ctx.fillRect(w - 2, 0, 2, h);
      return;
    }
    if (!data || data.length !== a.frequencyBinCount) data = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(data);
    const nyquist = audioCtx.sampleRate / 2;
    for (let y = 0; y < h; y++) {
      const hz = minHz * Math.pow(maxHz / minHz, 1 - y / h); // log frequency axis
      const v = data[Math.min(data.length - 1, Math.round((hz / nyquist) * data.length))];
      ctx.fillStyle = `hsl(${30 + v * 0.06}, 100%, ${(v / 255) * 70}%)`;
      ctx.fillRect(w - 2, y, 2, 1);
    }
  })();
}

// ---------- rounds ----------

function cancelRound() {
  roundToken++;
  cancelCaptures();
  $('banner').classList.remove('go');
  $('youCard').classList.remove('recording');
}

// Counts down to `startPerfMs`, captures RECORD_MS, returns the capture.
async function runRound({ roundLabel, animal, startPerfMs, recordMs }) {
  cancelRound();
  const token = roundToken;
  const a = ANIMALS[animal];
  clearResults();
  setBanner({ round: roundLabel, emoji: a.emoji, sound: a.sound, tip: `${a.name} · ${a.tip}`, countdown: '' });

  const job = capture(startPerfMs, recordMs);

  for (;;) {
    const left = startPerfMs - performance.now();
    if (left <= 0) break;
    $('countdown').textContent = Math.ceil(left / 1000);
    await sleep(Math.min(left, (left % 1000) + 5));
    if (token !== roundToken) return null;
  }

  $('countdown').textContent = 'GO!';
  $('banner').classList.add('go');
  $('youCard').classList.add('recording');
  let cap;
  try {
    cap = await job.promise;
  } catch (err) {
    console.warn(err);
    cap = null;
  }
  if (token !== roundToken) return null;
  $('banner').classList.remove('go');
  $('youCard').classList.remove('recording');
  $('countdown').textContent = 'Judging…';
  return cap;
}

function clearResults() {
  for (const id of ['youResult', 'themResult']) $(id).innerHTML = '';
  $('youCard').classList.remove('won');
  $('themCard').classList.remove('won');
}

function setBanner({ round = '', emoji = '🐾', sound = '', tip = '', countdown = '' }) {
  $('roundLabel').textContent = round;
  $('animalEmoji').textContent = emoji;
  $('animalSound').textContent = sound;
  $('animalTip').textContent = tip;
  $('countdown').textContent = countdown;
}

function renderResult(el, score, outcome, showHint) {
  const pct = (x) => Math.round(x * 100);
  const bar = (name, x) =>
    `<div class="bar"><span>${name}</span><div class="track"><div class="fill" style="width:${pct(x)}%"></div></div></div>`;
  const outcomeText = { win: 'WINS', lose: '', tie: 'TIE' }[outcome] || '';
  el.innerHTML =
    `<div><span class="big">${Number(score.score)}</span><span class="label"></span>` +
    (outcomeText ? `<span class="outcome ${outcome}">${outcomeText}</span>` : '') +
    `</div>` +
    bar('Accuracy', score.breakdown.accuracy) +
    bar('Volume', score.breakdown.volume) +
    bar('Gusto', score.breakdown.gusto) +
    (showHint ? `<div class="hint-line"></div>` : '');
  el.querySelector('.label').textContent = score.label;
  if (showHint) el.querySelector('.hint-line').textContent = `Tip: ${score.hint}`;
}

function setWins(you, them) {
  $('youWins').textContent = '🦴'.repeat(you);
  $('themWins').textContent = '🦴'.repeat(them);
}

function setStatus(text) {
  $('status').textContent = text;
}

function newMatch(modeName, opponent) {
  return {
    mode: modeName,
    startedAt: Date.now(),
    you: { name: $('name').value.trim() || 'You' },
    them: { name: opponent || null },
    rounds: [],
    wins: { you: 0, them: 0 },
    outcome: null,
    clock: null,
    audio: { sampleRate: audioCtx.sampleRate, baseLatencyMs: (audioCtx.baseLatency || 0) * 1000, outputLatencyMs: (audioCtx.outputLatency || 0) * 1000 },
    net: { samples: [], path: null, audioCodec: null, videoCodec: null },
  };
}

function snapshotClock() {
  match.clock = { offsetMs: clock.offsetMs, rttMs: clock.rttMs, samples: clock.samples.length };
}

// ---------- practice ----------

async function startPractice() {
  if (mode !== 'practice' || !match) match = newMatch('practice');
  mode = 'practice';
  showArena(true);
  setStatus('Practice mode. Analysed locally with the same DSP the server uses.');
  const animal = ANIMAL_IDS[Math.floor(Math.random() * ANIMAL_IDS.length)];
  $('nextBtn').disabled = true;
  const cap = await runRound({
    roundLabel: `Practice · round ${match.rounds.length + 1}`,
    animal,
    startPerfMs: performance.now() + PRACTICE_COUNTDOWN_MS,
    recordMs: RECORD_MS,
  });
  $('nextBtn').disabled = false;
  if (!cap || mode !== 'practice') return;

  const { pcm16k, meta } = prepareUpload(cap);
  const analysis = analyze(pcm16k, SAMPLE_RATE);
  const score = scoreBark(animal, analysis);
  meta.scoredBy = 'browser';
  match.rounds.push({ round: match.rounds.length + 1, animal, outcome: null, you: { analysis: serializeAnalysis(analysis), score, meta }, them: null });
  $('countdown').textContent = '';
  renderResult($('youResult'), score, null, true);
  $('reportBtn').hidden = false;
}

// ---------- online ----------

function connect() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    sock.onopen = () => {
      ws = sock;
      startClockSync();
      resolve();
    };
    sock.onerror = () => reject(new Error('Could not reach the Barkoff server.'));
    sock.onmessage = (e) => onMessage(JSON.parse(e.data));
    sock.onclose = () => {
      ws = null;
      clearInterval(clock.timer);
      if (mode === 'online') {
        cancelRound();
        teardownPeer();
        setStatus('Lost connection to the server. Hit Next to reconnect.');
      }
    };
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function findMatch() {
  mode = 'online';
  showArena(false);
  setStatus('Connecting…');
  try {
    if (!ws) await connect();
  } catch (err) {
    setStatus(err.message);
    return;
  }
  send({ type: 'join', name: $('name').value });
}

function onMessage(msg) {
  if (msg.type === 'pong') {
    onPong(msg);
    return;
  }
  if (mode !== 'online') return;
  switch (msg.type) {
    case 'waiting':
      cancelRound();
      teardownPeer();
      clearResults();
      setWins(0, 0);
      $('reportBtn').hidden = true;
      $('themName').textContent = '…';
      setBanner({ emoji: '🐾', sound: 'Sniffing around…', tip: 'Waiting for another barker to show up.' });
      setStatus('Looking for someone to bark at…');
      break;
    case 'matched':
      clearResults();
      setWins(0, 0);
      $('reportBtn').hidden = true;
      match = newMatch('online', msg.opponent);
      $('themName').textContent = msg.opponent;
      setBanner({ emoji: '👀', sound: `vs ${msg.opponent}`, tip: 'Get ready…' });
      setStatus(`Matched with ${msg.opponent}!`);
      setupPeer(msg.initiator);
      break;
    case 'signal':
      signalChain = signalChain.then(() => handleSignal(msg.data)).catch((e) => console.warn('signal', e));
      break;
    case 'round':
      onRound(msg);
      break;
    case 'roundResult':
      onRoundResult(msg);
      break;
    case 'gameOver':
      onGameOver(msg);
      break;
    case 'opponentLeft':
      cancelRound();
      teardownPeer();
      setBanner({ emoji: '💨', sound: `${msg.name} ran away`, tip: 'Hit Next to find someone new.' });
      setStatus('Your opponent left.');
      $('reportBtn').hidden = !(match && match.rounds.length);
      break;
  }
}

async function onRound(msg) {
  setStatus(`Round ${msg.round} · clock offset ${clock.offsetMs.toFixed(1)} ms ± ${((clock.rttMs || 0) / 2).toFixed(1)} ms`);
  const cap = await runRound({
    roundLabel: msg.round > msg.total ? `Sudden death · Round ${msg.round}` : `Round ${msg.round} of ${msg.total}`,
    animal: msg.animal,
    startPerfMs: serverToPerf(msg.recordStartAt),
    recordMs: msg.recordMs,
  });
  if (!cap) return;
  const { pcm16k, meta } = prepareUpload(cap);
  $('youResult').textContent = 'Uploading audio…';
  $('themResult').textContent = 'Judging…';
  send({ type: 'audio', round: msg.round, pcm: encodePcm16(toInt16(pcm16k)), meta });
  $('youResult').textContent = 'Judging…';
}

function onRoundResult(msg) {
  cancelRound();
  $('countdown').textContent = '';
  snapshotClock();
  match.rounds.push({ round: msg.round, animal: msg.animal, outcome: msg.outcome, you: msg.you, them: msg.them });
  match.wins = msg.wins;
  renderResult($('youResult'), msg.you.score, msg.outcome, true);
  renderResult($('themResult'), msg.them.score, msg.outcome === 'win' ? 'lose' : msg.outcome === 'lose' ? 'win' : 'tie', false);
  if (msg.outcome === 'win') $('youCard').classList.add('won');
  if (msg.outcome === 'lose') $('themCard').classList.add('won');
  setWins(msg.wins.you, msg.wins.them);
  setStatus({ win: 'You won the round!', lose: 'They won the round.', tie: 'Tie round!' }[msg.outcome]);
}

function onGameOver(msg) {
  match.outcome = msg.outcome;
  match.wins = msg.wins;
  snapshotClock();
  const banners = {
    win: { emoji: '🏆', sound: "You're the Top Dog!" },
    lose: { emoji: '🐕‍🦺', sound: 'Out-barked.' },
    tie: { emoji: '🤝', sound: 'Dead heat.' },
  };
  setBanner({
    round: `Final ${msg.wins.you}–${msg.wins.them}`,
    ...banners[msg.outcome],
    tip: 'Opening the match report…',
  });
  $('reportBtn').hidden = false;
  const finished = match;
  setTimeout(() => {
    if (match === finished && mode === 'online' && $('report').hidden) showReport();
  }, 3000);
}

// ---------- WebRTC ----------

function setupPeer(initiator) {
  teardownPeer();
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'signal', data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    $('remoteVideo').srcObject = stream;
    if (e.track.kind === 'audio' && !remoteSource) {
      remoteSource = audioCtx.createMediaStreamSource(stream);
      remoteAnalyser = makeAnalyser();
      remoteSource.connect(remoteAnalyser);
    }
  };
  if (initiator) {
    pc.onnegotiationneeded = async () => {
      await pc.setLocalDescription();
      send({ type: 'signal', data: { sdp: pc.localDescription } });
    };
  }
  startStatsSampler(pc);
}

async function handleSignal(data) {
  if (!pc) return;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      await pc.setLocalDescription();
      send({ type: 'signal', data: { sdp: pc.localDescription } });
    }
    for (const c of pendingCandidates) await pc.addIceCandidate(c);
    pendingCandidates = [];
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
    else pendingCandidates.push(data.candidate);
  }
}

let statsTimer = null;

// Samples getStats() once a second and stores per-interval deltas.
function startStatsSampler(conn) {
  clearInterval(statsTimer);
  let prev = null;
  statsTimer = setInterval(async () => {
    if (conn !== pc || !match) return;
    let report;
    try {
      report = await conn.getStats();
    } catch {
      return;
    }
    const byType = {};
    report.forEach((r) => (byType[r.type] ||= []).push(r));
    const transport = byType.transport?.[0];
    const pair = (transport?.selectedCandidatePairId && report.get(transport.selectedCandidatePairId)) ||
      byType['candidate-pair']?.find((p) => p.nominated && p.state === 'succeeded');
    if (!pair) return;
    const inbound = byType['inbound-rtp'] || [];
    const outbound = byType['outbound-rtp'] || [];
    const inA = inbound.find((r) => r.kind === 'audio');
    const outA = outbound.find((r) => r.kind === 'audio');
    const inV = inbound.find((r) => r.kind === 'video');
    const sum = (rs, k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
    const cur = {
      t: performance.now(),
      bytesIn: sum(inbound, 'bytesReceived'),
      bytesOut: sum(outbound, 'bytesSent'),
      audioIn: inA?.bytesReceived || 0,
      audioOut: outA?.bytesSent || 0,
      lost: inA?.packetsLost || 0,
      recv: inA?.packetsReceived || 0,
      concealed: inA?.concealedSamples || 0,
      samples: inA?.totalSamplesReceived || 0,
    };
    if (prev) {
      const dt = (cur.t - prev.t) / 1000;
      const dLost = cur.lost - prev.lost;
      const dRecv = cur.recv - prev.recv;
      const dSamples = cur.samples - prev.samples;
      match.net.samples.push({
        t: Date.now(),
        rttMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
        jitterMs: inA?.jitter != null ? inA.jitter * 1000 : null,
        lossPct: dLost + dRecv > 0 ? (100 * Math.max(0, dLost)) / (dLost + dRecv) : 0,
        concealPct: dSamples > 0 ? (100 * (cur.concealed - prev.concealed)) / dSamples : 0,
        kbpsIn: ((cur.bytesIn - prev.bytesIn) * 8) / 1000 / dt,
        kbpsOut: ((cur.bytesOut - prev.bytesOut) * 8) / 1000 / dt,
        audioKbpsIn: ((cur.audioIn - prev.audioIn) * 8) / 1000 / dt,
        audioKbpsOut: ((cur.audioOut - prev.audioOut) * 8) / 1000 / dt,
      });
      if (match.net.samples.length > 900) match.net.samples.shift();
    }
    prev = cur;
    const local = report.get(pair.localCandidateId);
    const remote = report.get(pair.remoteCandidateId);
    if (local && remote) {
      const relayed = local.candidateType === 'relay' || remote.candidateType === 'relay';
      match.net.path = `${local.candidateType} ↔ ${remote.candidateType} · ${local.protocol || '?'}${relayed ? ' · relayed (TURN)' : ' · direct'}`;
    }
    const codec = (r) => (r?.codecId ? report.get(r.codecId)?.mimeType : null);
    match.net.audioCodec = codec(inA) || match.net.audioCodec;
    match.net.videoCodec = codec(inV) || match.net.videoCodec;
  }, 1000);
}

function teardownPeer() {
  clearInterval(statsTimer);
  if (pc) pc.close();
  pc = null;
  pendingCandidates = [];
  signalChain = Promise.resolve();
  if (remoteSource) remoteSource.disconnect();
  remoteSource = null;
  remoteAnalyser = null;
  $('remoteVideo').srcObject = null;
}

// ---------- screens ----------

function showArena(solo) {
  document.body.classList.remove('home');
  $('lobby').hidden = true;
  $('report').hidden = true;
  $('arena').hidden = false;
  $('themCard').hidden = solo;
  document.querySelector('.players').classList.toggle('solo', solo);
  $('nextBtn').textContent = solo ? 'Another animal' : 'Next opponent';
  $('nextBtn').disabled = false;
  $('reportBtn').textContent = solo ? 'View practice report' : 'View match report';
  $('reportBtn').hidden = !(match && match.rounds.length && match.mode === (solo ? 'practice' : 'online'));
  clearResults();
  if (!solo) setWins(0, 0);
  setBanner({});
}

function showReport() {
  if (!match || !match.rounds.length) return;
  if (disposeReport) disposeReport();
  $('arena').hidden = true;
  $('report').hidden = false;
  window.scrollTo(0, 0);
  disposeReport = renderReport($('report'), match, {
    onBack: () => {
      if (disposeReport) disposeReport();
      disposeReport = null;
      $('report').hidden = true;
      $('arena').hidden = false;
    },
  });
}

function showLobby() {
  cancelRound();
  if (mode === 'online') {
    send({ type: 'leave' });
    teardownPeer();
  }
  mode = null;
  match = null;
  $('arena').hidden = true;
  $('report').hidden = true;
  $('lobby').hidden = false;
  document.body.classList.add('home');
}

async function withMedia(fn) {
  $('lobbyError').textContent = '';
  try {
    await ensureMedia();
    await audioCtx.resume();
  } catch (err) {
    console.error(err);
    $('lobbyError').textContent = 'Barkoff needs your microphone. Allow access and try again.';
    return;
  }
  try {
    localStorage.setItem('barkoff-name', $('name').value);
  } catch {}
  fn();
}

try {
  $('name').value = localStorage.getItem('barkoff-name') || '';
} catch {}

// Home-screen lineup: one tile per animal the judge knows; tapping shows its call.
for (const id of ANIMAL_IDS) {
  const a = ANIMALS[id];
  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.type = 'button';
  tile.setAttribute('aria-label', `${a.name}: ${a.sound}`);
  const emoji = document.createElement('span');
  emoji.className = 'tile-emoji';
  emoji.textContent = a.emoji;
  tile.append(emoji, a.name);
  tile.onclick = () => {
    tile.querySelector('.bubble')?.remove();
    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    bubble.textContent = a.sound;
    tile.append(bubble);
    tile.classList.remove('speaking');
    void tile.offsetWidth; // restart the hop animation
    tile.classList.add('speaking');
    bubble.addEventListener('animationend', () => bubble.remove());
  };
  $('lineup').append(tile);
}

$('findBtn').onclick = () => withMedia(findMatch);
$('practiceBtn').onclick = () => withMedia(() => {
  match = null;
  mode = null;
  startPractice();
});
$('leaveBtn').onclick = showLobby;
$('reportBtn').onclick = showReport;
$('nextBtn').onclick = () => {
  if (mode === 'practice') {
    startPractice();
  } else if (ws) {
    cancelRound();
    teardownPeer();
    send({ type: 'next' });
  } else {
    findMatch();
  }
};
