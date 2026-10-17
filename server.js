// Barkoff server: serves the static client, pairs strangers, relays WebRTC
// signaling, keeps clients clock-synced, and referees matches. Scoring is
// authoritative: clients upload 16 kHz PCM and the server runs the DSP
// pipeline itself, so a modified client can't simply report a high score.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { analyze, serializeAnalysis, decodePcm16, SAMPLE_RATE } from './public/dsp/analyze.js';
import { fromInt16 } from './public/dsp/resample.js';
import { scoreBark, ANIMAL_IDS } from './public/dsp/score.js';
import { loadYamnet, classify, recognitionFor, yamnetStatus } from './ml/yamnet.js';
import { loadClap, clapScores, clapRecognition, clapStatus } from './ml/clap.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const ROUNDS = 3;            // all 3 rounds are played...
const MAX_ROUNDS = 5;        // ...with sudden death on ties, up to 5
const MATCH_START_MS = 4000; // time for the video call to connect
const COUNTDOWN_MS = 3000;
const RECORD_MS = 4000;
const UPLOAD_GRACE_MS = 8000;
const BETWEEN_ROUNDS_MS = 6000;
const HOP_SEC_DSP = 0.01; // analyze() frame hop
const MAX_SAMPLES = Math.ceil(SAMPLE_RATE * (RECORD_MS / 1000) * 1.05);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });

let waiting = null; // the one player currently in the queue
let nextId = 1;

function send(player, msg) {
  if (player && player.ws.readyState === player.ws.OPEN) player.ws.send(JSON.stringify(msg));
}

function opponentOf(player) {
  const room = player.room;
  if (!room) return null;
  return room.players[0] === player ? room.players[1] : room.players[0];
}

function enqueue(player) {
  if (waiting && waiting !== player && waiting.ws.readyState === waiting.ws.OPEN) {
    const other = waiting;
    waiting = null;
    startMatch(other, player);
  } else {
    waiting = player;
    send(player, { type: 'waiting' });
  }
}

function startMatch(a, b) {
  const room = { players: [a, b], round: 0, wins: [0, 0], reports: [null, null], animal: null, timer: null, recordStartAt: 0 };
  a.room = room;
  b.room = room;
  // The player who waited longer makes the WebRTC offer.
  send(a, { type: 'matched', opponent: b.name, initiator: true, rounds: ROUNDS });
  send(b, { type: 'matched', opponent: a.name, initiator: false, rounds: ROUNDS });
  room.timer = setTimeout(() => startRound(room), MATCH_START_MS);
}

function startRound(room) {
  room.round++;
  const choices = ANIMAL_IDS.filter((a) => a !== room.animal);
  room.animal = choices[Math.floor(Math.random() * choices.length)];
  room.reports = [null, null];
  // Both clients start recording at the same instant on the server's clock;
  // each converts it to local time using its NTP-style offset estimate.
  room.recordStartAt = Date.now() + COUNTDOWN_MS;
  for (const p of room.players) {
    send(p, {
      type: 'round',
      round: room.round,
      total: ROUNDS,
      animal: room.animal,
      recordStartAt: room.recordStartAt,
      recordMs: RECORD_MS,
      serverNow: Date.now(),
    });
  }
  room.timer = setTimeout(() => finishRound(room), COUNTDOWN_MS + RECORD_MS + UPLOAD_GRACE_MS);
}

function finishRound(room) {
  clearTimeout(room.timer);
  const empty = (animal) => ({ analysis: null, score: { ...scoreBark(animal, emptyAnalysis()), hint: 'No audio arrived from this player.' }, meta: null });
  const [r0, r1] = room.reports.map((r) => r || empty(room.animal));
  const s0 = r0.score.score;
  const s1 = r1.score.score;
  const winner = s0 === s1 ? -1 : s0 > s1 ? 0 : 1;
  if (winner >= 0) room.wins[winner]++;

  room.players.forEach((p, i) => {
    send(p, {
      type: 'roundResult',
      round: room.round,
      animal: room.animal,
      you: i === 0 ? r0 : r1,
      them: i === 0 ? r1 : r0,
      outcome: winner === -1 ? 'tie' : winner === i ? 'win' : 'lose',
      wins: { you: room.wins[i], them: room.wins[1 - i] },
    });
  });

  // Always play all ROUNDS; only a tie after that goes to sudden death.
  const [w0, w1] = room.wins;
  const decided = room.round >= ROUNDS && w0 !== w1;
  if (decided || room.round >= MAX_ROUNDS) {
    room.players.forEach((p, i) => {
      const mine = room.wins[i];
      const theirs = room.wins[1 - i];
      send(p, {
        type: 'gameOver',
        outcome: mine === theirs ? 'tie' : mine > theirs ? 'win' : 'lose',
        wins: { you: mine, them: theirs },
        rounds: room.round,
      });
    });
    room.timer = null;
  } else {
    room.timer = setTimeout(() => startRound(room), BETWEEN_ROUNDS_MS);
  }
}

function emptyAnalysis() {
  return { features: { activeFrames: 0 }, contour: { st: [] } };
}

