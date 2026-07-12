const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Game state ──────────────────────────────────────────
const state = {
  phase: 'lobby',      // lobby | question | reveal | leaderboard | done
  players: {},         // { id: { name, score, streak, answers: [], lastAnswer } }
  currentQ: 0,
  questionActive: false,
  answers: {},         // { playerId: { ans, timeMs, correct } }
  timerStart: null,
  timerDuration: 20000,
  timerInterval: null,
  hostWs: null,
};

// ── Questions ───────────────────────────────────────────
const QUESTIONS = [
  {
    text: "A podcast that teaches about faith, culture, and current events from a Christian perspective.",
    ans: "SUBSCRIBE",
    sc: "Romans 10:17 — \"Faith comes from hearing the Good News about Christ.\"",
    drop: "Anything that consistently brings the Word into your daily rhythm is worth your ears. It doesn't have to be a sermon — but it should be building you up.",
    hard: false
  },
  {
    text: "A group chat that started as a Bible study but is now mostly memes, drama, and gossip.",
    ans: "UNSUBSCRIBE",
    sc: "Ephesians 4:29 — \"Let everything you say be good and helpful.\"",
    drop: "The name on the group chat doesn't sanctify what's actually being said in it. If it consistently pulls you away from who God called you to be — leave the chat.",
    hard: false
  },
  {
    text: "An Instagram account that posts daily Bible verses but also promotes designer clothes and expensive trips as proof of God's blessing.",
    ans: "UNSUBSCRIBE",
    sc: "1 Timothy 6:6 — \"True godliness with contentment is itself great wealth.\"",
    drop: "A verse in the caption doesn't make the content godly. When scripture is used to justify a lifestyle God never endorsed — that's the algorithm using the Word against you.",
    hard: true
  },
  {
    text: "A mentor who challenges your thinking, calls out your blind spots, and sometimes says things that are hard to hear.",
    ans: "SUBSCRIBE",
    sc: "Proverbs 27:17 — \"As iron sharpens iron, so a friend sharpens a friend.\"",
    drop: "Don't unsubscribe from accountability. A mentor who tells you what you need to hear rather than what you want to hear is one of the rarest things you can have.",
    hard: false
  },
  {
    text: "A Christian influencer with millions of followers who talks constantly about your potential and blessing — but rarely mentions repentance, sin, or the cross.",
    ans: "UNSUBSCRIBE",
    sc: "2 Timothy 4:3 — \"They will look for teachers who will tell them whatever their itching ears want to hear.\"",
    drop: "A gospel that never calls you to repentance isn't good news. It's just good vibes. Encouragement without conviction isn't the full gospel.",
    hard: true
  },
  {
    text: "A group of friends who aren't Christians but have always been loyal, honest, and genuinely supportive — and have never led you into sin.",
    ans: "SUBSCRIBE",
    sc: "Proverbs 17:17 — \"A friend is always loyal.\"",
    drop: "The Bible never says only have Christian friends. It says be careful who influences your character. Loyal, honest, supportive people are a gift — even if they don't yet know Jesus.",
    hard: true
  },
  {
    text: "A news account you follow specifically because it keeps you outraged about what the other political side is doing.",
    ans: "UNSUBSCRIBE",
    sc: "Romans 12:18 — \"Do all that you can to live in peace with everyone.\"",
    drop: "There's a difference between staying informed and feeding your outrage. If the primary emotion it produces is contempt and anger — it's not informing you. It's weaponizing you.",
    hard: false
  },
  {
    text: "A YouTube channel that teaches financial literacy and investing — from a completely secular perspective.",
    ans: "SUBSCRIBE",
    sc: "Proverbs 21:5 — \"Good planning and hard work lead to prosperity.\"",
    drop: "God doesn't require every resource you use to be explicitly Christian. Wisdom is wisdom. Learn how money works so you can be a better steward of what God gives you.",
    hard: true
  },
  {
    text: "A church you've attended for two years where still no one knows your name, you have no real relationships, and you serve nowhere.",
    ans: "UNSUBSCRIBE",
    sc: "Hebrews 10:25 — \"Let us not neglect meeting together, but encourage one another.\"",
    drop: "A church that doesn't know you isn't your church — it's a show you attend. If after two years you're still an audience member and not a member of the body, something needs to change.",
    hard: true
  },
  {
    text: "Saying the same prayer every night — same words, same length, same order — mostly out of habit rather than actual conversation with God.",
    ans: "UNSUBSCRIBE",
    sc: "Matthew 6:7 — \"When you pray, don't babble on and on.\"",
    drop: "Routine can be a scaffold for discipline or a substitute for relationship — only you know which one yours has become. God doesn't want your script. He wants you.",
    hard: true
  },
  {
    text: "The carefully curated version of yourself online that gets more likes and attention than the real you ever has.",
    ans: "UNSUBSCRIBE",
    sc: "Galatians 1:10 — \"If pleasing people were my goal, I would not be Christ's servant.\"",
    drop: "This is the whole sermon in one question. If you've built a subscription people follow but God doesn't recognize — cancel it. The real you is who God called. Not the curated version.",
    hard: true
  },
];

// ── Utility ─────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getLeaderboard() {
  return Object.entries(state.players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score, streak: p.streak, answers: p.answers.length }))
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}

function startQuestionTimer() {
  state.timerStart = Date.now();
  state.timerInterval = setInterval(() => {
    const elapsed = Date.now() - state.timerStart;
    const remaining = Math.max(0, state.timerDuration - elapsed);
    broadcast({ type: 'timer', remaining, total: state.timerDuration });
    if (remaining === 0) { stopTimer(); doReveal(); }
  }, 200);
}

