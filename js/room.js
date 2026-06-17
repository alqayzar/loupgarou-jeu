/**
 * Room page — handles both host and client roles via PeerJS.
 * All peer communication flows through the host.
 *
 * Session shape (stored in IndexedDB under 'game_session'):
 *   { role: 'host'|'client', roomId: string, myPeerId?: string }
 *
 * Player object shape (in-memory + over-the-wire):
 *   { id: string, username: string, image: string|null, isHost: boolean, colorClass: string }
 *
 * Sync strategy: every change broadcasts the full player list.
 * No partial add/remove messages — the list is always the single source of truth.
 */

// ─── Message type constants ──────────────────────────────────────────────────
const MSG = Object.freeze({
  JOIN:       'join',       // client → host: { username, image }
  SYNC:       'sync',       // host → all:   { players }  (full list, on every change)
  HOST_CLOSE: 'host_close', // host → all:   room is closing
  KICK:       'kick',       // host → client: you have been removed
});

// ─── Role definitions ────────────────────────────────────────────────────────
// locked:    can never be disabled
// countable: shows a +/− counter; count = number of players assigned this role
// Villageois is not countable — it always fills whatever slots remain
const ROLES = [
  {
    id: 'villageois', label: 'Villageois', emoji: '🌾', colorClass: 'role-teal',
    locked: true, enabled: true, countable: false, count: null, max: null,
    desc: 'Les habitants du village. Leur seule arme est le vote pour éliminer les suspects chaque matin.',
  },
  {
    id: 'loupgarou', label: 'Loup Garou', emoji: '🐺', colorClass: 'role-orange',
    locked: true, enabled: true, countable: true, count: 1, max: null,
    desc: 'Chaque nuit, les loups choisissent une victime à dévorer. Ils se font passer pour des villageois.',
  },
  {
    id: 'sorciere', label: 'Sorcière', emoji: '🧙', colorClass: 'role-violet',
    locked: false, enabled: true, countable: true, count: 1, max: 1,
    desc: 'Possède une potion de soin et une potion de poison, utilisables une seule fois chacune.',
  },
  {
    id: 'voyante', label: 'Voyante', emoji: '🔮', colorClass: 'role-blue',
    locked: false, enabled: true, countable: true, count: 1, max: 1,
    desc: 'Chaque nuit, elle peut consulter l\'identité secrète d\'un joueur de son choix.',
  },
];

// Cycles through the CSS classes defined in theme.css
const COLOR_CLASSES = [
  'player-color-0', 'player-color-1', 'player-color-2', 'player-color-3',
  'player-color-4', 'player-color-5', 'player-color-6', 'player-color-7',
];

// ─── State ───────────────────────────────────────────────────────────────────
let peer           = null;  // PeerJS instance
let role           = null;  // 'host' | 'client'
let roomId         = null;  // host's peer ID (= room code in URL hash)
let profile        = null;  // { username, image }
let players        = [];    // ordered list — host is authoritative, clients mirror it
let connections    = {};    // host only — { peerId: DataConnection }
let hostConn       = null;  // client only — DataConnection to host
let colorCounter   = 0;     // host only — next colour index to assign
let reconnectTimer = null;

// ─── Initialisation ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  roomId = window.location.hash.slice(1);
  if (!roomId) { goHome(); return; }

  const session = await dbGet('game_session');
  profile = (await dbGet('user_profile')) || { username: 'Joueur', image: null };

  if (!session || session.roomId !== roomId) {
    window.location.replace(`index.html?join=${roomId}`);
    return;
  }

  role = session.role;

  document.getElementById('roomCodeDisplay').textContent = roomId;
  document.getElementById('roomCodeDisplay').addEventListener('click', openShareModal);
  document.getElementById('shareModalCloseBtn').addEventListener('click', closeShareModal);
  document.getElementById('shareModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeShareModal();
  });
  document.getElementById('copyCodeBtn').addEventListener('click', () => {
    navigator.clipboard?.writeText(roomId)
      .then(() => { showToast('Code copié !'); closeShareModal(); })
      .catch(() => showToast(roomId));
  });
  document.getElementById('copyLinkBtn').addEventListener('click', () => {
    const url = buildShareUrl();
    navigator.clipboard?.writeText(url)
      .then(() => { showToast('Lien copié !'); closeShareModal(); })
      .catch(() => showToast(url));
  });
  document.getElementById('navUsername').textContent = profile.username;
  document.getElementById('leaveBtn').addEventListener('click', leaveRoom);

  if (role === 'host') {
    document.getElementById('hostControls').classList.remove('hidden');
    document.body.classList.add('has-host-controls');
    await loadRoleSettings();
    initSettings();
    initHost();
  } else {
    initClient(session.myPeerId || undefined);
  }
});

