const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Load questions — try same dir, then parent dir
let allQuestions = [];
for (const p of [
  path.join(__dirname, 'quiz_questions.json'),
  path.join(__dirname, '..', 'quiz_questions.json')
]) {
  try {
    allQuestions = JSON.parse(fs.readFileSync(p, 'utf8')).questions;
    console.log(`Loaded questions from: ${p}`);
    break;
  } catch(e) { /* try next */ }
}
if (!allQuestions.length) console.warn('WARNING: No questions loaded!');

// Fisher-Yates shuffle + pick N
function shufflePick(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ===== CONFIG =====
const QUESTIONS_PER_GAME = parseInt(process.env.QUESTIONS_PER_GAME) || 15;
const BUZZ_TIMEOUT_SEC = parseInt(process.env.BUZZ_TIMEOUT) || 0; // 0 = no timeout

// ===== GAME STATE =====
let teams = {};         // { id: { name, score, ws, color } }
let questions = [];
let currentQ = -1;
let phase = 'lobby';    // lobby | countdown | buzzing | answering | all-wrong | reveal | finished
let buzzOrder = [];      // [{ teamId, ms }]
let buzzStart = 0;
let buzzTimer = null;
let secondLang = 'ru';
let idCounter = 0;
let usedAnswers = [];  // indices of wrong answers already given

// 15 distinct team colors
const COLORS = [
  '#E74C3C','#3498DB','#27AE60','#9B59B6','#F39C12',
  '#1ABC9C','#E67E22','#E91E63','#00BCD4','#8BC34A',
  '#FF5722','#607D8B','#795548','#CDDC39','#FF9800'
];
let colorIndex = 0;

// ===== SERVE STATIC =====
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

// ===== HEARTBEAT =====
const PING_INTERVAL = 25000;
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

// ===== WEBSOCKET =====
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;
  ws.teamId = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    switch(msg.type) {

      // ─── ADMIN ───
      case 'admin-join':
        ws.role = 'admin';
        sendState(ws);
        break;

      case 'set-lang':
        if (['ru','tr'].includes(msg.lang)) {
          secondLang = msg.lang;
          broadcast({ type: 'lang-changed', lang: secondLang });
        }
        break;

      case 'start-game':
        if (Object.keys(teams).length < 1) break;
        questions = shufflePick(allQuestions, QUESTIONS_PER_GAME);
        currentQ = -1;
        Object.values(teams).forEach(t => t.score = 0);
        phase = 'countdown';
        broadcast({ type: 'game-started', totalQuestions: questions.length });
        setTimeout(() => advanceQuestion(), 500);
        break;

      case 'next-question':
        if (phase !== 'reveal') break;
        phase = 'countdown';
        broadcast({ type: 'countdown', seconds: 3 });
        setTimeout(() => advanceQuestion(), 3000);
        break;

      case 'select-answer':
        if (phase !== 'answering' || buzzOrder.length === 0) break;
        const selectedIdx = parseInt(msg.index);
        if (isNaN(selectedIdx) || selectedIdx < 0) break;
        if (usedAnswers.includes(selectedIdx)) break; // already tried this answer
        const correctIdx = questions[currentQ].correct;
        const answerer = buzzOrder[0];

        if (selectedIdx === correctIdx) {
          // Correct answer!
          if (teams[answerer.teamId]) {
            teams[answerer.teamId].score += questions[currentQ].points;
          }
          phase = 'reveal';
          clearBuzzTimer();
          broadcast({
            type: 'answer-result',
            selectedIndex: selectedIdx,
            isCorrect: true,
            teamName: teams[answerer.teamId]?.name,
            teamColor: teams[answerer.teamId]?.color
          });
          setTimeout(() => broadcastReveal(teams[answerer.teamId]?.name, true), 1500);
        } else {
          // Wrong answer — track it, show which was selected, then pass to next
          usedAnswers.push(selectedIdx);
          broadcast({
            type: 'answer-result',
            selectedIndex: selectedIdx,
            isCorrect: false,
            teamName: teams[answerer.teamId]?.name,
            teamColor: teams[answerer.teamId]?.color,
            usedAnswers: [...usedAnswers]
          });
          buzzOrder.shift();
          if (buzzOrder.length > 0) {
            // Pass to next team in queue after a brief delay
            setTimeout(() => {
              phase = 'answering';
              broadcast({
                type: 'wrong-pass',
                buzzOrder: buzzOrderPublic(),
                nextTeam: teams[buzzOrder[0].teamId]?.name,
                nextColor: teams[buzzOrder[0].teamId]?.color,
                usedAnswers: [...usedAnswers]
              });
            }, 1500);
          } else {
            // Everyone who buzzed got it wrong
            setTimeout(() => {
              phase = 'all-wrong';
              broadcast({ type: 'all-wrong' });
            }, 1500);
          }
        }
        break;

      case 'skip':
        if (!['buzzing','answering','all-wrong'].includes(phase)) break;
        phase = 'reveal';
        clearBuzzTimer();
        broadcastReveal(null, false);
        break;

      case 'kick-team': {
        const kickId = msg.teamId;
        if (kickId && teams[kickId]) {
          if (teams[kickId].ws) {
            teams[kickId].ws.send(JSON.stringify({ type: 'kicked' }));
            teams[kickId].ws.close();
          }
          delete teams[kickId];
          // Remove from buzz order if present
          buzzOrder = buzzOrder.filter(b => b.teamId !== kickId);
          broadcast({ type: 'teams-updated', teams: getTeamsPublic() });
        }
        break;
      }

      case 'reset':
        phase = 'lobby';
        currentQ = -1;
        buzzOrder = [];
        clearBuzzTimer();
        Object.values(teams).forEach(t => t.score = 0);
        broadcast({ type: 'reset' });
        break;

      // ─── PLAYER ───
      case 'join-team': {
        const name = (msg.name || '').trim().substring(0, 30) || ('Team ' + (idCounter + 1));

        // Check for reconnection (same name, disconnected)
        const existing = Object.entries(teams).find(([id, t]) => t.name === name && !t.ws);
        if (existing) {
          const [existingId, existingTeam] = existing;
          ws.role = 'player';
          ws.teamId = existingId;
          existingTeam.ws = ws;
          ws.send(JSON.stringify({
            type: 'joined',
            teamId: existingId,
            name: existingTeam.name,
            color: existingTeam.color,
            reconnected: true,
            score: existingTeam.score
          }));
          // If game is in progress, tell them
          if (phase !== 'lobby') {
            ws.send(JSON.stringify({ type: 'game-started', totalQuestions: questions.length }));
            if (currentQ >= 0 && currentQ < questions.length) {
              const q = questions[currentQ];
              ws.send(JSON.stringify({
                type: 'question', num: currentQ + 1, total: questions.length,
                question: q.question, options: q.options, category: q.category,
                points: q.points, secondLang, teams: getTeamsPublic()
              }));
            }
          }
          broadcastAdmin({ type: 'teams-updated', teams: getTeamsPublic() });
          break;
        }

        // Prevent duplicate names (if connected team with same name exists)
        let finalName = name;
        const connectedDupe = Object.values(teams).find(t => t.name === name && t.ws);
        if (connectedDupe) {
          let suffix = 2;
          while (Object.values(teams).some(t => t.name === name + ' ' + suffix)) suffix++;
          finalName = name + ' ' + suffix;
        }

        // New team
        const id = 'team_' + (++idCounter);
        const color = COLORS[colorIndex % COLORS.length];
        colorIndex++;
        ws.role = 'player';
        ws.teamId = id;
        teams[id] = { name: finalName, score: 0, ws, color };
        ws.send(JSON.stringify({ type: 'joined', teamId: id, name: finalName, color }));
        broadcastAdmin({ type: 'teams-updated', teams: getTeamsPublic() });
        broadcastPlayers({ type: 'teams-updated', teams: getTeamsPublic() });
        break;
      }

      case 'buzz': {
        if (!['buzzing','answering'].includes(phase) || !ws.teamId || !teams[ws.teamId]) break;
        if (buzzOrder.find(b => b.teamId === ws.teamId)) break; // already buzzed
        // Cap buzz queue at number of options (max 4 chances)
        const maxBuzzers = questions[currentQ]?.options?.en?.length || 4;
        if (buzzOrder.length >= maxBuzzers) break;
        const ms = Date.now() - buzzStart;
        buzzOrder.push({ teamId: ws.teamId, ms });

        // Broadcast updated buzz order to everyone
        broadcast({
          type: 'buzz-update',
          buzzOrder: buzzOrderPublic(),
          totalTeams: Object.keys(teams).length,
          buzzedCount: buzzOrder.length,
          maxBuzzers
        });

        // First buzz → start answering phase
        if (buzzOrder.length === 1) {
          phase = 'answering';
          broadcast({
            type: 'first-buzz',
            teamName: teams[ws.teamId].name,
            teamColor: teams[ws.teamId].color
          });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.teamId && teams[ws.teamId]) {
      teams[ws.teamId].ws = null;
      broadcastAdmin({ type: 'teams-updated', teams: getTeamsPublic() });
    }
  });
});

