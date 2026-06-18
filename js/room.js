// Cycles through the CSS classes defined in theme.css
const COLOR_CLASSES = [
  'player-color-0', 'player-color-1', 'player-color-2', 'player-color-3',
  'player-color-4', 'player-color-5', 'player-color-6', 'player-color-7',
];

// ─── State ───────────────────────────────────────────────────────────────────
let role         = null;  // 'host' | 'client'
let roomId       = null;  // host's peer ID (= room code in URL hash)
let profile      = null;  // { username, image }
let players      = [];    // ordered list — host is authoritative, clients mirror it
let colorCounter = 0;     // host only — next colour index to assign

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

  // Game UI — wired for both host and client
  document.getElementById('showRoleBtn').addEventListener('click', showRoleModal);
  document.getElementById('closeRoleBtn').addEventListener('click', closeRoleModal);
  document.getElementById('roleModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeRoleModal();
  });

  if (role === 'host') {
    document.getElementById('hostControls').classList.remove('hidden');
    document.body.classList.add('has-host-controls');
    document.getElementById('startBtn').addEventListener('click', startGame);
    document.getElementById('endGameBtn').addEventListener('click', endGame);
    await loadRoleSettings();
    initSettings();

    if (session.gameActive) {
      await restoreGameStateHost(session);
    }

    initHost();
  } else {
    if (session.gameActive) {
      restoreGameStateClient(session);
    }
    initClient(session.myPeerId || undefined);
  }
});

// ─── Player list ─────────────────────────────────────────────────────────────

function buildPlayer(id, username, image, isHost) {
  const colorClass = COLOR_CLASSES[colorCounter % COLOR_CLASSES.length];
  colorCounter++;
  return { id, username, image: image || null, isHost, colorClass };
}

function playerAdd(player)  { players.push(player); }
function playerRemove(id)   { players = players.filter((p) => p.id !== id); }

function resolveUsername(username) {
  const names = players.map(p => p.username);
  if (!names.includes(username)) return username;
  let n = 2;
  while (names.includes(`${username} (${n})`)) n++;
  return `${username} (${n})`;
}

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
  if (role === 'host') renderRoles();
}

function updateStartBtn() {
  const startBtn = document.getElementById('startBtn');
  if (!startBtn) return;
  const error = getStartError();
  startBtn.disabled = !!error;
  startBtn.title = error || '';
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

  bindCollapsible('rolesToggle', 'rolesContent', 'rolesToggleIcon');
  bindCollapsible('voiceToggle', 'voiceContent', 'voiceToggleIcon');

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

function showToast(message) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