// ─── Host ─────────────────────────────────────────────────────────────────────
function initHost() {
  setStatus('connecting');
  peer = new Peer(roomId);

  peer.on('open', () => {
    if (!players.find(p => p.isHost)) {
      playerAdd(buildPlayer('host', profile.username, profile.image, true));
    }
    renderAll();
    setStatus('waiting');
  });

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      conn.on('data',  (msg) => onHostReceive(conn, msg));
      conn.on('close', ()    => onClientDisconnect(conn.peer));
    });
    conn.on('error', (err) => console.warn('[host] conn error', err));
  });

  peer.on('error', (err) => {
    console.error('[host] peer error', err.type, err);
    setStatus('error', err.type === 'unavailable-id'
      ? 'Code déjà utilisé, réessaie dans quelques secondes'
      : 'Erreur réseau');
  });

  peer.on('disconnected', () => { setStatus('reconnecting', 'Reconnexion…'); peer.reconnect(); });
}

function onHostReceive(conn, msg) {
  if (msg.type !== MSG.JOIN) return;

  // Register connection before syncing so the newcomer gets the updated list
  connections[conn.peer] = conn;

  // Replace any stale entry for this peer (handles reconnect after reload)
  playerRemove(conn.peer);
  playerAdd(buildPlayer(conn.peer, msg.username, msg.image, false));

  renderAll();
  syncAll();
}

function onClientDisconnect(peerId) {
  delete connections[peerId];
  playerRemove(peerId);
  renderAll();
  syncAll();
}

// Send the full player list to every connected client.
function syncAll() {
  const msg = { type: MSG.SYNC, players };
  for (const conn of Object.values(connections)) conn.send(msg);
  updatePlayerCount();
}

// ─── Client ──────────────────────────────────────────────────────────────────
function initClient(savedPeerId) {
  setStatus('connecting');
  peer = new Peer(savedPeerId);

  peer.on('open', async (id) => {
    const session = await dbGet('game_session');
    await dbSet('game_session', { ...session, myPeerId: id });
    connectToHost();
  });

  peer.on('error', (err) => {
    console.error('[client] peer error', err.type, err);
    if (err.type === 'unavailable-id') {
      reinitClientWithNewId();
    } else {
      setStatus('error', 'Erreur réseau');
    }
  });

  peer.on('disconnected', () => { setStatus('reconnecting', 'Reconnexion…'); peer.reconnect(); });
}

function reinitClientWithNewId() {
  try { peer?.destroy(); } catch (_) {}
  peer = new Peer();
  peer.on('open', async (id) => {
    const session = await dbGet('game_session');
    await dbSet('game_session', { ...session, myPeerId: id });
    connectToHost();
  });
  peer.on('error', (err) => {
    console.error('[client] peer error after reinit', err);
    setStatus('error', 'Impossible de se connecter');
  });
}

