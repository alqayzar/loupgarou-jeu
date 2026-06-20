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
let avatarCache  = {};    // peerId → image data URL (persisté en IndexedDB)

function cacheAvatars(map) {
  Object.assign(avatarCache, map);
  dbSet('avatar_cache', avatarCache);
}

// ─── Initialisation ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  roomId = window.location.hash.slice(1);
  if (!roomId) { goHome(); return; }

  const session = await dbGet('game_session');
  profile = (await dbGet('user_profile')) || { username: 'Joueur', image: null };
  avatarCache = (await dbGet('avatar_cache')) || {};
  // Toujours avoir sa propre image en cache sous l'id 'host' ou l'id peer (ajouté au peer open)
  if (profile.image) avatarCache['__self__'] = profile.image;

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
  document.getElementById('hostProfileCloseBtn').addEventListener('click', closeHostProfileModal);
  document.getElementById('hostProfileModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeHostProfileModal();
  });
  document.getElementById('importHostSettingsBtn').addEventListener('click', () => {
    const btn = document.getElementById('importHostSettingsBtn');
    btn.disabled    = true;
    btn.textContent = 'Chargement…';
    hostConn.send({ type: MSG.REQUEST_SETTINGS });
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
  document.getElementById('sleepWakeBtn').addEventListener('click', () => setStateForAll('wake'));
  document.getElementById('selectBtn').addEventListener('click', () => {
    if (myConfirmed) {
      myConfirmed = false;
      updateSelectBtnStyle();
      if (role === 'host') {
        onCancelSelectionReceived('host');
      } else {
        hostConn.send({ type: MSG.CANCEL_SELECTION });
      }
    } else {
      if (!mySelection && !myAllowNone) return;
      myConfirmed = true;
      updateSelectBtnStyle();
      const targetId = mySelection ?? 'none';
      if (role === 'host') {
        onConfirmSelectionReceived('host', targetId);
      } else {
        hostConn.send({ type: MSG.CONFIRM_SELECTION, targetId });
      }
    }
  });
  document.getElementById('startNightBtn').addEventListener('click', () => {
    if (role === 'host') {
      const me = connectedInGame.find(p => p.id === 'host');
      const newValue = !(me?.wantStartNight ?? false);
      setPlayerWantNight('host', newValue);
      // Lire la valeur réelle après l'appel : checkNightVote a pu la remettre à false
      updateNightBtn(connectedInGame.find(p => p.id === 'host')?.wantStartNight ?? false);
    } else {
      const me = connectedInGame.find(p => p.id === peer?.id);
      const newValue = !(me?.wantStartNight ?? false);
      hostConn.send({ type: MSG.START_NIGHT, value: newValue });
      updateNightBtn(newValue);
    }
  });

  if (role === 'host') {
    document.getElementById('hostControls').classList.remove('hidden');
    document.body.classList.add('has-host-controls');
    document.getElementById('startBtn').addEventListener('click', startGame);
    document.getElementById('endGameBtn').addEventListener('click', endGame);
    await loadRoleSettings();
    await loadNarrationSettings();
    await loadVoiceConfig();
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
  return { id, username, image: image || null, isHost, colorClass, dead: null, wantStartNight: false, selectedBy: [] };
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
    canKick:     role === 'host',
    onKick:      kickPlayer,
    onHostClick: role === 'client' ? openHostProfileModal : null,
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
  playing:      'En partie',
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

// ─── Host profile modal (client only, wait room) ──────────────────────────────
function openHostProfileModal() {
  const btn = document.getElementById('importHostSettingsBtn');
  btn.disabled = false;
  btn.textContent = '⬇ Importer les paramètres de l\'hôte';
  document.getElementById('hostProfileModal').classList.remove('hidden');
}

function closeHostProfileModal() {
  document.getElementById('hostProfileModal').classList.add('hidden');
}

async function applyHostSettings(settings) {
  if (settings.narration) {
    Object.assign(narration, settings.narration);
    await dbSet('narration_settings', settings.narration);
  }
  if (settings.voiceConfig) {
    setVoiceConfig(settings.voiceConfig);
  }
  if (settings.roleSettings) {
    await dbSet('role_settings', settings.roleSettings);
  }
  showToast('Paramètres importés !');
  closeHostProfileModal();
}

function openShareModal() {
  document.getElementById('shareModal').classList.remove('hidden');
  generateQR(document.getElementById('shareQrCanvas'), buildShareUrl());
}

function closeShareModal() {
  document.getElementById('shareModal').classList.add('hidden');
}

async function goHome() {
  avatarCache = {};
  await Promise.all([
    dbDel('game_session'),
    dbDel('flow_vars'),
    dbDel('avatar_cache'),
  ]);
  window.location.href = 'index.html';
}

// ─── Settings (host only) ─────────────────────────────────────────────────────
function initSettings() {
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  bindCollapsible('rolesToggle',    'rolesContent',    'rolesToggleIcon');
  bindCollapsible('scenarioToggle', 'scenarioContent', 'scenarioToggleIcon');
  bindCollapsible('hostToggle',     'hostContent',     'hostToggleIcon');
  bindCollapsible('narrationToggle', 'narrationContent', 'narrationToggleIcon');
  bindCollapsible('voiceToggle',     'voiceContent',     'voiceToggleIcon');
  initNarrationSection();

  const allowBlankVoteCheck = document.getElementById('allowBlankVoteCheck');
  allowBlankVoteCheck.checked = scenarioSettings.allowBlankVote;
  allowBlankVoteCheck.addEventListener('change', () => {
    scenarioSettings.allowBlankVote = allowBlankVoteCheck.checked;
    saveRoleSettings();
  });

  const voteTimeoutCheck = document.getElementById('voteTimeoutCheck');
  const voteTimeoutField = document.getElementById('voteTimeoutField');
  const voteTimeoutInput = document.getElementById('voteTimeoutInput');

  function updateVoteTimeoutField() {
    voteTimeoutField.classList.toggle('hidden', !scenarioSettings.voteTimeoutEnabled);
  }

  voteTimeoutCheck.checked = scenarioSettings.voteTimeoutEnabled;
  voteTimeoutInput.value   = scenarioSettings.voteTimeoutSeconds;
  updateVoteTimeoutField();

  voteTimeoutCheck.addEventListener('change', () => {
    scenarioSettings.voteTimeoutEnabled = voteTimeoutCheck.checked;
    updateVoteTimeoutField();
    saveRoleSettings();
  });

  voteTimeoutInput.addEventListener('change', () => {
    const v = parseInt(voteTimeoutInput.value);
    if (!isNaN(v) && v >= 10) {
      scenarioSettings.voteTimeoutSeconds = v;
      saveRoleSettings();
    } else {
      voteTimeoutInput.value = scenarioSettings.voteTimeoutSeconds;
    }
  });

  const hostSpectatorCheck = document.getElementById('hostSpectatorCheck');
  hostSpectatorCheck.checked = hostSpectator;
  hostSpectatorCheck.addEventListener('change', () => {
    hostSpectator = hostSpectatorCheck.checked;
    saveRoleSettings();
    renderRoles();
    updateStartBtn();
  });

  renderRoles();
  initVoiceSection();
}

function initNarrationSection() {
  const container = document.getElementById('narrationFields');
  const syncFns   = new Map();

  // ── Zone d'import groupé ──────────────────────────────────────────────────
  const bulkZone  = document.createElement('div');
  bulkZone.className = 'narration-bulk-zone';

  const bulkInput = document.createElement('input');
  bulkInput.type     = 'file';
  bulkInput.multiple = true;
  bulkInput.accept   = 'audio/*,video/*';
  bulkInput.style.display = 'none';

  const bulkBtn = document.createElement('button');
  bulkBtn.className   = 'btn btn-ghost narration-bulk-btn';
  bulkBtn.textContent = '📂 Importer des fichiers';
  bulkBtn.title       = 'Nommer les fichiers comme les clés (ex : "Village - endormissement.mp3")';
  bulkBtn.addEventListener('click', () => bulkInput.click());

  const bulkStatus = document.createElement('span');
  bulkStatus.className = 'narration-bulk-status';

  bulkInput.addEventListener('change', async () => {
    const files = [...bulkInput.files];
    if (!files.length) return;
    bulkBtn.disabled     = true;
    bulkStatus.textContent = `Traitement de ${files.length} fichier(s)…`;

    let matched = 0, skipped = 0;
    for (const file of files) {
      const stem = file.name.replace(/\.[^/.]+$/, '');
      if (!(stem in NARRATION_DEFAULTS)) { skipped++; continue; }
      const dataURL = await new Promise(r => {
        const fr = new FileReader();
        fr.onload = e => r(e.target.result);
        fr.readAsDataURL(file);
      });
      const trimmed = await trimSilence(dataURL);
      narration[stem] = '#' + trimmed;
      syncFns.get(stem)?.();
      matched++;
    }

    await saveNarrationSettings();
    bulkStatus.textContent = `${matched} importé(s)${skipped ? `, ${skipped} ignoré(s)` : ''}`;
    bulkBtn.disabled = false;
    bulkInput.value  = '';
    setTimeout(() => { bulkStatus.textContent = ''; }, 4000);
  });

  bulkZone.appendChild(bulkBtn);
  bulkZone.appendChild(bulkInput);
  bulkZone.appendChild(bulkStatus);
  container.appendChild(bulkZone);

  // ── Champs individuels ────────────────────────────────────────────────────
  for (const [key, defaultText] of Object.entries(NARRATION_DEFAULTS)) {
    const field = document.createElement('div');
    field.className = 'settings-field';

    const header = document.createElement('div');
    header.className = 'settings-field-header';

    const labelWrap = document.createElement('span');
    labelWrap.className = 'narration-label-wrap';
    labelWrap.textContent = key;

    const vars = [...defaultText.matchAll(/\{(\w+)\}/g)].map(m => `{${m[1]}}`);
    if (vars.length) {
      const hint = document.createElement('span');
      hint.className = 'narration-vars';
      hint.textContent = ' ' + vars.join(' ');
      labelWrap.appendChild(hint);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.dataset.key = key;
    input.placeholder = defaultText;

    const playBtn = document.createElement('button');
    playBtn.className = 'btn btn-ghost narration-play-btn';
    playBtn.textContent = '▶';
    playBtn.title = 'Écouter';
    playBtn.addEventListener('click', async () => {
      if (playBtn.classList.contains('narration-playing')) return;
      playBtn.classList.add('narration-playing');
      try { await _say(narration[key] ?? defaultText); }
      finally { playBtn.classList.remove('narration-playing'); }
    });

    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'btn btn-ghost narration-upload-btn';
    uploadBtn.textContent = '🎵';
    uploadBtn.title = 'Uploader un audio';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,video/*';
    fileInput.style.display = 'none';

    function isAudio() { return (narration[key] ?? '').startsWith('#'); }

    function syncDisplay() {
      if (isAudio()) {
        input.value    = '#[audio]';
        input.readOnly = true;
        input.classList.add('narration-audio-set');
        uploadBtn.classList.add('narration-upload-active');
        uploadBtn.title = 'Supprimer l\'audio';
      } else {
        input.value    = narration[key] ?? defaultText;
        input.readOnly = false;
        input.classList.remove('narration-audio-set');
        uploadBtn.classList.remove('narration-upload-active');
        uploadBtn.title = 'Uploader un audio';
      }
    }

    syncFns.set(key, syncDisplay);
    syncDisplay();

    input.addEventListener('change', () => {
      if (isAudio()) return;
      narration[key] = input.value.trim() || defaultText;
      saveNarrationSettings();
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async e => {
        const trimmed = await trimSilence(e.target.result);
        narration[key] = '#' + trimmed;
        saveNarrationSettings();
        syncDisplay();
      };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });

    uploadBtn.addEventListener('click', () => {
      if (isAudio()) {
        narration[key] = defaultText;
        saveNarrationSettings();
        syncDisplay();
      } else {
        fileInput.click();
      }
    });

    const btnGroup = document.createElement('div');
    btnGroup.className = 'narration-btn-group';
    btnGroup.appendChild(playBtn);
    btnGroup.appendChild(uploadBtn);
    btnGroup.appendChild(fileInput);

    header.appendChild(labelWrap);
    header.appendChild(btnGroup);

    field.appendChild(header);
    field.appendChild(input);
    container.appendChild(field);
  }

  document.getElementById('narrationResetBtn').addEventListener('click', () => {
    resetNarrationSettings();
    for (const fn of syncFns.values()) fn();
  });
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
    const cfg = getVoiceConfig();
    if (cfg[key] != null) { el.value = cfg[key]; labelEl.textContent = cfg[key].toFixed(1); }
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
