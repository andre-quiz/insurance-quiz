const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const defaultQuestions = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Game state store: gamePin -> game object
const games = {};

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function createGame(hostId, customQuestions) {
  const pin = generatePin();
  games[pin] = {
    pin,
    hostId,
    players: {},          // socketId -> { name, score, streak, answers: [] }
    questions: customQuestions || defaultQuestions,
    currentQuestion: -1,
    state: 'lobby',       // lobby | question | answer | leaderboard | podium
    timer: null,
    questionStartTime: null,
  };
  return pin;
}

function getLeaderboard(game) {
  return Object.values(game.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

function endQuestion(pin) {
  const game = games[pin];
  if (!game) return;
  clearTimeout(game.timer);

  const q = game.questions[game.currentQuestion];
  const results = Object.values(game.players).map(p => {
    const ans = p.answers[game.currentQuestion];
    return { name: p.name, correct: ans?.correct ?? false, points: ans?.points ?? 0 };
  });

  const correctCount = results.filter(r => r.correct).length;

  game.state = 'answer';
  io.to(pin).emit('question_end', {
    correctAnswer: q.correct,
    answerText: q.answers[q.correct],
    results,
    correctCount,
    totalPlayers: Object.keys(game.players).length,
  });

  // Send each player their personal result
  Object.entries(game.players).forEach(([sid, player]) => {
    const ans = player.answers[game.currentQuestion];
    io.to(sid).emit('your_result', {
      correct: ans?.correct ?? false,
      points: ans?.points ?? 0,
      totalScore: player.score,
      streak: player.streak,
    });
  });
}

io.on('connection', (socket) => {

  // HOST: Create new game
  socket.on('host_create', ({ questions } = {}) => {
    const pin = createGame(socket.id, questions || null);
    socket.join(pin);
    games[pin].hostSocketId = socket.id;

    const baseUrl = process.env.PUBLIC_URL
      ? process.env.PUBLIC_URL.replace(/\/$/, '')
      : `http://${getLocalIP()}:${PORT}`;
    QRCode.toDataURL(`${baseUrl}/join.html?pin=${pin}`, { width: 300 }, (err, url) => {
      socket.emit('game_created', { pin, qrCode: url, joinUrl: `${baseUrl}/join.html?pin=${pin}` });
    });
  });

  // HOST: Load custom questions
  socket.on('host_set_questions', ({ pin, questions }) => {
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    game.questions = questions;
    socket.emit('questions_loaded', { count: questions.length });
  });

  // HOST: Start game
  socket.on('host_start', ({ pin }) => {
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    if (Object.keys(game.players).length === 0) {
      socket.emit('error_msg', 'Keine Spieler im Raum!');
      return;
    }
    startNextQuestion(pin);
  });

  // HOST: Next question (called after leaderboard screen)
  socket.on('host_next', ({ pin }) => {
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    if (game.currentQuestion + 1 >= game.questions.length) {
      showPodium(pin);
    } else {
      startNextQuestion(pin);
    }
  });

  // PLAYER: Join game
  socket.on('player_join', ({ pin, name }) => {
    const game = games[pin];
    if (!game) { socket.emit('join_error', 'Spiel nicht gefunden!'); return; }
    if (game.state !== 'lobby') { socket.emit('join_error', 'Spiel bereits gestartet!'); return; }
    if (Object.values(game.players).some(p => p.name.toLowerCase() === name.toLowerCase())) {
      socket.emit('join_error', 'Name bereits vergeben!');
      return;
    }

    game.players[socket.id] = { name, score: 0, streak: 0, answers: [] };
    socket.join(pin);
    socket.data.pin = pin;

    socket.emit('join_success', { name, pin });
    io.to(game.hostId).emit('player_joined', {
      name,
      count: Object.keys(game.players).length,
      players: Object.values(game.players).map(p => p.name),
    });
  });

  // PLAYER: Submit answer
  socket.on('player_answer', ({ pin, answerIndex }) => {
    const game = games[pin];
    if (!game || game.state !== 'question') return;
    const player = game.players[socket.id];
    if (!player) return;
    const qIdx = game.currentQuestion;
    if (player.answers[qIdx] !== undefined) return; // already answered

    const q = game.questions[qIdx];
    const elapsed = (Date.now() - game.questionStartTime) / 1000;
    const timeLimit = q.time || 20;
    const isCorrect = answerIndex === q.correct;

    let points = 0;
    if (isCorrect) {
      const speedBonus = Math.max(0, Math.round(1000 * (1 - elapsed / timeLimit)));
      const basePoints = 1000;
      points = basePoints + speedBonus;
      player.streak = (player.streak || 0) + 1;
      if (player.streak >= 3) points = Math.round(points * 1.1); // streak bonus
    } else {
      player.streak = 0;
    }

    player.score += points;
    player.answers[qIdx] = { answerIndex, correct: isCorrect, points, elapsed };

    socket.emit('answer_received', { answerIndex });

    // Check if all players answered
    const answered = Object.values(game.players).filter(p => p.answers[qIdx] !== undefined).length;
    const total = Object.keys(game.players).length;
    io.to(game.hostId).emit('answer_progress', { answered, total });
    if (answered === total) {
      clearTimeout(game.timer);
      endQuestion(pin);
    }
  });

  // HOST: Show leaderboard
  socket.on('host_leaderboard', ({ pin }) => {
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    showLeaderboard(pin);
  });

  socket.on('disconnect', () => {
    const pin = socket.data?.pin;
    if (pin && games[pin]) {
      const game = games[pin];
      if (game.hostId === socket.id) {
        io.to(pin).emit('host_disconnected');
        delete games[pin];
      } else if (game.players[socket.id]) {
        const name = game.players[socket.id].name;
        delete game.players[socket.id];
        io.to(game.hostId).emit('player_left', {
          name,
          count: Object.keys(game.players).length,
          players: Object.values(game.players).map(p => p.name),
        });
      }
    }
  });
});

function startNextQuestion(pin) {
  const game = games[pin];
  game.currentQuestion++;
  const q = game.questions[game.currentQuestion];
  game.state = 'question';
  game.questionStartTime = Date.now();

  const payload = {
    questionIndex: game.currentQuestion,
    total: game.questions.length,
    question: q.question,
    answers: q.answers,
    time: q.time || 20,
  };

  io.to(pin).emit('question_start', payload);

  game.timer = setTimeout(() => {
    endQuestion(pin);
  }, (q.time || 20) * 1000);
}

function showLeaderboard(pin) {
  const game = games[pin];
  game.state = 'leaderboard';
  const hasMore = game.currentQuestion + 1 < game.questions.length;
  io.to(pin).emit('show_leaderboard', { leaderboard: getLeaderboard(game), hasMore });
}

function showPodium(pin) {
  const game = games[pin];
  game.state = 'podium';
  io.to(pin).emit('show_podium', { leaderboard: getLeaderboard(game) });
  // Cleanup after 10 minutes
  setTimeout(() => { delete games[pin]; }, 600000);
}

function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Insurance Quiz läuft auf http://localhost:${PORT}`);
  console.log(`📱 Im Netzwerk: http://${getLocalIP()}:${PORT}`);
  console.log(`\n🎮 Host-Interface:    http://localhost:${PORT}/host.html`);
  console.log(`👥 Spieler-Beitritt:  http://localhost:${PORT}/join\n`);
});
