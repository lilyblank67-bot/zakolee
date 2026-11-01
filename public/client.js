// Jeśli łączenie kamer nie działa w niektórych sieciach, dopisz tu serwer TURN:
// { urls: 'turn:adres:3478', username: '...', credential: '...' }
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const socket = io();
const $ = (id) => document.getElementById(id);

let myId = null;
let state = null;
let localStream = null;
const peers = new Map(); // id -> { pc, stream }
let timerInterval = null;
let clockOffset = 0;

// ---------- kamera ----------

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
      ? 'Brak dostępu do kamery/mikrofonu – możesz grać, ale inni Cię nie zobaczą.'
      : 'Kamera wymaga HTTPS (lub localhost). Zobacz README.';
  } finally {
    $('createBtn').disabled = false;
    $('joinBtn').disabled = false;
  }
}

function toggleTrack(kind, btn) {
  const track = localStream?.getTracks().find((t) => t.kind === kind);
  if (!track) return;
  track.enabled = !track.enabled;
  btn.classList.toggle('off', !track.enabled);
}

// ---------- WebRTC ----------

function createPeer(id) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const entry = { pc, stream: new MediaStream() };
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
    entry.stream = e.streams[0] || entry.stream;
    if (!e.streams[0]) entry.stream.addTrack(e.track);
    attachStream(id);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce?.();
  };
  return entry;
}

