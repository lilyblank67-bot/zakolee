const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const CATEGORIES = require('./words');

const PORT = process.env.PORT || 3000;
const WORDS_PER_PLAYER = 10;
const MAX_PLAYERS = 8;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- pomocnicze ----------

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function createRoom(hostId) {
  return {
    code: makeCode(),
    hostId,
    players: new Map(),
    phase: 'lobby', // lobby | collect | playing | ended
    settings: {
      mode: 'categories', // categories | custom
      categories: [Object.keys(CATEGORIES)[0]],
      afterGuess: 'finish', // finish | newWord
      turnTime: 0
    },
    order: [],
    turnIndex: 0,
    turnEndsAt: null,
    timer: null,
    usedWords: new Set(),
    customPool: [],
    finishCounter: 0
  };
}

function newPlayer(id, name) {
  return {
    id,
    name,
    word: null,
    guessed: false,
    finishPlace: null,
    score: 0,
    turns: 0,
    submitted: null, // własne hasła w trybie custom
    history: [] // zgadnięte hasła
  };
}

function resetPlayerForGame(p) {
  p.word = null;
  p.guessed = false;
  p.finishPlace = null;
  p.score = 0;
  p.turns = 0;
  p.history = [];
}

/** Losuje następne hasło dla gracza. Zwraca null, gdy pula się skończyła. */
function drawWord(room, player) {
  if (room.settings.mode === 'categories') {
    const all = room.settings.categories.flatMap((c) => CATEGORIES[c] || []);
    const free = all.filter((w) => !room.usedWords.has(w));
    if (!free.length) return null;
    const w = free[Math.floor(Math.random() * free.length)];
    room.usedWords.add(w);
    return w;
  }
  // tryb własnych haseł: nigdy hasło wpisane przez tego gracza
  const candidates = room.customPool.filter((e) => !e.used && e.owner !== player.id);
  if (!candidates.length) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  pick.used = true;
  return pick.word;
}

function activePlayers(room) {
  return room.order.filter((id) => {
    const p = room.players.get(id);
    return p && !p.guessed;
  });
}

function currentTurnId(room) {
  if (room.phase !== 'playing') return null;
  return room.order[room.turnIndex] ?? null;
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.turnEndsAt = null;
}

function beginTurn(room) {
  clearTimer(room);
  const id = currentTurnId(room);
  const p = id && room.players.get(id);
  if (p) p.turns++;
  if (room.settings.turnTime > 0) {
    room.turnEndsAt = Date.now() + room.settings.turnTime * 1000;
    room.timer = setTimeout(() => {
      advanceTurn(room);
      broadcast(room);
    }, room.settings.turnTime * 1000);
  }
}

/** Przechodzi do następnego gracza, który jeszcze nie zgadł. */
function advanceTurn(room) {
  if (room.phase !== 'playing') return;
  if (!activePlayers(room).length) return endGame(room);
  const n = room.order.length;
  for (let step = 1; step <= n; step++) {
    const idx = (room.turnIndex + step) % n;
    const p = room.players.get(room.order[idx]);
    if (p && !p.guessed) {
      room.turnIndex = idx;
      return beginTurn(room);
    }
  }
  endGame(room);
}

function startPlaying(room) {
  room.usedWords = new Set();
  room.finishCounter = 0;
  room.order = shuffle([...room.players.keys()]);
  for (const id of room.order) {
    const p = room.players.get(id);
    resetPlayerForGame(p);
    p.word = drawWord(room, p) ?? '(brak hasła)';
  }
  room.turnIndex = 0;
  room.phase = 'playing';
  beginTurn(room);
}

function endGame(room) {
  clearTimer(room);
  room.phase = 'ended';
}

function finishPlayer(room, p) {
  p.guessed = true;
  p.finishPlace = ++room.finishCounter;
}

/** Stan pokoju widziany przez konkretnego gracza – bez jego własnego hasła. */
function viewFor(room, viewerId) {
  const reveal = room.phase === 'ended';
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    categories: Object.keys(CATEGORIES),
    wordsPerPlayer: WORDS_PER_PLAYER,
    turnId: currentTurnId(room),
    turnEndsAt: room.turnEndsAt,
    serverNow: Date.now(),
    order: room.order,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      word: p.id === viewerId && !reveal && !p.guessed ? null : p.word,
      guessed: p.guessed,
      finishPlace: p.finishPlace,
      score: p.score,
      turns: p.turns,
      submitted: !!p.submitted,
      history: p.history
    }))
  };
}

function broadcast(room) {
  for (const id of room.players.keys()) {
    io.to(id).emit('state', viewFor(room, id));
  }
}

// ---------- socket.io ----------

