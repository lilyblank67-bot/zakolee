const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const CATEGORIES = require('./words');

const PORT = process.env.PORT || 3000;
const WORDS_PER_PLAYER = 10;
const MAX_PLAYERS = 8;
// ile czasu gracz ma na powrót po rozłączeniu (crash, odświeżenie, zerwany internet)
const LOBBY_GRACE_MS = 60 * 1000;
const GAME_GRACE_MS = 5 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// ---------- serwery STUN/TURN dla WebRTC ----------
// Bez TURN-a kamerki często nie łączą się między różnymi sieciami (NAT, internet mobilny).
// Ustaw na hostingu zmienne środowiskowe:
//  - Cloudflare (darmowe 1000 GB/mies.): CF_TURN_KEY_ID, CF_TURN_API_TOKEN
//  - albo dowolny TURN: TURN_URLS (po przecinku), TURN_USERNAME, TURN_CREDENTIAL
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
let iceCache = { servers: null, until: 0 };

async function getIceServers() {
  if (process.env.TURN_URLS) {
    return [...STUN, {
      urls: process.env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    }];
  }
  const { CF_TURN_KEY_ID: keyId, CF_TURN_API_TOKEN: token } = process.env;
  if (!keyId || !token) return STUN;
  if (iceCache.servers && Date.now() < iceCache.until) return iceCache.servers;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const turn = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    iceCache = { servers: [...STUN, ...turn], until: Date.now() + 12 * 3600 * 1000 };
    return iceCache.servers;
  } catch (err) {
    console.error('Nie udało się pobrać danych TURN z Cloudflare:', err.message);
    return STUN;
  }
}

app.get('/ice', async (req, res) => {
  res.json({ iceServers: await getIceServers() });
});

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
    turnNumber: 0,
    turnEndsAt: null,
    timeUp: false,
    timer: null,
    usedWords: new Set(),
    customPool: [],
    finishCounter: 0
  };
}

