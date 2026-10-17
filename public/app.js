import { ANIMALS, BarkRecorder, scoreBark, labelFor } from './scoring.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRACTICE_COUNTDOWN_MS = 3000;
const PRACTICE_RECORD_MS = 4000;

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
let frameMs = 21;
const tickListeners = new Set();

let recorder = null;
let roundToken = 0;
let myLastResult = null;

// ---------- media & audio ----------

async function ensureMedia() {
  if (localStream) return;
  const audio = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio, video: $('cam').checked });
  } catch (err) {
    if (!$('cam').checked) throw err;
    localStream = await navigator.mediaDevices.getUserMedia({ audio });
  }
  $('localVideo').srcObject = localStream;

  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('tick-worklet.js');
  const source = audioCtx.createMediaStreamSource(localStream);
  localAnalyser = makeAnalyser();
  source.connect(localAnalyser);

  // The tick node only needs to be pulled by the graph; its output is silent.
  const tick = new AudioWorkletNode(audioCtx, 'tick');
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  source.connect(tick).connect(mute).connect(audioCtx.destination);
  tick.port.onmessage = () => tickListeners.forEach((fn) => fn());
  frameMs = (8 * 128 * 1000) / audioCtx.sampleRate;

  startSpectrogram($('localSpec'), () => localAnalyser);
  startSpectrogram($('remoteSpec'), () => remoteAnalyser);
}

function makeAnalyser() {
  const a = audioCtx.createAnalyser();
  a.fftSize = 2048;
  a.smoothingTimeConstant = 0;
  return a;
}

function subscribeTick(fn) {
  tickListeners.add(fn);
  return () => tickListeners.delete(fn);
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
      ctx.fillStyle = `hsl(${280 - v * 0.9}, 100%, ${(v / 255) * 60}%)`;
      ctx.fillRect(w - 2, y, 2, 1);
    }
  })();
}

// ---------- rounds ----------

function cancelRound() {
  roundToken++;
  if (recorder) recorder.cancel();
  recorder = null;
  $('banner').classList.remove('go');
  $('youCard').classList.remove('recording');
}

