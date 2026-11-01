const socket = io();
const $ = (id) => document.getElementById(id);

const COLORS = ['#3fd0ff', '#ffe14d', '#ff5c8a', '#7cf06b', '#ff9a3c', '#b98bff', '#4dffd2', '#ff7bf2'];

let myId = null;
let state = null;
let localStream = null;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
const peers = new Map(); // id -> { pc, stream, pending, chain, status, caller }
let timerInterval = null;
let clockOffset = 0;

// ---------- kamera i serwery ICE ----------

async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    $('preview').srcObject = localStream;
    $('camStatus').textContent = 'Kamera i mikrofon działają ✅';
  } catch (err) {
    console.warn(err);
    localStream = null;
    $('camStatus').textContent = window.isSecureContext
      ? 'Brak dostępu do kamery/mikrofonu. Możesz grać, ale inni Cię nie zobaczą.'
      : 'Kamera wymaga HTTPS (lub localhost). Zobacz README.';
  }
}

async function loadIceServers() {
  try {
    const res = await fetch('/ice');
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) iceServers = data.iceServers;
  } catch (err) {
    console.warn('Nie udało się pobrać serwerów ICE', err);
  }
}

function toggleTrack(kind, btn) {
  const track = localStream?.getTracks().find((t) => t.kind === kind);
  if (!track) return;
  track.enabled = !track.enabled;
  btn.classList.toggle('off', !track.enabled);
}

// ---------- WebRTC ----------

function createPeer(id, caller) {
  const pc = new RTCPeerConnection({ iceServers });
  const entry = { pc, stream: null, pending: [], chain: Promise.resolve(), status: 'connecting', caller, restarted: false };
  peers.set(id, entry);

  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  } else {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    if (e.streams[0]) {
      entry.stream = e.streams[0];
    } else {
      entry.stream ??= new MediaStream();
      entry.stream.addTrack(e.track);
    }
    attachStream(id);
  };
  pc.onconnectionstatechange = () => {
    entry.status = pc.connectionState;
    if (pc.connectionState === 'failed' && entry.caller && !entry.restarted) {
      // jedna próba ponownego zestawienia połączenia
      entry.restarted = true;
      entry.status = 'connecting';
      sendOffer(id, entry, true);
    }
    updateVideoState(id);
  };
  return entry;
}

async function sendOffer(id, entry, iceRestart = false) {
  const { pc } = entry;
  await pc.setLocalDescription(await pc.createOffer({ iceRestart }));
  socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
}

function callPeer(id) {
  const entry = createPeer(id, true);
  entry.chain = entry.chain.then(() => sendOffer(id, entry)).catch((e) => console.warn(e));
}

async function handleSignal(from, entry, data) {
  const { pc } = entry;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    // kandydaci, którzy przyszli przed opisem sesji
    for (const c of entry.pending.splice(0)) await pc.addIceCandidate(c).catch((e) => console.warn(e));
    if (data.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    if (!pc.remoteDescription) entry.pending.push(data.candidate);
    else await pc.addIceCandidate(data.candidate);
  }
}

socket.on('signal', ({ from, data }) => {
  const entry = peers.get(from) || createPeer(from, false);
  // sygnały od jednej osoby przetwarzamy po kolei
  entry.chain = entry.chain
    .then(() => handleSignal(from, entry, data))
    .catch((err) => console.warn('Błąd sygnalizacji', err));
});

socket.on('peer-left', ({ id }) => {
  const entry = peers.get(id);
  if (entry) entry.pc.close();
  peers.delete(id);
});

// przeglądarka może zablokować autoodtwarzanie dźwięku – każde kliknięcie je wznawia
document.addEventListener('click', () => {
  document.querySelectorAll('.frame video').forEach((v) => v.paused && v.srcObject && v.play().catch(() => {}));
});

// ---------- dołączanie ----------