// ===== GAME LOGIC =====
function advanceQuestion() {
  currentQ++;
  if (currentQ >= questions.length) {
    phase = 'finished';
    broadcast({ type: 'finished', teams: getTeamsPublic() });
    return;
  }
  buzzOrder = [];
  usedAnswers = [];
  buzzStart = Date.now();
  phase = 'buzzing';
  const q = questions[currentQ];
  // Send question to players (without correct answer)
  broadcastPlayers({
    type: 'question',
    num: currentQ + 1,
    total: questions.length,
    question: q.question,
    options: q.options,
    category: q.category,
    points: q.points,
    secondLang,
    teams: getTeamsPublic()
  });
  // Send question to admin (with correct index for click-to-verify)
  broadcastAdmin({
    type: 'question',
    num: currentQ + 1,
    total: questions.length,
    question: q.question,
    options: q.options,
    category: q.category,
    points: q.points,
    correct: q.correct,
    secondLang,
    teams: getTeamsPublic()
  });

  // Optional buzz timeout
  if (BUZZ_TIMEOUT_SEC > 0) {
    clearBuzzTimer();
    buzzTimer = setTimeout(() => {
      if (phase === 'buzzing' && buzzOrder.length === 0) {
        phase = 'all-wrong';
        broadcast({ type: 'all-wrong' });
      }
    }, BUZZ_TIMEOUT_SEC * 1000);
  }
}