function doReveal() {
  stopTimer();
  state.phase = 'reveal';
  state.questionActive = false;

  const q = QUESTIONS[state.currentQ];
  const answers = state.answers;

  // Score players
  Object.entries(answers).forEach(([pid, a]) => {
    const p = state.players[pid];
    if (!p) return;
    a.correct = a.ans === q.ans;
    if (a.correct) {
      // Speed bonus: max 300 for instant, min 100 for slow
      const speedBonus = Math.round(Math.max(0, (state.timerDuration - a.timeMs) / state.timerDuration) * 200);
      const pts = 100 + speedBonus + (p.streak >= 2 ? 50 : 0);
      p.score += pts;
      p.streak++;
      a.pts = pts;
    } else {
      p.streak = 0;
      a.pts = 0;
    }
    p.answers.push({ q: state.currentQ, correct: a.correct, pts: a.pts || 0 });
  });

  // Notify each player their result
  Object.entries(state.players).forEach(([pid, p]) => {
    if (!p.ws) return;
    const a = answers[pid];
    sendTo(p.ws, {
      type: 'reveal',
      correct: a ? a.correct : false,
      answered: !!a,
      pts: a ? a.pts : 0,
      yourScore: p.score,
      streak: p.streak,
      rightAns: q.ans,
      scripture: q.sc,
      drop: q.drop,
      qIndex: state.currentQ,
      totalQ: QUESTIONS.length,
    });
  });

  // Tell host
  if (state.hostWs) {
    sendTo(state.hostWs, {
      type: 'reveal',
      answers,
      leaderboard: getLeaderboard(),
      question: q,
      qIndex: state.currentQ,
      totalQ: QUESTIONS.length,
    });
  }
}

// ── WebSocket handler ────────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // HOST join
    if (msg.type === 'host') {
      state.hostWs = ws;
      sendTo(ws, {
        type: 'hostState',
        phase: state.phase,
        players: getLeaderboard(),
        currentQ: state.currentQ,
        totalQ: QUESTIONS.length,
      });
      return;
    }

    // PLAYER join
    if (msg.type === 'join') {
      playerId = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
      const name = (msg.name || 'Player').slice(0, 16).trim() || 'Player';
      state.players[playerId] = { name, score: 0, streak: 0, answers: [], ws };
      sendTo(ws, { type: 'joined', id: playerId, name });

      // If game already in progress, catch them up
      if (state.phase === 'question' && state.questionActive) {
        const q = QUESTIONS[state.currentQ];
        const elapsed = Date.now() - state.timerStart;
        const remaining = Math.max(0, state.timerDuration - elapsed);
        sendTo(ws, {
          type: 'question',
          index: state.currentQ,
          total: QUESTIONS.length,
          text: q.text,
          hard: q.hard,
          remaining,
          total_duration: state.timerDuration,
        });
      }

      // Notify host
      if (state.hostWs) {
        sendTo(state.hostWs, { type: 'playerJoined', players: getLeaderboard() });
      }
      return;
    }

    // PLAYER answer
    if (msg.type === 'answer' && playerId) {
      if (!state.questionActive) return;
      if (state.answers[playerId]) return; // already answered
      const timeMs = Date.now() - state.timerStart;
      state.answers[playerId] = { ans: msg.ans, timeMs };
      sendTo(ws, { type: 'answerReceived', ans: msg.ans });

      // Let host know answer count
      if (state.hostWs) {
        sendTo(state.hostWs, {
          type: 'answerCount',
          answered: Object.keys(state.answers).length,
          total: Object.keys(state.players).length,
        });
      }

      // Auto-reveal if everyone answered
      const activePlayers = Object.keys(state.players).length;
      if (Object.keys(state.answers).length >= activePlayers && activePlayers > 0) {
        doReveal();
      }
      return;
    }

    // HOST controls (only host can send these)
    if (ws !== state.hostWs) return;

    if (msg.type === 'startGame') {
      state.phase = 'question';
      state.currentQ = 0;
      state.answers = {};
      state.questionActive = true;
      Object.values(state.players).forEach(p => { p.score = 0; p.streak = 0; p.answers = []; });

      const q = QUESTIONS[state.currentQ];
      broadcast({
        type: 'question',
        index: state.currentQ,
        total: QUESTIONS.length,
        text: q.text,
        hard: q.hard,
        total_duration: state.timerDuration,
        remaining: state.timerDuration,
      });
      startQuestionTimer();
      return;
    }

    if (msg.type === 'nextQuestion') {
      stopTimer();
      state.currentQ++;
      if (state.currentQ >= QUESTIONS.length) {
        state.phase = 'done';
        const lb = getLeaderboard();
        broadcast({ type: 'gameOver', leaderboard: lb });
        return;
      }
      state.answers = {};
      state.questionActive = true;
      state.phase = 'question';

      const q = QUESTIONS[state.currentQ];
      broadcast({
        type: 'question',
        index: state.currentQ,
        total: QUESTIONS.length,
        text: q.text,
        hard: q.hard,
        total_duration: state.timerDuration,
        remaining: state.timerDuration,
      });
      startQuestionTimer();
      return;
    }

    if (msg.type === 'revealNow') {
      stopTimer();
      doReveal();
      return;
    }

    if (msg.type === 'showLeaderboard') {
      const lb = getLeaderboard();
      broadcast({ type: 'leaderboard', leaderboard: lb, qIndex: state.currentQ, totalQ: QUESTIONS.length });
      return;
    }

    if (msg.type === 'resetGame') {
      stopTimer();
      state.phase = 'lobby';
      state.currentQ = 0;
      state.answers = {};
      state.questionActive = false;
      Object.values(state.players).forEach(p => { p.score = 0; p.streak = 0; p.answers = []; });
      broadcast({ type: 'reset' });
      return;
    }
  });

  ws.on('close', () => {
    if (playerId && state.players[playerId]) {
      state.players[playerId].ws = null;
      if (state.hostWs) sendTo(state.hostWs, { type: 'playerLeft', players: getLeaderboard() });
    }
    if (ws === state.hostWs) state.hostWs = null;
  });
});

// ── Routes ───────────────────────────────────────────────

// Health check — keeps Render free tier awake
app.get('/health', (req, res) => res.json({ status: 'ok', players: Object.keys(state.players).length, phase: state.phase }));

