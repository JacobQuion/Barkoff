// Barkoff server: serves the static client, pairs strangers, relays WebRTC
// signaling, and referees best-of-N barking matches.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const ANIMALS = ['dog', 'wolf', 'cat', 'cow', 'lion', 'rooster', 'duck'];
const ROUNDS = 3;            // best of 3...
const MAX_ROUNDS = 5;        // ...with sudden death on ties, up to 5
const MATCH_START_MS = 4000; // time for the video call to connect
const COUNTDOWN_MS = 3000;
const RECORD_MS = 4000;
const SCORE_GRACE_MS = 4000; // how long to wait for late scores
const BETWEEN_ROUNDS_MS = 5000;

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

const wss = new WebSocketServer({ server });

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
  const room = { players: [a, b], round: 0, wins: [0, 0], scores: [null, null], animal: null, timer: null };
  a.room = room;
  b.room = room;
  // The player who waited longer makes the WebRTC offer.
  send(a, { type: 'matched', opponent: b.name, initiator: true });
  send(b, { type: 'matched', opponent: a.name, initiator: false });
  room.timer = setTimeout(() => startRound(room), MATCH_START_MS);
}

function startRound(room) {
  room.round++;
  const choices = ANIMALS.filter((a) => a !== room.animal);
  room.animal = choices[Math.floor(Math.random() * choices.length)];
  room.scores = [null, null];
  for (const p of room.players) {
    send(p, {
      type: 'round',
      round: room.round,
      total: ROUNDS,
      animal: room.animal,
      countdownMs: COUNTDOWN_MS,
      recordMs: RECORD_MS,
    });
  }
  room.timer = setTimeout(() => finishRound(room), COUNTDOWN_MS + RECORD_MS + SCORE_GRACE_MS);
}

function finishRound(room) {
  clearTimeout(room.timer);
  const empty = { score: 0, breakdown: { volume: 0, accuracy: 0, gusto: 0 } };
  const [s0, s1] = room.scores.map((s) => s || empty);
  const winner = s0.score === s1.score ? -1 : s0.score > s1.score ? 0 : 1;
  if (winner >= 0) room.wins[winner]++;

  room.players.forEach((p, i) => {
    send(p, {
      type: 'roundResult',
      round: room.round,
      animal: room.animal,
      you: i === 0 ? s0 : s1,
      them: i === 0 ? s1 : s0,
      outcome: winner === -1 ? 'tie' : winner === i ? 'win' : 'lose',
      wins: { you: room.wins[i], them: room.wins[1 - i] },
    });
  });

  const [w0, w1] = room.wins;
  const needed = Math.ceil(ROUNDS / 2);
  const decided = w0 >= needed || w1 >= needed || (room.round >= ROUNDS && w0 !== w1);
  if (decided || room.round >= MAX_ROUNDS) {
    room.players.forEach((p, i) => {
      const mine = room.wins[i];
      const theirs = room.wins[1 - i];
      send(p, {
        type: 'gameOver',
        outcome: mine === theirs ? 'tie' : mine > theirs ? 'win' : 'lose',
        wins: { you: mine, them: theirs },
      });
    });
    room.timer = null;
  } else {
    room.timer = setTimeout(() => startRound(room), BETWEEN_ROUNDS_MS);
  }
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

function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function onScore(player, msg) {
  const room = player.room;
  if (!room || msg.round !== room.round) return;
  const i = room.players.indexOf(player);
  if (room.scores[i]) return;
  const b = msg.breakdown || {};
  room.scores[i] = {
    score: Math.round(clamp01(msg.score / 100) * 100),
    breakdown: { volume: clamp01(b.volume), accuracy: clamp01(b.accuracy), gusto: clamp01(b.gusto) },
  };
  if (room.scores[0] && room.scores[1]) finishRound(room);
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
      case 'score':
        onScore(player, msg);
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