function connectToHost() {
  hostConn = peer.connect(roomId, { reliable: true });

  hostConn.on('open', () => {
    hostConn.send({ type: MSG.JOIN, username: profile.username, image: profile.image });
  });

  hostConn.on('data', onClientReceive);

  hostConn.on('close', () => {
    setStatus('reconnecting', 'Hôte déconnecté, reconnexion…');
    scheduleReconnect();
  });

  hostConn.on('error', (err) => {
    console.warn('[client] host conn error', err);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectToHost, 1000);
}

function onClientReceive(msg) {
  switch (msg.type) {
    case MSG.SYNC:
      renderAll(msg.players);
      setStatus('waiting');
      break;
    case MSG.HOST_CLOSE:
      showToast('La room a été fermée');
      setTimeout(goHome, 2000);
      break;
    case MSG.KICK:
      showToast('Vous avez été exclu de la partie');
      setTimeout(async () => { await dbDel('game_session'); goHome(); }, 1800);
      break;
  }
}

// ─── Player list ─────────────────────────────────────────────────────────────

// Build a new player object; host assigns the colour class.
function buildPlayer(id, username, image, isHost) {
  const colorClass = COLOR_CLASSES[colorCounter % COLOR_CLASSES.length];
  colorCounter++;
  return { id, username, image: image || null, isHost, colorClass };
}

function playerAdd(player)  { players.push(player); }
function playerRemove(id)   { players = players.filter((p) => p.id !== id); }

function gridOptions() {
  return { canKick: role === 'host', onKick: kickPlayer };
}

// Rebuild the entire grid — both host and client use this so the DOM always
// mirrors the players array exactly.
function renderAll(incoming) {
  if (incoming) players = incoming;
  renderPlayersGrid(document.getElementById('playersGrid'), players, {
    canKick: role === 'host',
    onKick: kickPlayer
  });
  updatePlayerCount();
}

function kickPlayer(peerId) {
  connections[peerId]?.send({ type: MSG.KICK });
  setTimeout(() => connections[peerId]?.close(), 300);
  delete connections[peerId];
  playerRemove(peerId);
  renderAll();
  syncAll();
}

// ─── UI helpers ──────────────────────────────────────────────────────────────
const STATUS_LABELS = {
  connecting:   'Connexion…',
  waiting:      'En attente de joueurs',
  reconnecting: 'Reconnexion…',
  error:        'Erreur',
};

function setStatus(state, customLabel) {
  document.getElementById('statusText').textContent = customLabel || STATUS_LABELS[state] || state;
  document.getElementById('statusDot').className = `status-dot ${state}`;
}

function updatePlayerCount() {
  const n = players.length;
  document.getElementById('playerCount').textContent = `${n} joueur${n > 1 ? 's' : ''}`;
  const startBtn = document.getElementById('startBtn');
  if (startBtn) startBtn.disabled = n < 2;
  // Keep role max counts in sync whenever the player list changes
  if (role === 'host') renderRoles();
}

function buildShareUrl() {
  return window.location.href.replace(/room\.html.*$/, `join.html#${roomId}`);
}

function openShareModal() {
  document.getElementById('shareModal').classList.remove('hidden');
  generateQR(document.getElementById('shareQrCanvas'), buildShareUrl());
}

function closeShareModal() {
  document.getElementById('shareModal').classList.add('hidden');
}

async function leaveRoom() {
  clearTimeout(reconnectTimer);
  if (role === 'host') {
    for (const conn of Object.values(connections)) conn.send({ type: MSG.HOST_CLOSE });
    peer?.destroy();
  } else {
    hostConn?.close();
    peer?.destroy();
  }
  await dbDel('game_session');
  goHome();
}

function goHome() {
  window.location.href = 'index.html';
}

// ─── Settings (host only) ─────────────────────────────────────────────────────
function initSettings() {
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  bindCollapsible('rolesToggle',  'rolesContent',  'rolesToggleIcon');
  bindCollapsible('voiceToggle',  'voiceContent',  'voiceToggleIcon');

  renderRoles();
  initVoiceSection();
}

function bindCollapsible(toggleId, contentId, iconId) {
  document.getElementById(toggleId).addEventListener('click', () => {
    document.getElementById(contentId).classList.toggle('collapsed');
    document.getElementById(iconId).classList.toggle('rotated');
  });
}

function initVoiceSection() {
  const select      = document.getElementById('voiceSelect');
  const pitchRange  = document.getElementById('pitchRange');
  const rateRange   = document.getElementById('rateRange');
  const volumeRange = document.getElementById('volumeRange');
  const pitchValue  = document.getElementById('pitchValue');
  const rateValue   = document.getElementById('rateValue');
  const volumeValue = document.getElementById('volumeValue');
  const testInput   = document.getElementById('voiceTestInput');
  const testBtn     = document.getElementById('voiceTestBtn');

  // Populate voice list (may load asynchronously in Chromium)
  onVoicesReady((voices) => {
    const fr    = voices.filter(v => v.lang.startsWith('fr'));
    const other = voices.filter(v => !v.lang.startsWith('fr'));

    select.innerHTML = '<option value="">Voix par défaut</option>';

    [{ label: 'Français', list: fr }, { label: 'Autres', list: other }].forEach(({ label, list }) => {
      if (!list.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      list.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.voiceURI;
        opt.textContent = `${v.name} (${v.lang})`;
        group.appendChild(opt);
      });
      select.appendChild(group);
    });

    const saved = getVoiceConfig().voiceURI;
    if (saved) select.value = saved;
  });

  select.addEventListener('change', () => setVoiceConfig({ voiceURI: select.value || null }));

  function bindRange(el, labelEl, key) {
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      labelEl.textContent = v.toFixed(1);
      setVoiceConfig({ [key]: v });
    });
  }

  bindRange(pitchRange,  pitchValue,  'pitch');
  bindRange(rateRange,   rateValue,   'rate');
  bindRange(volumeRange, volumeValue, 'volume');

  testBtn.addEventListener('click', () => {
    const text = testInput.value.trim();
    if (text) say(text);
  });
  testInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') testBtn.click(); });
}

function openSettings()  { document.getElementById('settingsOverlay').classList.remove('hidden'); }
function closeSettings() { document.getElementById('settingsOverlay').classList.add('hidden'); }