function leaveRoom(player) {
  const room = player.room;
  if (!room) return;
  clearTimeout(room.timer);
  const other = opponentOf(player);
  player.room = null;
  if (other) {
    other.room = null;
    send(other, { type: 'opponentLeft', name: player.name });
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const META_FIELDS = ['inputRate', 'captureFrames', 'startErrorMs', 'scheduleLeadMs', 'syncOffsetMs', 'syncRttMs', 'baseLatencyMs', 'outputLatencyMs', 'rawPeakDbfs', 'rawClipRatio', 'resampleMs'];

function readUpload(msg) {
  let pcm = decodePcm16(msg.pcm);
  if (pcm.length > MAX_SAMPLES) pcm = pcm.subarray(0, MAX_SAMPLES);
  const meta = Object.fromEntries(META_FIELDS.map((k) => [k, num(msg.meta?.[k])]));
  meta.samples = pcm.length;
  meta.uploadBytes = msg.pcm.length;
  return { pcm: fromInt16(pcm), meta };
}

// DSP analysis + YAMNet recognition + judge. Returns a report ready to send.
async function judge(animal, pcm, meta) {
  const t0 = performance.now();
  const analysis = analyze(pcm, SAMPLE_RATE);
  const dspMs = performance.now() - t0;
  // Two classifiers feed one 30% recognition boost: YAMNet (AudioSet event
  // classes) and CLAP (zero-shot text prompts, incl. "a person imitating …").
  // The stronger of the two counts.
  let yamnet = null;
  let clap = null;
  try {
    yamnet = recognitionFor(await classify(pcm), analysis.tracks.active, animal, HOP_SEC_DSP);
  } catch (err) {
    console.error('yamnet failed', err);
  }
  try {
    clap = clapRecognition(await clapScores(pcm, analysis.tracks.active, HOP_SEC_DSP), animal);
  } catch (err) {
    console.error('clap failed', err);
  }
  const ml = yamnet || clap
    ? { ...(yamnet || {}), match: Math.max(yamnet?.match ?? 0, clap?.match ?? 0), yamnet, clap }
    : null;
  const score = scoreBark(animal, analysis, ml);
  meta.serverMs = Math.round(dspMs * 10) / 10;
  meta.mlMs = yamnet ? yamnet.ms : null;
  meta.clapMs = clap ? clap.ms : null;
  meta.mlStatus = `yamnet ${yamnetStatus()} · clap ${clapStatus()}`;
  meta.scoredBy = 'server';
  return { analysis: serializeAnalysis(analysis), score, meta };
}

async function onAudio(player, msg) {
  const room = player.room;
  if (!room || msg.round !== room.round || typeof msg.pcm !== 'string') return;
  const i = room.players.indexOf(player);
  if (room.reports[i] || room.pending?.[i]) return;
  (room.pending ||= [false, false])[i] = true;

  const receivedAt = Date.now();
  const { pcm, meta } = readUpload(msg);
  meta.uploadDelayMs = receivedAt - (room.recordStartAt + RECORD_MS);
  const round = room.round;
  const report = await judge(room.animal, pcm, meta);
  room.pending[i] = false;
  // The room may have moved on (timeout, opponent left) while we were scoring.
  if (player.room !== room || room.round !== round || room.reports[i]) return;

  room.reports[i] = report;
  const ml = report.score.ml;
  console.log(`[room] r${room.round} ${player.name}: ${report.score.score} (${room.animal}) dsp ${report.score.dspScore} ${meta.serverMs} ms · yamnet ${ml?.yamnet?.match ?? '-'} · clap p=${ml?.clap?.pTarget ?? '-'} match=${ml?.clap?.match ?? '-'} ${meta.clapMs ?? '-'} ms`);
  if (room.reports[0] && room.reports[1]) finishRound(room);
}

async function onPractice(player, msg) {
  if (player.practiceBusy || typeof msg.pcm !== 'string' || !ANIMAL_IDS.includes(msg.animal)) return;
  player.practiceBusy = true;
  try {
    const { pcm, meta } = readUpload(msg);
    const report = await judge(msg.animal, pcm, meta);
    send(player, { type: 'practiceResult', id: msg.id, report });
  } finally {
    player.practiceBusy = false;
  }
}

wss.on('connection', (ws) => {
  const player = { id: nextId++, ws, name: 'Stranger', room: null };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ping':
        // NTP-style: the client brackets this timestamp with its own send/receive times.
        send(player, { type: 'pong', id: msg.id, ts: Date.now() });
        break;
      case 'join':
        player.name = String(msg.name || '').trim().slice(0, 20) || 'Stranger';
        leaveRoom(player);
        enqueue(player);
        break;
      case 'next':
        leaveRoom(player);
        enqueue(player);
        break;
      case 'leave':
        leaveRoom(player);
        if (waiting === player) waiting = null;
        break;
      case 'signal':
        send(opponentOf(player), { type: 'signal', data: msg.data });
        break;
      case 'audio':
        onAudio(player, msg).catch((err) => console.error('audio analysis failed', err));
        break;
      case 'practice':
        onPractice(player, msg).catch((err) => console.error('practice analysis failed', err));
        break;
    }
  });

  ws.on('close', () => {
    leaveRoom(player);
    if (waiting === player) waiting = null;
  });
});

server.listen(PORT, () => {
  console.log(`Barkoff running at http://localhost:${PORT}`);
});

loadYamnet().then((ok) => console.log(`YAMNet ${ok ? 'loaded' : yamnetStatus()}`));
loadClap().then((ok) => console.log(`CLAP ${ok ? 'loaded' : clapStatus()}`));