// Self-ping every 10 minutes to prevent Render free tier sleep
if (process.env.RENDER_EXTERNAL_URL) {
  const pingUrl = process.env.RENDER_EXTERNAL_URL + '/health';
  setInterval(() => {
    const mod = pingUrl.startsWith('https') ? require('https') : require('http');
    mod.get(pingUrl, (r) => {
      console.log('[keep-alive] pinged — status ' + r.statusCode);
    }).on('error', (e) => console.log('[keep-alive] ping error:', e.message));
  }, 10 * 60 * 1000);
  console.log('[keep-alive] Self-ping enabled at ' + pingUrl);
}

app.get('/', (req, res) => res.redirect('/host'));

app.get('/host', (req, res) => {
  const ip = getLocalIP();
  const port = server.address()?.port || PORT;
  res.send(HOST_HTML.replace('{{PLAYER_URL}}', `http://${ip}:${port}/play`));
});

app.get('/play', (req, res) => {
  res.send(PLAYER_HTML);
});

app.get('/qr', async (req, res) => {
  const ip = getLocalIP();
  const port = server.address()?.port || PORT;
  const url = `http://${ip}:${port}/play`;
  const qr = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: '#000000', light: '#FFFFFF' } });
  res.json({ url, qr });
});

// ── HTML Pages ───────────────────────────────────────────