function newPlayer(name) {
  return {
    id: crypto.randomBytes(6).toString('hex'), // publiczny identyfikator (widzą go inni)
    secret: crypto.randomBytes(16).toString('hex'), // tajny klucz do powrotu do gry
    socketId: null,
    connected: true,
    leaveTimer: null,
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
  room.timeUp = false;
}

function beginTurn(room) {
  clearTimer(room);
  const id = currentTurnId(room);
  const p = id && room.players.get(id);
  if (p) p.turns++;
  room.turnNumber++;
  if (room.settings.turnTime > 0) {
    room.turnEndsAt = Date.now() + room.settings.turnTime * 1000;
    // po czasie tura się nie kończy sama – pytający musi kliknąć „Zakończ pytanie”
    room.timer = setTimeout(() => {
      room.timeUp = true;
      broadcast(room);
    }, room.settings.turnTime * 1000);
  }
}

/** Przechodzi do następnego gracza, który jeszcze nie zgadł. */
function advanceTurn(room) {
  if (room.phase !== 'playing') return;
  if (!activePlayers(room).length) return endGame(room);
  const n = room.order.length;
  // najpierw szukamy kogoś połączonego, rozłączonych pomijamy (chyba że nikogo innego nie ma)
  for (const needConnected of [true, false]) {
    for (let step = 1; step <= n; step++) {
      const idx = (room.turnIndex + step) % n;
      const p = room.players.get(room.order[idx]);
      if (p && !p.guessed && (p.connected || !needConnected)) {
        room.turnIndex = idx;
        return beginTurn(room);
      }
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
  room.turnNumber = 0;
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
    turnNumber: room.turnNumber,
    turnEndsAt: room.turnEndsAt,
    timeUp: room.timeUp,
    serverNow: Date.now(),
    order: room.order,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
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
  for (const p of room.players.values()) {
    if (p.connected) io.to(p.socketId).emit('state', viewFor(room, p.id));
  }
}

// ---------- socket.io ----------

function removePlayer(r, id) {
  const p = r.players.get(id);
  if (!p) return;
  clearTimeout(p.leaveTimer);
  const wasTurn = currentTurnId(r) === id;
  r.players.delete(id);
  io.to(r.code).emit('peer-left', { id });

  if (!r.players.size) {
    clearTimer(r);
    rooms.delete(r.code);
    return;
  }
  if (r.hostId === id) r.hostId = pickHost(r);

  if (r.phase === 'playing') {
    const idx = r.order.indexOf(id);
    if (idx !== -1) r.order.splice(idx, 1);
    if (idx !== -1 && idx < r.turnIndex) r.turnIndex--;
    if (r.players.size < 2 || !activePlayers(r).length) {
      endGame(r);
    } else if (wasTurn) {
      // turnIndex wskazuje już na następnego gracza – cofamy o jeden i przechodzimy dalej
      r.turnIndex = (r.turnIndex - 1 + r.order.length) % r.order.length;
      advanceTurn(r);
    }
  } else if (r.phase === 'collect') {
    r.customPool = r.customPool.filter((e) => e.owner !== id);
    if (r.players.size < 2) r.phase = 'lobby';
    else maybeStartCustom(r);
  } else if (r.phase === 'ended') {
    r.order = r.order.filter((x) => x !== id);
  }
  broadcast(r);
}

/** Nowy host: najlepiej ktoś, kto jest połączony. */
function pickHost(r) {
  const all = [...r.players.values()];
  return (all.find((p) => p.connected) || all[0]).id;
}

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  const isHost = () => room && me && room.hostId === me.id;

  function attach(targetRoom, player, cb) {
    room = targetRoom;
    me = player;
    clearTimeout(me.leaveTimer);
    me.leaveTimer = null;
    me.socketId = socket.id;
    me.connected = true;
    socket.join(room.code);
    const peers = [...room.players.values()].filter((p) => p.id !== me.id && p.connected).map((p) => p.id);
    cb({ ok: true, code: room.code, id: me.id, token: me.secret, name: me.name, peers });
    socket.to(room.code).emit('peer-joined', { id: me.id });
    broadcast(room);
  }

  socket.on('create-room', ({ name } = {}, cb = () => {}) => {
    name = cleanText(name, 20);
    if (!name) return cb({ ok: false, error: 'Podaj imię.' });
    if (room) return cb({ ok: false, error: 'Już jesteś w pokoju.' });
    const p = newPlayer(name);
    const r = createRoom(p.id);
    rooms.set(r.code, r);
    r.players.set(p.id, p);
    attach(r, p, cb);
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
    const p = newPlayer(name);
    r.players.set(p.id, p);
    attach(r, p, cb);
  });

  // powrót do gry po odświeżeniu strony, crashu albo zerwaniu internetu
  socket.on('resume', ({ code, token } = {}, cb = () => {}) => {
    if (room) return cb({ ok: false, error: 'Już jesteś w pokoju.' });
    const r = rooms.get(cleanText(code, 5).toUpperCase());
    if (!r) return cb({ ok: false, error: 'Ten pokój już nie istnieje.' });
    const p = [...r.players.values()].find((x) => x.secret === token);
    if (!p) return cb({ ok: false, error: 'Nie ma Cię już w tym pokoju.' });
    if (p.connected) {
      // stare połączenie jeszcze wisi (np. po crashu) – przejmujemy je
      const old = io.sockets.sockets.get(p.socketId);
      p.socketId = socket.id; // dzięki temu zamknięcie starego połączenia nie usunie gracza
      if (old) old.disconnect(true);
    }
    attach(r, p, cb);
  });

  socket.on('leave-room', () => {
    if (!room) return;
    const r = room;
    const id = me.id;
    room = null;
    me = null;
    socket.leave(r.code);
    removePlayer(r, id);
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
    if (!Array.isArray(words)) return cb({ ok: false, error: 'Błędne dane.' });
    const clean = [...new Set(words.map((w) => cleanText(w, 40)).filter(Boolean))];
    if (clean.length < WORDS_PER_PLAYER) {
      return cb({ ok: false, error: `Wpisz ${WORDS_PER_PLAYER} różnych haseł.` });
    }
    me.submitted = clean.slice(0, WORDS_PER_PLAYER);
    cb({ ok: true });
    maybeStartCustom(room);
    broadcast(room);
  });

  socket.on('next-turn', () => {
    if (!room || room.phase !== 'playing') return;
    if (me.id !== currentTurnId(room) && !isHost()) return;
    advanceTurn(room);
    broadcast(room);
  });

  socket.on('mark-guessed', ({ playerId } = {}) => {
    if (!room || room.phase !== 'playing') return;
    if (playerId === me.id) return; // nie można zatwierdzić samemu sobie
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

    io.to(room.code).emit('guessed', { playerId: p.id, word: p.history.at(-1), by: me.id });
    if (!activePlayers(room).length) endGame(room);
    else if (wasTurn && p.guessed) advanceTurn(room); // w trybie „nowe hasło” pytający sam kończy turę
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
    const target = room && room.players.get(to);
    if (!target || !target.connected) return;
    io.to(target.socketId).emit('signal', { from: me.id, data });
  });

  socket.on('disconnect', () => {
    if (!room || me.socketId !== socket.id) return; // to połączenie zostało już przejęte
    const r = room;
    const p = me;
    p.connected = false;
    socket.to(r.code).emit('peer-left', { id: p.id });
    if (r.hostId === p.id) r.hostId = pickHost(r);
    // gracz ma chwilę na powrót, zanim usuniemy go z gry
    const grace = r.phase === 'lobby' ? LOBBY_GRACE_MS : GAME_GRACE_MS;
    p.leaveTimer = setTimeout(() => removePlayer(r, p.id), grace);
    if (r.phase === 'playing' && currentTurnId(r) === p.id) {
      // nie blokujemy gry – kolejka idzie dalej, gracz wróci w swojej następnej turze
      advanceTurn(r);
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