function savedName() {
  try { return localStorage.getItem('czolko-name') || ''; } catch { return ''; }
}
function saveName(n) {
  try { localStorage.setItem('czolko-name', n); } catch {}
}

function onJoined(res) {
  if (!res.ok) {
    $('homeError').textContent = res.error;
    return;
  }
  myId = res.id;
  $('home').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('roomCode').textContent = res.code;
  history.replaceState(null, '', `?pokoj=${res.code}`);
  // nowy gracz dzwoni do wszystkich obecnych
  for (const id of res.peers) callPeer(id);
}

$('createBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  if (!name) return ($('homeError').textContent = 'Podaj imię.');
  saveName(name);
  socket.emit('create-room', { name }, onJoined);
};

$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return ($('homeError').textContent = 'Podaj imię.');
  if (!code) return ($('homeError').textContent = 'Wpisz kod pokoju.');
  saveName(name);
  socket.emit('join-room', { name, code }, onJoined);
};

$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
$('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($('codeInput').value ? $('joinBtn') : $('createBtn')).click();
});

$('copyLink').onclick = async () => {
  const link = `${location.origin}${location.pathname}?pokoj=${state?.code ?? ''}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('🔗 Link skopiowany!');
  } catch {
    prompt('Skopiuj link:', link);
  }
};
$('micBtn').onclick = () => toggleTrack('audio', $('micBtn'));
$('camBtn').onclick = () => toggleTrack('video', $('camBtn'));

socket.on('disconnect', () => {
  if (myId) toast('Utracono połączenie z serwerem. Odśwież stronę.', true);
});

// ---------- kafelki graczy ----------

function ensureTile(player) {
  let tile = document.getElementById(`tile-${player.id}`);
  if (tile) return tile;
  tile = document.createElement('div');
  tile.id = `tile-${player.id}`;
  tile.className = 'tile';
  tile.innerHTML = `
    <div class="ask-tag hidden">🎤 Pyta</div>
    <div class="frame">
      <video autoplay playsinline></video>
      <div class="no-video">👤<small></small></div>
      <span class="name-chip"></span>
      <div class="score-badge hidden"><b></b><small></small></div>
    </div>
    <div class="word-pill"></div>
    <div class="tile-actions"></div>`;
  if (player.id === myId) {
    tile.classList.add('me');
    tile.querySelector('video').muted = true;
  }
  $('grid').appendChild(tile);
  attachStream(player.id);
  return tile;
}

function attachStream(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (!tile) return;
  const video = tile.querySelector('video');
  const stream = id === myId ? localStream : peers.get(id)?.stream;
  if (stream && video.srcObject !== stream) {
    video.srcObject = stream;
    video.play().catch(() => {});
  }
  updateVideoState(id);
}

function updateVideoState(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (!tile) return;
  const overlay = tile.querySelector('.no-video');
  const note = overlay.querySelector('small');
  if (id === myId) {
    overlay.classList.toggle('hidden', !!localStream);
    note.textContent = localStream ? '' : 'Brak kamery';
    return;
  }
  const entry = peers.get(id);
  const hasVideo = entry?.stream?.getVideoTracks().length;
  const connected = entry?.status === 'connected';
  overlay.classList.toggle('hidden', !!(hasVideo && connected));
  if (!entry || entry.status === 'connecting' || entry.status === 'new') note.textContent = 'Łączenie z kamerą…';
  else if (entry.status === 'failed') note.textContent = 'Nie udało się połączyć kamery (sieć blokuje, potrzebny TURN)';
  else if (entry.status === 'disconnected') note.textContent = 'Połączenie przerwane…';
  else if (!hasVideo) note.textContent = 'Gracz bez kamery';
  else note.textContent = '';
}

function renderTiles() {
  const ids = new Set(state.players.map((p) => p.id));
  for (const tile of [...$('grid').children]) {
    if (!ids.has(tile.id.slice(5))) tile.remove();
  }

  // kolejność kafelków: w grze wg kolejki, w lobby wg dołączenia
  const ordered = state.order.length
    ? [...state.order, ...state.players.map((p) => p.id).filter((id) => !state.order.includes(id))]
    : state.players.map((p) => p.id);
  const inGame = state.phase === 'playing' || state.phase === 'ended';
  const newWord = state.settings.afterGuess === 'newWord';

  for (const id of ordered) {
    const p = state.players.find((x) => x.id === id);
    if (!p) continue;
    const tile = ensureTile(p);
    $('grid').appendChild(tile);

    const isMe = p.id === myId;
    const isTurn = state.turnId === p.id;
    tile.style.setProperty('--c', COLORS[state.players.indexOf(p) % COLORS.length]);
    tile.classList.toggle('turn', isTurn);
    tile.classList.toggle('done', p.guessed && state.phase === 'playing');
    tile.querySelector('.ask-tag').classList.toggle('hidden', !isTurn);
    tile.querySelector('.name-chip').textContent =
      (p.id === state.hostId ? '👑 ' : '') + p.name + (isMe ? ' (Ty)' : '');

    const badge = tile.querySelector('.score-badge');
    badge.classList.toggle('hidden', !inGame);
    if (!newWord && p.guessed) {
      badge.querySelector('b').textContent = `${p.finishPlace}.`;
      badge.querySelector('small').textContent = 'miejsce';
    } else {
      badge.querySelector('b').textContent = p.score;
      badge.querySelector('small').textContent = 'pkt';
    }

    const pill = tile.querySelector('.word-pill');
    pill.className = 'word-pill';
    if (state.phase === 'lobby' || state.phase === 'collect') {
      pill.classList.add('empty');
      pill.textContent = state.phase === 'collect'
        ? (p.submitted ? 'Hasła wpisane ✅' : 'Wpisuje hasła…')
        : 'Czeka na start';
    } else if (p.word == null) {
      pill.classList.add('secret');
      pill.textContent = '???';
    } else if (p.guessed) {
      pill.classList.add('solved');
      pill.textContent = `✔ ${p.word}`;
    } else {
      pill.textContent = p.word;
    }

    const actions = tile.querySelector('.tile-actions');
    actions.innerHTML = '';
    if (state.phase === 'playing' && !isMe && !p.guessed) {
      const btn = document.createElement('button');
      btn.className = 'btn secondary';
      btn.textContent = '✔ Zgadł!';
      btn.onclick = () => {
        if (confirm(`${p.name} zgadł(a) hasło „${p.word}”?`)) {
          socket.emit('mark-guessed', { playerId: p.id });
        }
      };
      actions.appendChild(btn);
    }
  }
}

// ---------- panel ----------

function showPanel(name) {
  $('panel').classList.toggle('hidden', !name);
  for (const id of ['lobbyPanel', 'collectPanel', 'endPanel']) {
    $(id).classList.toggle('hidden', id !== name);
  }
  $('statusBar').classList.toggle('hidden', state.phase !== 'playing');
}

const isHost = () => state && state.hostId === myId;
const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? '?';

function renderRoundPill() {
  const labels = { lobby: 'lobby', collect: 'wpisywanie haseł', ended: 'koniec gry' };
  $('roundPill').textContent = state.phase === 'playing' ? `tura ${state.turnNumber}` : labels[state.phase];
}

function renderLobby() {
  showPanel('lobbyPanel');
  const s = state.settings;
  $('hostSettings').classList.toggle('hidden', !isHost());
  $('guestSettings').classList.toggle('hidden', isHost());

  if (isHost()) {
    document.querySelectorAll('input[name=mode]').forEach((r) => (r.checked = r.value === s.mode));
    document.querySelectorAll('input[name=afterGuess]').forEach((r) => (r.checked = r.value === s.afterGuess));
    $('turnTime').value = String(s.turnTime);
    $('categoryBox').classList.toggle('hidden', s.mode !== 'categories');

    const list = $('categoryList');
    if (!list.children.length) {
      for (const c of state.categories) {
        const label = document.createElement('label');
        label.innerHTML = `<input type="checkbox" value="${esc(c)}"><span>${esc(c)}</span>`;
        list.appendChild(label);
      }
    }
    list.querySelectorAll('input').forEach((cb) => (cb.checked = s.categories.includes(cb.value)));
    $('startBtn').disabled = state.players.length < 2;
    $('startBtn').textContent = state.players.length < 2 ? 'Czekam na graczy…' : '▶ Start gry';
  } else {
    $('guestSettings').innerHTML = `
      <p><b>Tryb:</b> ${s.mode === 'custom' ? 'własne hasła' : 'losowe z kategorii'}</p>
      ${s.mode === 'categories' ? `<p><b>Kategorie:</b> ${s.categories.map(esc).join(', ')}</p>` : ''}
      <p><b>Po zgadnięciu:</b> ${s.afterGuess === 'finish' ? 'koniec gry dla gracza' : 'nowe hasło'}</p>
      <p><b>Czas tury:</b> ${s.turnTime ? s.turnTime + ' s' : 'bez limitu'}</p>
      <p class="muted small">Czekamy, aż host ${esc(nameOf(state.hostId))} rozpocznie grę…</p>`;
  }
}

function sendSettings() {
  socket.emit('update-settings', {
    mode: document.querySelector('input[name=mode]:checked')?.value,
    afterGuess: document.querySelector('input[name=afterGuess]:checked')?.value,
    turnTime: $('turnTime').value,
    categories: [...$('categoryList').querySelectorAll('input:checked')].map((c) => c.value)
  });
}
$('lobbyPanel').addEventListener('change', (e) => {
  if (e.target.closest('#categoryList') && !$('categoryList').querySelector('input:checked')) {
    e.target.checked = true; // przynajmniej jedna kategoria
    return;
  }
  sendSettings();
});

$('startBtn').onclick = () => {
  socket.emit('start-game', (res) => {
    $('lobbyError').textContent = res.ok ? '' : res.error;
  });
};

function renderCollect() {
  showPanel('collectPanel');
  const me = state.players.find((p) => p.id === myId);
  const inputs = $('wordInputs');
  if (inputs.children.length !== state.wordsPerPlayer) {
    inputs.innerHTML = '';
    for (let i = 0; i < state.wordsPerPlayer; i++) {
      const inp = document.createElement('input');
      inp.maxLength = 40;
      inp.placeholder = `Hasło ${i + 1}`;
      inputs.appendChild(inp);
    }
  }
  $('wordsForm').classList.toggle('hidden', me.submitted);
  $('collectDone').classList.toggle('hidden', !me.submitted);
  $('collectStatus').innerHTML = state.players
    .map((p) => `<div class="status-row"><span>${esc(p.name)}</span><span class="meta">${p.submitted ? '✅ gotowe' : '⌛ wpisuje'}</span></div>`)
    .join('');
}

$('wordsForm').onsubmit = (e) => {
  e.preventDefault();
  const words = [...$('wordInputs').querySelectorAll('input')].map((i) => i.value.trim());
  if (words.some((w) => !w)) return ($('collectError').textContent = 'Uzupełnij wszystkie pola.');
  const lower = words.map((w) => w.toLowerCase());
  if (new Set(lower).size !== lower.length) return ($('collectError').textContent = 'Hasła nie mogą się powtarzać.');
  socket.emit('submit-words', words, (res) => {
    $('collectError').textContent = res.ok ? '' : res.error;
    if (res.ok) $('wordInputs').querySelectorAll('input').forEach((i) => (i.value = ''));
  });
};

function renderPlay() {
  showPanel(null);
  const myTurn = state.turnId === myId;
  const me = state.players.find((p) => p.id === myId);
  $('turnTitle').textContent = myTurn ? '🎤 Twoja kolej!' : `Pyta: ${nameOf(state.turnId)}`;
  $('turnHint').textContent = myTurn
    ? 'Zadawaj pytania na tak/nie. Gdy zgadniesz, ktoś kliknie „Zgadł!” pod Twoją kamerką.'
    : me?.guessed
      ? 'Zgadłeś(-aś) swoje hasło! Pomagaj odpowiadać pozostałym.'
      : 'Odpowiadaj na głos: tak / nie. Gdy gracz zgadnie, kliknij „Zgadł!” pod jego kamerką.';
  $('nextBtn').classList.toggle('hidden', !(myTurn || isHost()));
  $('nextBtn').textContent = myTurn ? 'Pasuję ➜' : 'Następny ➜';
  $('endBtn').classList.toggle('hidden', !isHost());
  renderTimer();
}

function renderTimer() {
  clearInterval(timerInterval);
  const el = $('timer');
  if (!state.turnEndsAt) return el.classList.add('hidden');
  el.classList.remove('hidden');
  const tick = () => {
    const left = Math.max(0, Math.ceil((state.turnEndsAt - (Date.now() + clockOffset)) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('low', left <= 10);
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

function renderEnd() {
  showPanel('endPanel');
  clearInterval(timerInterval);
  const newWord = state.settings.afterGuess === 'newWord';
  const sorted = [...state.players].sort((a, b) =>
    newWord ? b.score - a.score : (a.finishPlace ?? 99) - (b.finishPlace ?? 99));
  const medals = ['🥇', '🥈', '🥉'];
  $('ranking').innerHTML = sorted
    .map((p, i) => {
      const result = newWord ? `${p.score} pkt` : p.guessed ? 'zgadł(a)' : 'nie zgadł(a)';
      const words = [...p.history];
      if (!p.guessed || newWord) words.push(`${p.word} (niezgadnięte)`);
      return `<li>${medals[i] ?? `${i + 1}.`} <b>${esc(p.name)}</b> – ${result}, tur: ${p.turns}<div class="words">${words.map(esc).join(', ')}</div></li>`;
    })
    .join('');
  $('endHostBtns').classList.toggle('hidden', !isHost());
  $('endGuestInfo').classList.toggle('hidden', isHost());
}

socket.on('state', (s) => {
  state = s;
  clockOffset = s.serverNow - Date.now();
  renderTiles();
  renderRoundPill();
  if (s.phase === 'lobby') renderLobby();
  else if (s.phase === 'collect') renderCollect();
  else if (s.phase === 'playing') renderPlay();
  else renderEnd();
});

socket.on('guessed', ({ playerId, word }) => {
  toast(playerId === myId ? `🎉 Zgadłeś(-aś)! Twoje hasło: ${word}` : `🎉 ${nameOf(playerId)} zgadł(a): ${word}`);
});

$('nextBtn').onclick = () => socket.emit('next-turn');
$('endBtn').onclick = () => { if (confirm('Zakończyć grę dla wszystkich?')) socket.emit('end-game'); };
$('againBtn').onclick = () => socket.emit('start-game', () => {});
$('lobbyBtn').onclick = () => socket.emit('back-to-lobby');

// ---------- drobiazgi ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimeout = null;
function toast(msg, sticky = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('warn', sticky);
  el.classList.remove('hidden');
  clearTimeout(toastTimeout);
  if (!sticky) toastTimeout = setTimeout(() => el.classList.add('hidden'), 3500);
}

// start: przyciski działają dopiero, gdy kamera i serwery ICE są gotowe
$('nameInput').value = savedName();
const codeFromUrl = new URLSearchParams(location.search).get('pokoj');
if (codeFromUrl) $('codeInput').value = codeFromUrl.toUpperCase();
Promise.all([initMedia(), loadIceServers()]).then(() => {
  $('createBtn').disabled = false;
  $('joinBtn').disabled = false;
});
