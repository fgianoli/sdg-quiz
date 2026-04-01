const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Load questions
let allQuestions;
try {
  allQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'quiz_questions.json'), 'utf8')).questions;
} catch(e) {
  console.log('quiz_questions.json not found next to quiz-server/, using embedded fallback');
  allQuestions = [];
}

// Shuffle + pick N
function shufflePick(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

// ===== GAME STATE =====
const QUESTIONS_PER_GAME = parseInt(process.env.QUESTIONS_PER_GAME) || 15;
let teams = {};          // { id: { name, score, ws, buzzTime } }
let questions = [];
let currentQ = -1;       // -1 = lobby
let phase = 'lobby';     // lobby | countdown | buzzing | answering | reveal | finished
let buzzOrder = [];       // [{ teamId, time }] ordered by buzz time
let buzzStart = 0;        // timestamp when buzzing opened
let secondLang = 'ru';
let idCounter = 0;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Admin page
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// Player page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

// ===== WEBSOCKET =====
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;
  ws.teamId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    switch(msg.type) {

      // --- ADMIN ---
      case 'admin-join':
        ws.role = 'admin';
        ws.send(JSON.stringify({
          type: 'admin-state',
          teams: getTeamsPublic(),
          phase,
          currentQ,
          questions: questions.map(q => stripAnswer(q)),
          buzzOrder: buzzOrder.map(b => ({ name: teams[b.teamId]?.name, ms: b.ms, color: getTeamColor(b.teamId) })),
          secondLang,
          totalQuestions: questions.length
        }));
        break;

      case 'set-lang':
        secondLang = msg.lang;
        broadcast({ type: 'lang-changed', lang: secondLang });
        break;

      case 'start-game':
        questions = shufflePick(allQuestions, QUESTIONS_PER_GAME);
        currentQ = -1;
        Object.values(teams).forEach(t => t.score = 0);
        phase = 'countdown';
        broadcast({ type: 'game-started', totalQuestions: questions.length });
        setTimeout(() => nextQuestion(), 500);
        break;

      case 'next-question':
        phase = 'countdown';
        broadcast({ type: 'countdown', seconds: 3 });
        setTimeout(() => nextQuestion(), 3000);
        break;

      case 'mark-correct':
        if (buzzOrder.length > 0 && phase === 'answering') {
          const winner = buzzOrder[0];
          if (teams[winner.teamId]) {
            teams[winner.teamId].score += questions[currentQ].points;
          }
          phase = 'reveal';
          const q = questions[currentQ];
          broadcast({
            type: 'reveal',
            correct: q.correct,
            explanation: q.explanation,
            winnerName: teams[winner.teamId]?.name,
            winnerColor: getTeamColor(winner.teamId),
            teams: getTeamsPublic(),
            isCorrect: true,
            points: q.points
          });
        }
        break;

      case 'mark-wrong':
        if (phase === 'answering') {
          buzzOrder.shift();
          if (buzzOrder.length > 0) {
            phase = 'answering';
            broadcast({
              type: 'wrong-pass',
              buzzOrder: buzzOrder.map(b => ({ name: teams[b.teamId]?.name, ms: b.ms, color: getTeamColor(b.teamId) })),
              nextTeam: teams[buzzOrder[0].teamId]?.name
            });
          } else {
            phase = 'reveal';
            const q = questions[currentQ];
            broadcast({
              type: 'reveal',
              correct: q.correct,
              explanation: q.explanation,
              winnerName: null,
              teams: getTeamsPublic(),
              isCorrect: false,
              points: q.points
            });
          }
        }
        break;

      case 'skip':
        phase = 'reveal';
        const sq = questions[currentQ];
        broadcast({
          type: 'reveal',
          correct: sq.correct,
          explanation: sq.explanation,
          winnerName: null,
          teams: getTeamsPublic(),
          isCorrect: false,
          points: sq.points
        });
        break;

      case 'reset':
        phase = 'lobby';
        currentQ = -1;
        buzzOrder = [];
        Object.values(teams).forEach(t => t.score = 0);
        broadcast({ type: 'reset' });
        break;

      // --- PLAYER ---
      case 'join-team':
        const id = 'team_' + (++idCounter);
        ws.role = 'player';
        ws.teamId = id;
        teams[id] = { name: msg.name.trim().substring(0, 30) || ('Team ' + idCounter), score: 0, ws, buzzTime: null };
        ws.send(JSON.stringify({ type: 'joined', teamId: id, name: teams[id].name }));
        broadcastAdmin({ type: 'teams-updated', teams: getTeamsPublic() });
        broadcastPlayers({ type: 'teams-updated', teams: getTeamsPublic() });
        break;

      case 'buzz':
        if (phase !== 'buzzing' || !ws.teamId || !teams[ws.teamId]) break;
        if (buzzOrder.find(b => b.teamId === ws.teamId)) break;
        const ms = Date.now() - buzzStart;
        buzzOrder.push({ teamId: ws.teamId, ms });
        teams[ws.teamId].buzzTime = ms;
        broadcast({
          type: 'buzz-update',
          buzzOrder: buzzOrder.map(b => ({ name: teams[b.teamId]?.name, ms: b.ms, color: getTeamColor(b.teamId) }))
        });
        if (buzzOrder.length === 1) {
          phase = 'answering';
          broadcast({ type: 'first-buzz', teamName: teams[ws.teamId].name, teamColor: getTeamColor(ws.teamId) });
        }
        break;
    }
  });

  ws.on('close', () => {
    if (ws.teamId && teams[ws.teamId]) {
      teams[ws.teamId].ws = null;
    }
  });
});

function nextQuestion() {
  currentQ++;
  if (currentQ >= questions.length) {
    phase = 'finished';
    broadcast({ type: 'finished', teams: getTeamsPublic() });
    return;
  }
  buzzOrder = [];
  buzzStart = Date.now();
  phase = 'buzzing';
  const q = questions[currentQ];
  broadcast({
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
}

// ===== HELPERS =====
const COLORS = ['#E74C3C','#3498DB','#27AE60','#9B59B6','#F39C12','#1ABC9C','#E67E22','#2C3E50','#E91E63','#00BCD4','#8BC34A','#FF5722','#607D8B','#795548','#CDDC39'];

function getTeamColor(teamId) {
  const ids = Object.keys(teams);
  const idx = ids.indexOf(teamId);
  return COLORS[idx % COLORS.length];
}

function getTeamsPublic() {
  return Object.entries(teams).map(([id, t], i) => ({
    id, name: t.name, score: t.score, color: COLORS[i % COLORS.length], connected: !!t.ws
  })).sort((a, b) => b.score - a.score);
}

function stripAnswer(q) {
  return { question: q.question, options: q.options, category: q.category, points: q.points, explanation: q.explanation };
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

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('===========================================');
  console.log('  SDG 15.3.1 QUIZ SERVER');
  console.log('===========================================');
  console.log('');
  console.log(`  Questions pool: ${allQuestions.length} (${QUESTIONS_PER_GAME} per game)`);
  console.log(`  Admin panel:  http://localhost:${PORT}/admin`);
  console.log(`  Player join:  http://localhost:${PORT}/`);
  console.log('');
  console.log('  On the same WiFi network, players use:');
  console.log(`  http://<YOUR-IP>:${PORT}/`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('===========================================');
});