const HOST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SUBSCRIBE OR UNSUBSCRIBE? — Host Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,sans-serif;background:#08080f;color:#f8fafc;min-height:100vh;}
:root{--green:#22C55E;--red:#EF4444;--gold:#FBBF24;--accent:#8B5CF6;--muted:#64748B;--card:#111118;--border:#1f1f30;}

.header{background:var(--card);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
.logo{font-size:22px;font-weight:900;color:#fff;}
.logo span.s{color:var(--green);}
.logo span.u{color:var(--red);}
.series-tag{font-size:11px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;font-weight:600;}
.header-right{display:flex;align-items:center;gap:12px;}
.player-count{background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.3);border-radius:50px;padding:6px 16px;font-size:14px;font-weight:700;color:var(--accent);}

.main{display:grid;grid-template-columns:1fr 340px;gap:0;height:calc(100vh - 65px);}

/* LEFT PANEL */
.left{padding:24px;overflow-y:auto;display:flex;flex-direction:column;gap:20px;}

.phase-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;}
.phase-label{font-size:11px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;font-weight:600;margin-bottom:8px;}
.phase-title{font-size:28px;font-weight:800;color:#fff;margin-bottom:16px;}

/* QR section */
.qr-section{display:flex;gap:20px;align-items:flex-start;}
.qr-box{background:#fff;border-radius:12px;padding:10px;flex-shrink:0;}
.qr-box img{display:block;width:140px;height:140px;}
.qr-info h3{font-size:16px;font-weight:700;color:#fff;margin-bottom:6px;}
.qr-info p{font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:10px;}
.url-chip{background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;font-family:monospace;color:var(--gold);word-break:break-all;}

/* Question card */
.q-display{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;}
.q-meta{display:flex;gap:10px;align-items:center;margin-bottom:14px;}
.q-badge{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:4px 12px;border-radius:50px;}
.q-badge.round1{background:rgba(34,197,94,0.15);color:var(--green);}
.q-badge.round2{background:rgba(251,191,36,0.15);color:var(--gold);}
.q-badge.round3{background:rgba(239,68,68,0.15);color:var(--red);}
.hard-badge{background:rgba(139,92,246,0.15);color:var(--accent);font-size:11px;font-weight:700;padding:4px 10px;border-radius:50px;}
.q-text-big{font-size:20px;font-weight:700;color:#fff;line-height:1.5;}
.q-progress{margin-top:14px;}
.q-prog-bar{background:rgba(255,255,255,0.08);border-radius:50px;height:6px;overflow:hidden;margin-top:6px;}
.q-prog-fill{background:linear-gradient(90deg,var(--green),var(--accent));height:100%;border-radius:50px;transition:width 0.2s;}

/* Answer count */
.ans-count{display:flex;justify-content:space-between;align-items:center;margin-top:12px;}
.ans-count-num{font-size:28px;font-weight:900;color:var(--gold);}
.ans-count-label{font-size:12px;color:var(--muted);}
.ans-bar{background:rgba(255,255,255,0.06);border-radius:50px;height:8px;overflow:hidden;margin-top:8px;}
.ans-bar-fill{background:var(--gold);height:100%;border-radius:50px;transition:width 0.4s;}

/* Timer */
.timer-ring-wrap{display:flex;justify-content:center;margin:16px 0;}
.timer-svg{transform:rotate(-90deg);}
.timer-bg{fill:none;stroke:rgba(255,255,255,0.07);stroke-width:6;}
.timer-fg{fill:none;stroke-width:6;stroke-linecap:round;transition:stroke-dashoffset 0.2s,stroke 0.5s;}
.timer-text{font-size:26px;font-weight:900;fill:#fff;dominant-baseline:middle;text-anchor:middle;}

/* Controls */
.controls{display:flex;flex-direction:column;gap:10px;}
.btn{border:none;border-radius:12px;padding:14px 24px;font-size:16px;font-weight:800;cursor:pointer;font-family:inherit;letter-spacing:1px;text-transform:uppercase;-webkit-appearance:none;transition:opacity 0.2s;}
.btn:disabled{opacity:0.3;cursor:not-allowed;}
.btn-primary{background:linear-gradient(135deg,var(--accent),#7C3AED);color:#fff;box-shadow:0 4px 20px rgba(139,92,246,0.3);}
.btn-green{background:linear-gradient(135deg,var(--green),#16A34A);color:#fff;}
.btn-gold{background:linear-gradient(135deg,var(--gold),#D97706);color:#08080f;}
.btn-red{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:var(--red);}
.btn-row{display:flex;gap:10px;}
.btn-row .btn{flex:1;}

/* Reveal panel */
.reveal-panel{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;display:none;}
.reveal-ans{font-size:36px;font-weight:900;margin-bottom:8px;}
.reveal-ans.is-sub{color:var(--green);}
.reveal-ans.is-unsub{color:var(--red);}
.reveal-sc{font-size:13px;color:var(--gold);font-style:italic;margin-bottom:10px;}
.reveal-drop{font-size:14px;color:var(--muted);line-height:1.6;border-left:3px solid var(--accent);padding-left:12px;}

/* LOBBY */
.lobby-state{text-align:center;padding:20px;}
.lobby-state h2{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px;}
.lobby-state p{font-size:15px;color:var(--muted);line-height:1.6;}

/* RIGHT PANEL — Leaderboard */
.right{border-left:1px solid var(--border);background:rgba(0,0,0,0.3);display:flex;flex-direction:column;}
.lb-header{padding:16px 20px;border-bottom:1px solid var(--border);}
.lb-header h3{font-size:14px;font-weight:700;letter-spacing:2px;color:var(--muted);text-transform:uppercase;}
.lb-list{flex:1;overflow-y:auto;padding:12px;}
.lb-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;margin-bottom:6px;transition:background 0.2s;}
.lb-item:hover{background:rgba(255,255,255,0.04);}
.lb-item.rank1{background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.15);}
.lb-item.rank2{background:rgba(156,163,175,0.06);}
.lb-item.rank3{background:rgba(180,100,60,0.06);}
.lb-rank{font-size:18px;font-weight:900;width:28px;flex-shrink:0;color:var(--muted);text-align:center;}
.lb-item.rank1 .lb-rank{color:var(--gold);}
.lb-item.rank2 .lb-rank{color:#9CA3AF;}
.lb-item.rank3 .lb-rank{color:#B46432;}
.lb-name{flex:1;font-size:15px;font-weight:700;color:#fff;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.lb-score{font-size:18px;font-weight:900;color:var(--accent);}
.lb-streak{font-size:11px;color:var(--gold);margin-left:4px;}

/* DONE state */
.done-header{text-align:center;padding:20px 0 10px;}
.done-trophy{font-size:60px;margin-bottom:8px;animation:bob 1s ease infinite alternate;}
@keyframes bob{from{transform:translateY(0);}to{transform:translateY(-8px);}}
.done-title{font-size:22px;font-weight:900;color:#fff;}
.done-winner{font-size:30px;font-weight:900;color:var(--gold);margin-top:4px;}

/* Status dot */
.status-dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse2 2s ease infinite;}
@keyframes pulse2{0%,100%{opacity:1;}50%{opacity:0.4;}}

.hidden{display:none!important;}
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="logo"><span class="s">SUBSCRIBE</span> OR <span class="u">UNSUBSCRIBE?</span></div>
    <div class="series-tag">ORIGINAL Series — Sessions 3 & 4 • Host Dashboard</div>
  </div>
  <div class="header-right">
    <div class="status-dot"></div>
    <div class="player-count"><span id="playerNum">0</span> players joined</div>
  </div>
</div>

<div class="main">
  <!-- LEFT -->
  <div class="left">

    <!-- LOBBY PHASE -->
    <div id="lobby-panel" class="phase-card">
      <div class="lobby-state">
        <div style="font-size:48px;margin-bottom:12px;">📲</div>
        <h2>Waiting for players to join</h2>
        <p style="margin-bottom:20px;">Players scan the QR code or go to the URL below to join from their phone. Once everyone is in, hit Start Game.</p>
      </div>
      <div class="qr-section" id="qr-section">
        <div class="qr-box"><img id="qr-img" src="" alt="QR Code"/></div>
        <div class="qr-info">
          <h3>How to join</h3>
          <p>Scan the QR code or type the URL into any phone browser. No app download needed.</p>
          <div class="url-chip" id="join-url">Loading...</div>
        </div>
      </div>
      <div style="margin-top:20px;">
        <button class="btn btn-primary" id="start-btn" onclick="hostAction('startGame')" disabled>START GAME →</button>
      </div>
    </div>

    <!-- QUESTION PHASE -->
    <div id="question-panel" class="phase-card hidden">
      <div class="q-meta">
        <div class="q-badge" id="round-badge">Round 1</div>
        <div class="hard-badge hidden" id="hard-badge">⚠️ TRICKY</div>
        <div style="margin-left:auto;font-size:13px;color:var(--muted);">Q <span id="q-num">1</span> / <span id="q-total">11</span></div>
      </div>

      <div class="timer-ring-wrap">
        <svg class="timer-svg" width="100" height="100" viewBox="0 0 100 100">
          <circle class="timer-bg" cx="50" cy="50" r="42"/>
          <circle class="timer-fg" id="timer-ring" cx="50" cy="50" r="42" stroke-dasharray="264" stroke-dashoffset="0" stroke="var(--green)"/>
          <text class="timer-text" x="50" y="50" id="timer-text" transform="rotate(90,50,50)">20</text>
        </svg>
      </div>

      <div class="q-text-big" id="q-text-host">—</div>

      <div class="ans-count">
        <div>
          <div class="ans-count-label">Answered</div>
          <div class="ans-count-num"><span id="ans-num">0</span> / <span id="ans-den">0</span></div>
        </div>
        <button class="btn btn-gold" style="padding:10px 18px;font-size:13px;" onclick="hostAction('revealNow')">REVEAL NOW</button>
      </div>
      <div class="ans-bar"><div class="ans-bar-fill" id="ans-bar" style="width:0%"></div></div>
    </div>

    <!-- REVEAL PHASE -->
    <div id="reveal-panel" class="reveal-panel">
      <div class="reveal-ans" id="reveal-ans-host">SUBSCRIBE</div>
      <div class="reveal-sc" id="reveal-sc-host"></div>
      <div class="reveal-drop" id="reveal-drop-host"></div>
    </div>

    <!-- CONTROLS -->
    <div class="controls" id="controls">
      <div class="btn-row hidden" id="reveal-controls">
        <button class="btn btn-green" onclick="hostAction('showLeaderboard')">SHOW LEADERBOARD</button>
        <button class="btn btn-primary" id="next-btn" onclick="hostAction('nextQuestion')">NEXT QUESTION →</button>
      </div>
      <button class="btn btn-red" style="margin-top:4px;" onclick="if(confirm('Reset game?'))hostAction('resetGame')">↩ RESET GAME</button>
    </div>

  </div>

  <!-- RIGHT — live leaderboard -->
  <div class="right">
    <div class="lb-header">
      <h3>Live Leaderboard</h3>
    </div>
    <div class="lb-list" id="lb-list">
      <div style="text-align:center;padding:40px 0;color:var(--muted);font-size:14px;">Waiting for players...</div>
    </div>
    <!-- done winner -->
    <div class="done-header hidden" id="done-header">
      <div class="done-trophy">🏆</div>
      <div class="done-title">Champion</div>
      <div class="done-winner" id="done-winner">—</div>
    </div>
  </div>
</div>

<script>
const WS_URL = 'ws://' + location.host;
let ws, phase = 'lobby', totalPlayers = 0;
let timerDuration = 20000;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'host' })); loadQR(); };
  ws.onclose = () => setTimeout(connect, 2000);
  ws.onmessage = e => handle(JSON.parse(e.data));
}

function hostAction(type) {
  ws.send(JSON.stringify({ type }));
}

async function loadQR() {
  const r = await fetch('/qr');
  const d = await r.json();
  document.getElementById('qr-img').src = d.qr;
  document.getElementById('join-url').textContent = d.url;
}

function handle(msg) {
  if (msg.type === 'hostState') {
    totalPlayers = msg.players?.length || 0;
    updatePlayerCount(totalPlayers);
    renderLB(msg.players || []);
    if (msg.phase === 'question') showPhase('question');
    return;
  }

  if (msg.type === 'playerJoined' || msg.type === 'playerLeft') {
    totalPlayers = msg.players.length;
    updatePlayerCount(totalPlayers);
    renderLB(msg.players);
    document.getElementById('start-btn').disabled = totalPlayers < 1;
    document.getElementById('ans-den').textContent = totalPlayers;
    return;
  }

  if (msg.type === 'question') {
    phase = 'question';
    showPhase('question');
    const q = msg;
    const idx = q.index;
    timerDuration = q.total_duration;
    const roundLabels = ['Round 1','Round 2','Round 3'];
    const roundIdx = idx < 4 ? 0 : idx < 8 ? 1 : 2;
    const rb = document.getElementById('round-badge');
    rb.textContent = roundLabels[roundIdx];
    rb.className = 'q-badge ' + ['round1','round2','round3'][roundIdx];
    document.getElementById('hard-badge').classList.toggle('hidden', !q.hard);
    document.getElementById('q-num').textContent = idx + 1;
    document.getElementById('q-total').textContent = msg.total;
    document.getElementById('q-text-host').textContent = q.text;
    document.getElementById('ans-num').textContent = '0';
    document.getElementById('ans-den').textContent = totalPlayers;
    document.getElementById('ans-bar').style.width = '0%';
    document.getElementById('reveal-panel').style.display = 'none';
    document.getElementById('reveal-controls').classList.add('hidden');
    return;
  }

  if (msg.type === 'timer') {
    const secs = Math.ceil(msg.remaining / 1000);
    const pct = msg.remaining / timerDuration;
    const circ = 264;
    const offset = circ * (1 - pct);
    const ring = document.getElementById('timer-ring');
    ring.setAttribute('stroke-dashoffset', offset);
    ring.setAttribute('stroke', pct > 0.5 ? 'var(--green)' : pct > 0.25 ? 'var(--gold)' : 'var(--red)');
    document.getElementById('timer-text').textContent = secs;
    return;
  }

  if (msg.type === 'answerCount') {
    document.getElementById('ans-num').textContent = msg.answered;
    document.getElementById('ans-den').textContent = msg.total;
    const pct = msg.total > 0 ? (msg.answered / msg.total * 100) : 0;
    document.getElementById('ans-bar').style.width = pct + '%';
    return;
  }

  if (msg.type === 'reveal') {
    phase = 'reveal';
    const q = msg.question;
    const isSub = q.ans === 'SUBSCRIBE';
    const el = document.getElementById('reveal-ans-host');
    el.textContent = (isSub ? '✅ ' : '🚫 ') + q.ans;
    el.className = 'reveal-ans ' + (isSub ? 'is-sub' : 'is-unsub');
    document.getElementById('reveal-sc-host').textContent = q.sc;
    document.getElementById('reveal-drop-host').textContent = q.drop;
    document.getElementById('reveal-panel').style.display = 'block';
    document.getElementById('reveal-controls').classList.remove('hidden');
    renderLB(msg.leaderboard || []);
    const isLast = msg.qIndex >= QUESTIONS_TOTAL - 1;
    document.getElementById('next-btn').textContent = isLast ? 'FINISH GAME →' : 'NEXT QUESTION →';
    return;
  }

  if (msg.type === 'leaderboard') {
    renderLB(msg.leaderboard);
    return;
  }

  if (msg.type === 'gameOver') {
    phase = 'done';
    renderLB(msg.leaderboard);
    if (msg.leaderboard.length > 0) {
      document.getElementById('done-winner').textContent = msg.leaderboard[0].name;
      document.getElementById('done-header').classList.remove('hidden');
    }
    document.getElementById('reveal-controls').classList.add('hidden');
    return;
  }

  if (msg.type === 'reset') {
    phase = 'lobby';
    showPhase('lobby');
    document.getElementById('done-header').classList.add('hidden');
    document.getElementById('reveal-panel').style.display = 'none';
    document.getElementById('reveal-controls').classList.add('hidden');
    return;
  }
}

const QUESTIONS_TOTAL = 11;

function showPhase(p) {
  document.getElementById('lobby-panel').classList.toggle('hidden', p !== 'lobby');
  document.getElementById('question-panel').classList.toggle('hidden', p !== 'question');
}

function updatePlayerCount(n) {
  document.getElementById('playerNum').textContent = n;
  document.getElementById('start-btn').disabled = n < 1;
}

function renderLB(players) {
  const list = document.getElementById('lb-list');
  if (!players || players.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--muted);font-size:14px;">Waiting for players...</div>';
    return;
  }
  list.innerHTML = players.map((p, i) => {
    const medals = ['🥇','🥈','🥉'];
    const rankStr = i < 3 ? medals[i] : p.rank;
    const streakStr = p.streak >= 2 ? '🔥'.repeat(Math.min(p.streak, 5)) : '';
    return \`<div class="lb-item \${i === 0 ? 'rank1' : i === 1 ? 'rank2' : i === 2 ? 'rank3' : ''}">
      <div class="lb-rank">\${rankStr}</div>
      <div class="lb-name">\${esc(p.name)}</div>
      <div class="lb-score">\${p.score}<span class="lb-streak">\${streakStr}</span></div>
    </div>\`;
  }).join('');
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

connect();
</script>
</body>
</html>`;

// ── PLAYER HTML ─────────────────────────────────────────
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Subscribe or Unsubscribe? — Join</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
:root{--green:#22C55E;--red:#EF4444;--gold:#FBBF24;--accent:#8B5CF6;--muted:#64748B;--bg:#08080f;--card:#111118;--border:#1f1f30;}
body{font-family:-apple-system,sans-serif;background:var(--bg);color:#f8fafc;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;}

.screen{width:100%;max-width:400px;display:none;}
.screen.active{display:flex;flex-direction:column;align-items:center;}

/* JOIN */
.logo{font-size:28px;font-weight:900;text-align:center;line-height:1.2;margin-bottom:8px;}
.logo .s{color:var(--green);}
.logo .u{color:var(--red);}
.logo-sub{font-size:12px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;text-align:center;margin-bottom:32px;}
.name-input{width:100%;background:rgba(255,255,255,0.06);border:2px solid var(--border);border-radius:16px;padding:16px 20px;font-size:22px;font-weight:700;color:#fff;text-align:center;outline:none;font-family:inherit;margin-bottom:16px;}
.name-input:focus{border-color:var(--accent);}
.join-btn{width:100%;background:linear-gradient(135deg,var(--accent),#7C3AED);border:none;border-radius:16px;padding:18px;font-size:18px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;letter-spacing:1px;text-transform:uppercase;-webkit-appearance:none;box-shadow:0 6px 24px rgba(139,92,246,0.4);}

/* LOBBY WAIT */
.wait-icon{font-size:64px;margin-bottom:16px;animation:float 2s ease infinite alternate;}
@keyframes float{from{transform:translateY(0);}to{transform:translateY(-10px);}}
.wait-title{font-size:22px;font-weight:800;color:#fff;text-align:center;margin-bottom:8px;}
.wait-name{font-size:32px;font-weight:900;color:var(--accent);text-align:center;margin-bottom:8px;}
.wait-sub{font-size:15px;color:var(--muted);text-align:center;line-height:1.6;}
.dot-anim span{animation:blink 1.2s infinite;}
.dot-anim span:nth-child(2){animation-delay:.2s;}
.dot-anim span:nth-child(3){animation-delay:.4s;}
@keyframes blink{0%,80%,100%{opacity:0;}40%{opacity:1;}}

/* QUESTION */
.q-screen{width:100%;max-width:400px;display:none;flex-direction:column;align-items:center;}
.q-screen.active{display:flex;}

.q-header{width:100%;display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
.q-num-tag{font-size:12px;font-weight:700;color:var(--muted);letter-spacing:2px;text-transform:uppercase;}
.hard-tag{background:rgba(139,92,246,0.15);color:var(--accent);font-size:11px;font-weight:700;padding:3px 10px;border-radius:50px;}

.timer-bar-wrap{width:100%;background:rgba(255,255,255,0.06);border-radius:50px;height:8px;margin-bottom:20px;overflow:hidden;}
.timer-bar-fill{height:100%;border-radius:50px;transition:width 0.2s,background 0.5s;background:var(--green);}

.q-card-p{width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;text-align:center;margin-bottom:20px;}
.q-card-p .q-text{font-size:17px;font-weight:700;color:#fff;line-height:1.6;}

.btn-pair{width:100%;display:flex;flex-direction:column;gap:12px;}
.big-btn{width:100%;border:none;border-radius:16px;padding:20px;font-size:20px;font-weight:900;cursor:pointer;font-family:inherit;letter-spacing:1px;text-transform:uppercase;-webkit-appearance:none;display:flex;align-items:center;justify-content:center;gap:10px;}
.big-btn:active{opacity:0.85;transform:scale(0.98);}
.big-btn:disabled{opacity:0.3;cursor:not-allowed;}
.btn-sub{background:linear-gradient(135deg,var(--green),#16A34A);color:#fff;box-shadow:0 6px 24px rgba(34,197,94,0.3);}
.btn-unsub{background:linear-gradient(135deg,var(--red),#B91C1C);color:#fff;box-shadow:0 6px 24px rgba(239,68,68,0.3);}

/* ANSWERED */
.answered-screen{width:100%;max-width:400px;display:none;flex-direction:column;align-items:center;text-align:center;}
.answered-screen.active{display:flex;}
.answer-chosen{font-size:48px;font-weight:900;margin-bottom:8px;}
.answer-chosen.sub{color:var(--green);}
.answer-chosen.unsub{color:var(--red);}
.ans-wait{font-size:16px;color:var(--muted);line-height:1.6;}

/* REVEAL */
.reveal-screen{width:100%;max-width:400px;display:none;flex-direction:column;align-items:center;text-align:center;gap:16px;}
.reveal-screen.active{display:flex;}
.result-badge{font-size:64px;}
.result-pts{font-size:48px;font-weight:900;}
.result-pts.win{color:var(--green);}
.result-pts.wrong{color:var(--red);}
.result-pts.miss{color:var(--muted);}
.result-label{font-size:16px;color:var(--muted);}
.streak-line{font-size:20px;color:var(--gold);font-weight:700;}
.your-score{font-size:15px;color:var(--muted);margin-top:4px;}
.right-ans{font-size:20px;font-weight:800;margin-top:8px;}
.right-ans.is-sub{color:var(--green);}
.right-ans.is-unsub{color:var(--red);}
.sc-text{font-size:13px;color:var(--gold);font-style:italic;line-height:1.5;max-width:340px;}
.drop-text{font-size:14px;color:var(--muted);line-height:1.6;border-left:3px solid var(--accent);padding-left:12px;text-align:left;max-width:340px;}

/* LEADERBOARD screen */
.lb-screen{width:100%;max-width:400px;display:none;flex-direction:column;gap:8px;}
.lb-screen.active{display:flex;}
.lb-title{font-size:14px;font-weight:700;letter-spacing:3px;color:var(--muted);text-transform:uppercase;text-align:center;margin-bottom:8px;}
.lb-row{display:flex;align-items:center;gap:12px;background:var(--card);border-radius:10px;padding:10px 14px;}
.lb-row.me{border:2px solid var(--accent);}
.lb-row.rank1{background:rgba(251,191,36,0.08);}
.lb-rk{font-size:16px;font-weight:900;width:24px;color:var(--muted);}
.lb-row.rank1 .lb-rk{color:var(--gold);}
.lb-nm{flex:1;font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.lb-sc{font-size:17px;font-weight:900;color:var(--accent);}

/* DONE screen */
.done-screen{width:100%;max-width:400px;display:none;flex-direction:column;align-items:center;text-align:center;gap:12px;}
.done-screen.active{display:flex;}
.done-trophy-p{font-size:72px;animation:bob2 1s ease infinite alternate;}
@keyframes bob2{from{transform:translateY(0);}to{transform:translateY(-10px);}}
.done-title-p{font-size:22px;font-weight:900;color:#fff;}
.done-score{font-size:48px;font-weight:900;color:var(--gold);}
.done-rank{font-size:16px;color:var(--muted);}
.done-verse{font-size:14px;color:var(--muted);font-style:italic;line-height:1.7;border:1px solid var(--border);border-radius:12px;padding:16px;max-width:340px;margin-top:8px;}

.hidden{display:none!important;}
</style>
</head>
<body>

<!-- JOIN SCREEN -->
<div id="join-screen" class="screen active">
  <div class="logo"><span class="s">SUBSCRIBE</span><br>OR<br><span class="u">UNSUBSCRIBE?</span></div>
  <div class="logo-sub">ORIGINAL Series — Sessions 3 & 4</div>
  <input class="name-input" id="name-input" type="text" placeholder="Enter your name" maxlength="16" autocomplete="off" autocorrect="off" spellcheck="false"/>
  <button class="join-btn" onclick="joinGame()">JOIN GAME →</button>
</div>

<!-- LOBBY WAIT -->
<div id="lobby-screen" class="screen">
  <div class="wait-icon">📲</div>
  <div class="wait-title">You're in!</div>
  <div class="wait-name" id="my-name-display">—</div>
  <div class="wait-sub">Waiting for the leader to start the game<span class="dot-anim"><span>.</span><span>.</span><span>.</span></span></div>
</div>

<!-- QUESTION SCREEN -->
<div id="q-screen" class="q-screen">
  <div class="q-header">
    <div class="q-num-tag">Q <span id="q-num-p">1</span> / <span id="q-tot-p">11</span></div>
    <div class="hard-tag hidden" id="hard-tag-p">⚠️ TRICKY</div>
  </div>
  <div class="timer-bar-wrap"><div class="timer-bar-fill" id="timer-bar" style="width:100%"></div></div>
  <div class="q-card-p"><div class="q-text" id="q-text-p">—</div></div>
  <div class="btn-pair">
    <button class="big-btn btn-sub" id="btn-sub-p" onclick="answer('SUBSCRIBE')">✅ SUBSCRIBE</button>
    <button class="big-btn btn-unsub" id="btn-unsub-p" onclick="answer('UNSUBSCRIBE')">🚫 UNSUBSCRIBE</button>
  </div>
</div>

<!-- ANSWERED WAITING -->
<div id="answered-screen" class="answered-screen">
  <div class="answer-chosen" id="ans-chosen-display">✅</div>
  <div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:8px;" id="ans-chosen-text">SUBSCRIBE</div>
  <div class="ans-wait">Answer locked in! Waiting for others<span class="dot-anim"><span>.</span><span>.</span><span>.</span></span></div>
</div>

<!-- REVEAL SCREEN -->
<div id="reveal-screen" class="reveal-screen">
  <div class="result-badge" id="result-emoji">✅</div>
  <div class="result-pts" id="result-pts">+200</div>
  <div class="result-label" id="result-label">Nice!</div>
  <div class="streak-line hidden" id="streak-line">🔥 On a streak!</div>
  <div class="your-score" id="your-score">Total: 0 pts</div>
  <div class="right-ans" id="right-ans-p">SUBSCRIBE</div>
  <div class="sc-text" id="sc-p"></div>
  <div class="drop-text" id="drop-p"></div>
</div>

<!-- LEADERBOARD SCREEN -->
<div id="lb-screen" class="lb-screen">
  <div class="lb-title">Leaderboard</div>
  <div id="lb-rows"></div>
</div>

<!-- DONE SCREEN -->
<div id="done-screen" class="done-screen">
  <div class="done-trophy-p">🏆</div>
  <div class="done-title-p">Game Over!</div>
  <div id="done-rank-p" class="done-rank"></div>
  <div class="done-score" id="done-score-p">0 pts</div>
  <div class="done-verse">"Your word is a lamp to guide my feet and a light for my path." — Psalm 119:105 (NLT)</div>
</div>

<script>
const WS_URL = 'ws://' + location.host;
let ws, myId = null, myName = '', timerDuration = 20000;

function show(id) {
  ['join-screen','lobby-screen','q-screen','answered-screen','reveal-screen','lb-screen','done-screen'].forEach(s => {
    const el = document.getElementById(s);
    if (el) { el.classList.remove('active'); }
  });
  const t = document.getElementById(id);
  if (t) t.classList.add('active');
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onclose = () => setTimeout(connect, 2000);
  ws.onmessage = e => handle(JSON.parse(e.data));
}

function joinGame() {
  const name = document.getElementById('name-input').value.trim() || 'Player';
  myName = name;
  ws.send(JSON.stringify({ type: 'join', name }));
}

function answer(ans) {
  document.getElementById('btn-sub-p').disabled = true;
  document.getElementById('btn-unsub-p').disabled = true;
  ws.send(JSON.stringify({ type: 'answer', ans }));
  // Show waiting state
  const isSub = ans === 'SUBSCRIBE';
  document.getElementById('ans-chosen-display').textContent = isSub ? '✅' : '🚫';
  document.getElementById('ans-chosen-display').className = 'answer-chosen ' + (isSub ? 'sub' : 'unsub');
  document.getElementById('ans-chosen-text').textContent = ans;
  show('answered-screen');
}

function handle(msg) {
  if (msg.type === 'joined') {
    myId = msg.id;
    document.getElementById('my-name-display').textContent = msg.name;
    show('lobby-screen');
    return;
  }

  if (msg.type === 'question') {
    timerDuration = msg.total_duration;
    document.getElementById('q-num-p').textContent = msg.index + 1;
    document.getElementById('q-tot-p').textContent = msg.total;
    document.getElementById('q-text-p').textContent = msg.text;
    document.getElementById('hard-tag-p').classList.toggle('hidden', !msg.hard);
    document.getElementById('btn-sub-p').disabled = false;
    document.getElementById('btn-unsub-p').disabled = false;
    document.getElementById('timer-bar').style.width = '100%';
    document.getElementById('timer-bar').style.background = 'var(--green)';
    show('q-screen');
    return;
  }

  if (msg.type === 'timer') {
    const pct = msg.remaining / timerDuration;
    const bar = document.getElementById('timer-bar');
    bar.style.width = (pct * 100) + '%';
    bar.style.background = pct > 0.5 ? 'var(--green)' : pct > 0.25 ? 'var(--gold)' : 'var(--red)';
    return;
  }

  if (msg.type === 'answerReceived') return; // already showing waiting

  if (msg.type === 'reveal') {
    const isSub = msg.rightAns === 'SUBSCRIBE';
    let emoji, pts, label, ptsClass;
    if (!msg.answered) {
      emoji = '⏰'; pts = '+0'; label = "Time's up!"; ptsClass = 'miss';
    } else if (msg.correct) {
      emoji = '✅'; pts = '+' + msg.pts; label = msg.pts > 250 ? 'FAST! 🚀' : msg.pts > 150 ? 'Nice one!' : 'Correct!'; ptsClass = 'win';
    } else {
      emoji = '❌'; pts = '+0'; label = 'Not quite.'; ptsClass = 'wrong';
    }
    document.getElementById('result-emoji').textContent = emoji;
    document.getElementById('result-pts').textContent = pts;
    document.getElementById('result-pts').className = 'result-pts ' + ptsClass;
    document.getElementById('result-label').textContent = label;
    document.getElementById('your-score').textContent = 'Total: ' + msg.yourScore + ' pts';
    const sl = document.getElementById('streak-line');
    if (msg.streak >= 2 && msg.correct) {
      sl.textContent = '🔥'.repeat(Math.min(msg.streak, 5)) + ' ' + msg.streak + ' in a row!';
      sl.classList.remove('hidden');
    } else { sl.classList.add('hidden'); }
    const ra = document.getElementById('right-ans-p');
    ra.textContent = (isSub ? '✅ ' : '🚫 ') + msg.rightAns;
    ra.className = 'right-ans ' + (isSub ? 'is-sub' : 'is-unsub');
    document.getElementById('sc-p').textContent = msg.scripture;
    document.getElementById('drop-p').textContent = msg.drop;
    show('reveal-screen');
    return;
  }

  if (msg.type === 'leaderboard') {
    const rows = document.getElementById('lb-rows');
    rows.innerHTML = msg.leaderboard.map((p, i) => {
      const medals = ['🥇','🥈','🥉'];
      const rk = i < 3 ? medals[i] : p.rank;
      const isMe = p.id === myId;
      return \`<div class="lb-row \${i===0?'rank1':''} \${isMe?'me':''}">
        <div class="lb-rk">\${rk}</div>
        <div class="lb-nm">\${esc(p.name)}\${isMe?' (you)':''}</div>
        <div class="lb-sc">\${p.score}</div>
      </div>\`;
    }).join('');
    show('lb-screen');
    return;
  }

  if (msg.type === 'gameOver') {
    const me = msg.leaderboard.find(p => p.id === myId);
    if (me) {
      document.getElementById('done-score-p').textContent = me.score + ' pts';
      const medals = ['🥇 1st Place!','🥈 2nd Place!','🥉 3rd Place!'];
      document.getElementById('done-rank-p').textContent = me.rank <= 3 ? medals[me.rank-1] : 'Rank #' + me.rank;
    }
    show('done-screen');
    return;
  }

  if (msg.type === 'reset') { show('lobby-screen'); return; }
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

connect();
</script>
</body>
</html>`;

// ── Start server ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n========================================');
  console.log('  Subscribe or Unsubscribe? — LIVE');
  console.log('========================================');
  console.log(`  Host dashboard:  http://${ip}:${PORT}/host`);
  console.log(`  Player join URL: http://${ip}:${PORT}/play`);
  console.log(`  Local access:    http://localhost:${PORT}/host`);
  console.log('========================================\n');
  console.log('To stop the server: press Ctrl+C\n');
});