io.on('connection', (socket) => {
  let room = null;

  const isHost = () => room && room.hostId === socket.id;

  function join(targetRoom, name, cb) {
    room = targetRoom;
    const existing = [...room.players.keys()];
    room.players.set(socket.id, newPlayer(socket.id, name));
    socket.join(room.code);
    cb({ ok: true, code: room.code, id: socket.id, peers: existing });
    socket.to(room.code).emit('peer-joined', { id: socket.id });
    broadcast(room);
  }

  socket.on('create-room', ({ name } = {}, cb = () => {}) => {
    name = cleanText(name, 20);
    if (!name) return cb({ ok: false, error: 'Podaj imię.' });
    if (room) return cb({ ok: false, error: 'Już jesteś w pokoju.' });
    const r = createRoom(socket.id);
    rooms.set(r.code, r);
    join(r, name, cb);
  });

  socket.on('join-room', ({ name, code } = {}, cb = () => {}) => {
    name = cleanText(name, 20);
    code = cleanText(code, 5).toUpperCase();
    if (!name) return cb({ ok: false, error: 'Podaj imię.' });
    if (room) return cb({ ok: false, error: 'Już jesteś w pokoju.' });
    const r = rooms.get(code);
    if (!r) return cb({ ok: false, error: 'Nie ma pokoju o takim kodzie.' });
    if (r.players.size >= MAX_PLAYERS) return cb({ ok: false, error: `Pokój jest pełny (max ${MAX_PLAYERS}).` });
    if (r.phase !== 'lobby') return cb({ ok: false, error: 'Gra już trwa – poczekaj na koniec rundy.' });
    join(r, name, cb);
  });

  socket.on('update-settings', (s = {}) => {
    if (!isHost() || room.phase !== 'lobby') return;
    const st = room.settings;
    if (s.mode === 'categories' || s.mode === 'custom') st.mode = s.mode;
    if (Array.isArray(s.categories)) {
      const valid = s.categories.filter((c) => CATEGORIES[c]);
      if (valid.length) st.categories = valid;
    }
    if (s.afterGuess === 'finish' || s.afterGuess === 'newWord') st.afterGuess = s.afterGuess;
    if ([0, 60, 90, 120].includes(Number(s.turnTime))) st.turnTime = Number(s.turnTime);
    broadcast(room);
  });

  socket.on('start-game', (cb = () => {}) => {
    if (!isHost()) return;
    if (room.phase !== 'lobby' && room.phase !== 'ended') return;
    if (room.players.size < 2) return cb({ ok: false, error: 'Potrzeba co najmniej 2 graczy.' });
    if (room.settings.mode === 'custom') {
      room.phase = 'collect';
      room.customPool = [];
      for (const p of room.players.values()) p.submitted = null;
    } else {
      startPlaying(room);
    }
    cb({ ok: true });
    broadcast(room);
  });

  socket.on('submit-words', (words, cb = () => {}) => {
    if (!room || room.phase !== 'collect') return;
    const p = room.players.get(socket.id);
    if (!Array.isArray(words)) return cb({ ok: false, error: 'Błędne dane.' });
    const clean = [...new Set(words.map((w) => cleanText(w, 40)).filter(Boolean))];
    if (clean.length < WORDS_PER_PLAYER) {
      return cb({ ok: false, error: `Wpisz ${WORDS_PER_PLAYER} różnych haseł.` });
    }
    p.submitted = clean.slice(0, WORDS_PER_PLAYER);
    cb({ ok: true });
    maybeStartCustom(room);
    broadcast(room);
  });

  socket.on('next-turn', () => {
    if (!room || room.phase !== 'playing') return;
    if (socket.id !== currentTurnId(room) && !isHost()) return;
    advanceTurn(room);
    broadcast(room);
  });

  socket.on('mark-guessed', ({ playerId } = {}) => {
    if (!room || room.phase !== 'playing') return;
    if (playerId === socket.id) return; // nie można zatwierdzić samemu sobie
    const p = room.players.get(playerId);
    if (!p || p.guessed) return;
    p.score++;
    p.history.push(p.word);
    const wasTurn = currentTurnId(room) === p.id;

    if (room.settings.afterGuess === 'newWord') {
      const next = drawWord(room, p);
      if (next) {
        p.word = next;
      } else {
        finishPlayer(room, p);
      }
    } else {
      finishPlayer(room, p);
    }

    io.to(room.code).emit('guessed', { playerId: p.id, word: p.history.at(-1), by: socket.id });
    if (!activePlayers(room).length) endGame(room);
    else if (wasTurn) advanceTurn(room);
    broadcast(room);
  });

  socket.on('end-game', () => {
    if (!isHost() || room.phase !== 'playing') return;
    endGame(room);
    broadcast(room);
  });

  socket.on('back-to-lobby', () => {
    if (!isHost()) return;
    clearTimer(room);
    room.phase = 'lobby';
    room.order = [];
    for (const p of room.players.values()) {
      resetPlayerForGame(p);
      p.submitted = null;
    }
    broadcast(room);
  });

  // sygnalizacja WebRTC – serwer tylko przekazuje wiadomości
  socket.on('signal', ({ to, data } = {}) => {
    if (!room || !room.players.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    const r = room;
    const wasTurn = currentTurnId(r) === socket.id;
    r.players.delete(socket.id);
    socket.to(r.code).emit('peer-left', { id: socket.id });

    if (!r.players.size) {
      clearTimer(r);
      rooms.delete(r.code);
      return;
    }
    if (r.hostId === socket.id) r.hostId = r.players.keys().next().value;

    if (r.phase === 'playing') {
      const idx = r.order.indexOf(socket.id);
      r.order.splice(idx, 1);
      if (idx < r.turnIndex) r.turnIndex--;
      if (r.players.size < 2 || !activePlayers(r).length) {
        endGame(r);
      } else if (wasTurn) {
        // turnIndex wskazuje już na następnego gracza – cofamy o jeden i przechodzimy dalej
        r.turnIndex = (r.turnIndex - 1 + r.order.length) % r.order.length;
        advanceTurn(r);
      }
    } else if (r.phase === 'collect') {
      r.customPool = r.customPool.filter((e) => e.owner !== socket.id);
      if (r.players.size < 2) r.phase = 'lobby';
      else maybeStartCustom(r);
    } else if (r.phase === 'ended') {
      r.order = r.order.filter((id) => id !== socket.id);
    }
    broadcast(r);
  });
});

function maybeStartCustom(room) {
  if (room.phase !== 'collect') return;
  const all = [...room.players.values()];
  if (!all.every((p) => p.submitted)) return;
  room.customPool = all.flatMap((p) => p.submitted.map((word) => ({ word, owner: p.id, used: false })));
  startPlaying(room);
}

server.listen(PORT, () => {
  console.log(`Czółko działa: http://localhost:${PORT}`);
});