async function callPeer(id) {
  const { pc } = createPeer(id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
}

socket.on('signal', async ({ from, data }) => {
  let entry = peers.get(from);
  if (!entry) entry = createPeer(from);
  const { pc } = entry;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (err) {
    console.warn('Błąd sygnalizacji', err);
  }
});

socket.on('peer-left', ({ id }) => {
  const entry = peers.get(id);
  if (entry) entry.pc.close();
  peers.delete(id);
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
    toast('Link skopiowany!');
  } catch {
    prompt('Skopiuj link:', link);
  }
};
$('micBtn').onclick = () => toggleTrack('audio', $('micBtn'));
$('camBtn').onclick = () => toggleTrack('video', $('camBtn'));

socket.on('disconnect', () => {
  if (myId) toast('Utracono połączenie z serwerem. Odśwież stronę.', true);
});

// ---------- kafelki wideo ----------

function ensureTile(player) {
  let tile = document.getElementById(`tile-${player.id}`);
  if (tile) return tile;
  tile = document.createElement('div');
  tile.id = `tile-${player.id}`;
  tile.className = 'tile';
  tile.innerHTML = `
    <div class="video-wrap">
      <video autoplay playsinline></video>
      <div class="no-video">👤</div>
      <span class="name-tag"></span>
      <span class="turn-tag hidden">Pyta teraz</span>
    </div>
    <div class="word-label"></div>
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
  tile.querySelector('.no-video').classList.toggle('hidden', !!stream);
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

  for (const id of ordered) {
    const p = state.players.find((x) => x.id === id);
    if (!p) continue;
    const tile = ensureTile(p);
    $('grid').appendChild(tile);

    const isMe = p.id === myId;
    const isTurn = state.turnId === p.id;
    tile.classList.toggle('turn', isTurn);
    tile.classList.toggle('done', p.guessed && state.phase === 'playing');
    tile.querySelector('.turn-tag').classList.toggle('hidden', !isTurn);
    tile.querySelector('.name-tag').textContent =
      (isMe ? `${p.name} (Ty)` : p.name) + (p.id === state.hostId ? ' 👑' : '');

    const label = tile.querySelector('.word-label');
    label.className = 'word-label';
    if (state.phase === 'lobby' || state.phase === 'collect') {
      label.classList.add('empty');
      label.textContent = state.phase === 'collect'
        ? (p.submitted ? 'Hasła wpisane ✅' : 'Wpisuje hasła…')
        : 'Czeka na start';
    } else if (p.word == null) {
      label.classList.add('secret');
      label.textContent = '???';
    } else if (p.guessed) {
      label.classList.add('solved');
      label.textContent = `✔ ${p.word}`;
    } else {
      label.textContent = p.word;
    }

    const actions = tile.querySelector('.tile-actions');
    actions.innerHTML = '';
    if (state.phase === 'playing' && !isMe && !p.guessed) {
      const btn = document.createElement('button');
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
  for (const id of ['lobbyPanel', 'collectPanel', 'playPanel', 'endPanel']) {
    $(id).classList.toggle('hidden', id !== name);
  }
}

const isHost = () => state && state.hostId === myId;
const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? '?';

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
        label.innerHTML = `<input type="checkbox" value="${c}"> ${c}`;
        list.appendChild(label);
      }
    }
    list.querySelectorAll('input').forEach((cb) => (cb.checked = s.categories.includes(cb.value)));
    $('startBtn').disabled = state.players.length < 2;
    $('startBtn').textContent = state.players.length < 2 ? 'Czekam na graczy…' : 'Start gry';
  } else {
    $('guestSettings').innerHTML = `
      <p><b>Tryb:</b> ${s.mode === 'custom' ? 'własne hasła' : 'losowe z kategorii'}</p>
      ${s.mode === 'categories' ? `<p><b>Kategorie:</b> ${s.categories.join(', ')}</p>` : ''}
      <p><b>Po zgadnięciu:</b> ${s.afterGuess === 'finish' ? 'koniec gry dla gracza' : 'nowe hasło'}</p>
      <p><b>Czas tury:</b> ${s.turnTime ? s.turnTime + ' s' : 'bez limitu'}</p>
      <p class="muted small">Czekamy, aż host ${nameOf(state.hostId)} rozpocznie grę…</p>`;
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
  showPanel('playPanel');
  const myTurn = state.turnId === myId;
  const me = state.players.find((p) => p.id === myId);
  $('turnTitle').textContent = myTurn ? '🎤 Twoja kolej!' : `Pyta: ${nameOf(state.turnId)}`;
  $('turnHint').textContent = myTurn
    ? 'Zadawaj pytania na tak/nie. Inni odpowiadają na głos. Gdy zgadniesz – ktoś kliknie „Zgadł!” pod Twoją kamerką.'
    : me?.guessed
      ? 'Zgadłeś(-aś) swoje hasło! Pomagaj odpowiadać pozostałym.'
      : 'Odpowiadaj na głos „tak” / „nie”. Gdy gracz zgadnie, kliknij „Zgadł!” pod jego kamerką.';
  $('nextBtn').classList.toggle('hidden', !(myTurn || isHost()));
  $('nextBtn').textContent = myTurn ? 'Pasuję – następny gracz ➜' : 'Następny gracz ➜';
  $('endBtn').classList.toggle('hidden', !isHost());

  const newWord = state.settings.afterGuess === 'newWord';
  const sorted = [...state.players].sort((a, b) =>
    newWord ? b.score - a.score : (a.finishPlace ?? 99) - (b.finishPlace ?? 99));
  $('scoreList').innerHTML = sorted
    .map((p) => {
      const result = newWord
        ? `${p.score} pkt`
        : p.guessed ? `🏅 ${p.finishPlace}. miejsce` : 'zgaduje…';
      return `<div class="status-row"><span>${esc(p.name)}</span><span class="meta">${result} · tur: ${p.turns}</span></div>`;
    })
    .join('');

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
  $('ranking').innerHTML = sorted
    .map((p) => {
      const result = newWord ? `${p.score} pkt` : p.guessed ? 'zgadł(a)' : 'nie zgadł(a)';
      const words = [...p.history];
      if (!p.guessed || newWord) words.push(`${p.word} (niezgadnięte)`);
      return `<li><b>${esc(p.name)}</b> – ${result}, tur: ${p.turns}<div class="words">${words.map(esc).join(', ')}</div></li>`;
    })
    .join('');
  $('endHostBtns').classList.toggle('hidden', !isHost());
  $('endGuestInfo').classList.toggle('hidden', isHost());
}

socket.on('state', (s) => {
  state = s;
  clockOffset = s.serverNow - Date.now();
  renderTiles();
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
  el.classList.remove('hidden');
  clearTimeout(toastTimeout);
  if (!sticky) toastTimeout = setTimeout(() => el.classList.add('hidden'), 3500);
}

// start
$('nameInput').value = savedName();
const codeFromUrl = new URLSearchParams(location.search).get('pokoj');
if (codeFromUrl) $('codeInput').value = codeFromUrl.toUpperCase();
initMedia();