// Max slots a role can occupy = total players − slots taken by other roles − 1 (villager reserve)
function getMaxCount(roleId) {
  const r = ROLES.find(r => r.id === roleId);
  const total = players.length;
  if (total === 0) return 1;
  const otherTotal = ROLES
    .filter(r => r.id !== roleId && r.countable && r.enabled)
    .reduce((sum, r) => sum + r.count, 0);
  const formulaMax = Math.max(1, total - otherTotal - 1);
  // Hard cap defined on the role takes priority when it's more restrictive
  return r?.max != null ? Math.min(r.max, formulaMax) : formulaMax;
}

// Remaining slots after all countable roles are assigned (= future villager count)
function getVillagerCount() {
  const total = players.length;
  const taken = ROLES.filter(r => r.countable && r.enabled).reduce((s, r) => s + r.count, 0);
  return Math.max(0, total - taken);
}

function toggleRole(id) {
  const r = ROLES.find(r => r.id === id);
  if (!r || r.locked) return;
  r.enabled = !r.enabled;
  if (r.enabled && r.countable) r.count = Math.min(r.count, getMaxCount(id));
  renderRoles();
  saveRoleSettings();
}

function changeRoleCount(id, delta) {
  const r = ROLES.find(r => r.id === id);
  if (!r || !r.countable || !r.enabled) return;
  const max = getMaxCount(id);
  r.count = Math.min(max, Math.max(1, r.count + delta));
  renderRoles();
  saveRoleSettings();
}

// Persist only the mutable parts (enabled + count) — the rest is in the ROLES definition.
function saveRoleSettings() {
  const state = ROLES.map(r => ({ id: r.id, enabled: r.enabled, count: r.count }));
  dbSet('role_settings', state);
}

async function loadRoleSettings() {
  const saved = await dbGet('role_settings');
  if (!saved) return;
  saved.forEach(({ id, enabled, count }) => {
    const r = ROLES.find(r => r.id === id);
    if (!r) return;
    if (!r.locked) r.enabled = enabled;
    if (r.countable && count != null) r.count = count;
  });
}

function renderRoles() {
  const list = document.getElementById('rolesGrid');
  list.innerHTML = '';

  ROLES.forEach((r) => {
    if (r.countable && r.enabled) r.count = Math.min(r.count, getMaxCount(r.id));

    const item = document.createElement('div');
    item.className = ['role-item', r.colorClass, r.locked ? 'locked' : '', !r.enabled ? 'disabled' : '']
      .filter(Boolean).join(' ');

    // Emoji
    const emoji = document.createElement('span');
    emoji.className = 'role-item-emoji';
    emoji.textContent = r.emoji;

    // Body: name + description
    const body = document.createElement('div');
    body.className = 'role-item-body';

    const header = document.createElement('div');
    header.className = 'role-item-header';

    const name = document.createElement('span');
    name.className = 'role-item-name';
    name.textContent = r.label;
    header.appendChild(name);

    if (r.locked) {
      const lock = document.createElement('span');
      lock.className = 'role-item-lock';
      lock.textContent = '🔒';
      header.appendChild(lock);
    }

    const desc = document.createElement('div');
    desc.className = 'role-item-desc';
    desc.textContent = r.desc;

    body.appendChild(header);
    body.appendChild(desc);

    // Right: counter or auto label
    const right = document.createElement('div');
    right.className = 'role-item-right';

    if (r.countable) {
      const max = r.enabled ? getMaxCount(r.id) : 1;

      const minusBtn = document.createElement('button');
      minusBtn.className = 'role-counter-btn';
      minusBtn.textContent = '−';
      minusBtn.disabled = !r.enabled || r.count <= 1;
      minusBtn.addEventListener('click', (e) => { e.stopPropagation(); changeRoleCount(r.id, -1); });

      const countEl = document.createElement('span');
      countEl.className = 'role-count-display';
      countEl.textContent = r.enabled ? r.count : '0';

      const plusBtn = document.createElement('button');
      plusBtn.className = 'role-counter-btn';
      plusBtn.textContent = '+';
      plusBtn.disabled = !r.enabled || r.count >= max;
      plusBtn.addEventListener('click', (e) => { e.stopPropagation(); changeRoleCount(r.id, +1); });

      right.appendChild(minusBtn);
      right.appendChild(countEl);
      right.appendChild(plusBtn);
    } else {
      const autoEl = document.createElement('span');
      autoEl.className = 'role-auto-label';
      autoEl.textContent = players.length > 0 ? `auto · ${getVillagerCount()}` : 'auto';
      right.appendChild(autoEl);
    }

    item.appendChild(emoji);
    item.appendChild(body);
    item.appendChild(right);

    if (!r.locked) item.addEventListener('click', () => toggleRole(r.id));

    list.appendChild(item);
  });
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