async function runRound({ roundLabel, animal, countdownMs, recordMs }) {
  cancelRound();
  const token = roundToken;
  const a = ANIMALS[animal];
  clearResults();
  setBanner({ round: roundLabel, emoji: a.emoji, sound: a.sound, tip: `${a.name} · ${a.tip}`, countdown: '' });

  const steps = Math.max(1, Math.round(countdownMs / 1000));
  for (let i = steps; i > 0; i--) {
    $('countdown').textContent = i;
    await sleep(countdownMs / steps);
    if (token !== roundToken) return null;
  }

  $('countdown').textContent = 'GO!';
  $('banner').classList.add('go');
  $('youCard').classList.add('recording');
  recorder = new BarkRecorder(localAnalyser, audioCtx.sampleRate, subscribeTick, frameMs);
  const features = await recorder.record(recordMs);
  if (token !== roundToken) return null;

  recorder = null;
  $('banner').classList.remove('go');
  $('youCard').classList.remove('recording');
  $('countdown').textContent = 'Judging…';
  const result = scoreBark(animal, features);
  console.debug('bark features', animal, features, result);
  return result;
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

function renderResult(el, r, outcome) {
  const pct = (x) => Math.round(x * 100);
  const bar = (name, x) =>
    `<div class="bar"><span>${name}</span><div class="track"><div class="fill" style="width:${pct(x)}%"></div></div></div>`;
  const outcomeText = { win: 'WINS', lose: '', tie: 'TIE' }[outcome] || '';
  el.innerHTML =
    `<div><span class="big">${r.score}</span><span class="label">${labelFor(r.score)}</span>` +
    (outcomeText ? `<span class="outcome ${outcome}">${outcomeText}</span>` : '') +
    `</div>` +
    bar('Volume', r.breakdown.volume) +
    bar('Accuracy', r.breakdown.accuracy) +
    bar('Gusto', r.breakdown.gusto) +
    (r.hint ? `<div class="hint-line"></div>` : '');
  if (r.hint) el.querySelector('.hint-line').textContent = `Tip: ${r.hint}`;
}

function setWins(you, them) {
  $('youWins').textContent = '🦴'.repeat(you);
  $('themWins').textContent = '🦴'.repeat(them);
}

function setStatus(text) {
  $('status').textContent = text;
}

// ---------- practice ----------

async function startPractice() {
  mode = 'practice';
  showArena(true);
  setStatus('Practice mode. Nobody can hear you. Probably.');
  const ids = Object.keys(ANIMALS);
  const animal = ids[Math.floor(Math.random() * ids.length)];
  $('nextBtn').disabled = true;
  const result = await runRound({
    roundLabel: 'Practice',
    animal,
    countdownMs: PRACTICE_COUNTDOWN_MS,
    recordMs: PRACTICE_RECORD_MS,
  });
  $('nextBtn').disabled = false;
  if (!result || mode !== 'practice') return;
  $('countdown').textContent = '';
  renderResult($('youResult'), result);
}

// ---------- online ----------

function connect() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    sock.onopen = () => {
      ws = sock;
      resolve();
    };
    sock.onerror = () => reject(new Error('Could not reach the Barkoff server.'));
    sock.onmessage = (e) => onMessage(JSON.parse(e.data));
    sock.onclose = () => {
      ws = null;
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
  if (mode !== 'online') return;
  switch (msg.type) {
    case 'waiting':
      cancelRound();
      teardownPeer();
      clearResults();
      setWins(0, 0);
      $('themName').textContent = '…';
      setBanner({ emoji: '🐾', sound: 'Sniffing around…', tip: 'Waiting for another barker to show up.' });
      setStatus('Looking for someone to bark at…');
      break;
    case 'matched':
      clearResults();
      setWins(0, 0);
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
      break;
  }
}

async function onRound(msg) {
  myLastResult = null;
  setStatus(`Round ${msg.round}`);
  const result = await runRound({
    roundLabel: msg.round > msg.total ? `Sudden death · Round ${msg.round}` : `Round ${msg.round} of ${msg.total}`,
    animal: msg.animal,
    countdownMs: msg.countdownMs,
    recordMs: msg.recordMs,
  });
  if (!result) return;
  myLastResult = { round: msg.round, ...result };
  $('youResult').textContent = 'Judging…';
  $('themResult').textContent = 'Judging…';
  send({ type: 'score', round: msg.round, score: result.score, breakdown: result.breakdown });
}

function onRoundResult(msg) {
  cancelRound();
  $('countdown').textContent = '';
  const you = { ...msg.you, hint: myLastResult && myLastResult.round === msg.round ? myLastResult.hint : null };
  renderResult($('youResult'), you, msg.outcome);
  renderResult($('themResult'), msg.them, msg.outcome === 'win' ? 'lose' : msg.outcome === 'lose' ? 'win' : 'tie');
  if (msg.outcome === 'win') $('youCard').classList.add('won');
  if (msg.outcome === 'lose') $('themCard').classList.add('won');
  setWins(msg.wins.you, msg.wins.them);
  setStatus({ win: 'You won the round!', lose: 'They won the round.', tie: 'Tie round!' }[msg.outcome]);
}

function onGameOver(msg) {
  const banners = {
    win: { emoji: '🏆', sound: "You're the Top Dog!" },
    lose: { emoji: '🐕‍🦺', sound: 'Out-barked.' },
    tie: { emoji: '🤝', sound: 'Dead heat.' },
  };
  setBanner({
    round: `Final ${msg.wins.you}–${msg.wins.them}`,
    ...banners[msg.outcome],
    tip: 'Hit Next for a new opponent.',
  });
}

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

function teardownPeer() {
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
  $('lobby').classList.add('hidden');
  $('arena').classList.remove('hidden');
  $('themCard').classList.toggle('hidden', solo);
  document.querySelector('.players').classList.toggle('solo', solo);
  $('nextBtn').textContent = solo ? 'Another animal' : 'Next opponent';
  $('nextBtn').disabled = false;
  clearResults();
  setWins(0, 0);
  setBanner({});
}

function showLobby() {
  cancelRound();
  if (mode === 'online') {
    send({ type: 'leave' });
    teardownPeer();
  }
  mode = null;
  $('arena').classList.add('hidden');
  $('lobby').classList.remove('hidden');
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

$('findBtn').onclick = () => withMedia(findMatch);
$('practiceBtn').onclick = () => withMedia(startPractice);
$('leaveBtn').onclick = showLobby;
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