function broadcastReveal(winnerName, isCorrect) {
  const q = questions[currentQ];
  broadcast({
    type: 'reveal',
    correct: q.correct,
    explanation: q.explanation,
    winnerName,
    teams: getTeamsPublic(),
    isCorrect,
    points: q.points
  });
}

function clearBuzzTimer() {
  if (buzzTimer) { clearTimeout(buzzTimer); buzzTimer = null; }
}

// ===== HELPERS =====
function getTeamsPublic() {
  return Object.entries(teams).map(([id, t]) => ({
    id, name: t.name, score: t.score, color: t.color, connected: !!t.ws
  })).sort((a, b) => b.score - a.score);
}

function buzzOrderPublic() {
  return buzzOrder.map(b => ({
    name: teams[b.teamId]?.name,
    ms: b.ms,
    color: teams[b.teamId]?.color
  }));
}

function sendState(ws) {
  ws.send(JSON.stringify({
    type: 'admin-state',
    teams: getTeamsPublic(),
    phase,
    currentQ,
    questions: questions.map(q => ({
      question: q.question, options: q.options, category: q.category,
      points: q.points, explanation: q.explanation, correct: q.correct
    })),
    buzzOrder: buzzOrderPublic(),
    secondLang,
    totalQuestions: questions.length
  }));
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(s); });
}
function broadcastAdmin(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1 && c.role === 'admin') c.send(s); });
}
function broadcastPlayers(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1 && c.role === 'player') c.send(s); });
}

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║         SDG 15.3.1 QUIZ SERVER            ║');
  console.log('╠═══════════════════════════════════════════╣');
  console.log(`║  Questions pool: ${String(allQuestions.length).padEnd(3)} (${QUESTIONS_PER_GAME} per game)       ║`);
  console.log(`║  Admin panel:  http://localhost:${PORT}/admin  ║`);
  console.log(`║  Player join:  http://localhost:${PORT}/        ║`);
  console.log('╠═══════════════════════════════════════════╣');
  console.log('║  Players on same network use:             ║');
  console.log(`║  http://<YOUR-IP>:${PORT}/                     ║`);
  console.log('╚═══════════════════════════════════════════╝');
});
