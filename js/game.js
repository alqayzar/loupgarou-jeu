// ─── Game state ──────────────────────────────────────────────────────────────
let gameActive          = false;
let myState             = null;   // état courant du joueur local
let mySelection         = null;   // peerId de la carte sélectionnée par le joueur local
let myConfirmed         = false;  // true si le joueur local a confirmé sa sélection
let myAllowNone         = false;  // true si la sélection en cours autorise le vote blanc
let crystallizedPlayers = [];   // host: liste complète figée au lancement
let connectedInGame     = [];   // in-memory: joueurs actuellement connectés en jeu
let revealTeam          = null; // équipe mise en avant en mode récapitulatif ('loupgarou' | 'villageois' | null)
let revealAssignments   = [];   // assignments reçus via States.reveal
let revealPlayerIds     = null; // liste d'IDs spécifiques victorieux (State.reveal_players)

function getMyRole() {
  const myId = role === 'host' ? 'host' : peer?.id;
  return States.get('roles', []).find(a => a.id === myId)?.role || 'villageois';
}

// ─── Start game (host) ───────────────────────────────────────────────────────
async function startGame() {
  resetVars();
  await loadVars();
  crystallizedPlayers  = [...players];
  const assignments    = assignRoles(crystallizedPlayers);
  gameActive           = true;
  connectedInGame      = [...crystallizedPlayers];

  if (hostSpectator) {
    [connectedInGame, crystallizedPlayers].forEach(list => {
      const h = list.find(p => p.isHost);
      if (h) h.dead = 0;
    });
    applyState('dead');
  }

  await setVar('roles', assignments, States.GLOBAL);

  const session = await dbGet('game_session');
  await dbSet('game_session', { ...session, gameActive: true, crystallizedPlayers });

  for (const [, conn] of Object.entries(connections)) {
    conn.send({ type: MSG.GAME_START, players: _stripImages(connectedInGame) });
    _sendAvatars(conn, connectedInGame);
  }

  enterGameMode();
  await preGameFlow();
}

function updateRoundDisplay(r) {
  const el = document.getElementById('roundDisplay');
  if (el) el.textContent = r > 0 ? `Nuit ${r}` : '';
}

// ─── End game (host) ─────────────────────────────────────────────────────────
async function endGame() {
  gameActive = false;
  resetVars();
  for (const conn of Object.values(connections)) conn.send({ type: MSG.GAME_END });

  const session = await dbGet('game_session');
  const { gameActive: _a, crystallizedPlayers: _b, myState: _e, myStateExtra: _f, ...rest } = session;
  await dbSet('game_session', rest);

  players             = crystallizedPlayers.map(({ dead: _, wantStartNight: __, selectedBy: ___, ...p }) => p);
  gameActive          = false;
  crystallizedPlayers = [];
  connectedInGame     = [];
  revealTeam          = null;
  revealAssignments   = [];
  revealPlayerIds     = null;

  exitGameMode();
  renderAll();
  syncAll();
}

// ─── Game start received (guest) ─────────────────────────────────────────────
async function onGameStart(msg) {
  gameActive      = true;
  connectedInGame = msg.players ?? [...players];

  const session = await dbGet('game_session');
  await dbSet('game_session', { ...session, gameActive: true });

  const savedState = session?.myState || null;
  const savedExtra = session?.myStateExtra || {};
  enterGameMode();
  if (savedState) applyState(savedState, savedExtra);
}

// ─── Game end received (guest) ────────────────────────────────────────────────
async function onGameEnd() {
  resetVars();
  const session = await dbGet('game_session');
  const { gameActive: _a, myState: _c, myStateExtra: _d, ...rest } = session;
  await dbSet('game_session', rest);

  gameActive      = false;
  connectedInGame = [];
  exitGameMode();
}

// ─── Player disconnected during game (host) ──────────────────────────────────
function onPlayerDisconnectedDuringGame(peerId) {
  const player = crystallizedPlayers.find(p => p.id === peerId);
  const isDead  = connectedInGame.find(p => p.id === peerId)?.dead != null;
  connectedInGame = connectedInGame.filter(p => p.id !== peerId);
  renderGameGrid();
  syncConnectedPlayers();
  checkNightVote();
  if (!isDead) {
    showToast(`⚠ ${player?.username || 'Un joueur'} s'est déconnecté — la partie ne peut pas continuer`);
  }
}

// ─── Revive a player (host) — annule le meurtre de cette nuit ────────────────
function revivePlayer(peerId) {
  const inGame = connectedInGame.find(p => p.id === peerId);
  if (inGame) inGame.dead = null;
  const inPlayers = players.find(p => p.id === peerId);
  if (inPlayers) inPlayers.dead = null;
  setStateForPlayer(peerId, 'sleep', { revived: true });
  renderGameGrid();
  syncConnectedPlayers();
}

// ─── Kill a player (host) ────────────────────────────────────────────────────
function killPlayer(peerId) {
  const inGame = connectedInGame.find(p => p.id === peerId);
  const currentRound = States.get('round', 0);
  if (inGame) { inGame.dead = currentRound; inGame.wantStartNight = false; }
  const inPlayers = players.find(p => p.id === peerId);
  if (inPlayers) { inPlayers.dead = currentRound; inPlayers.wantStartNight = false; }
  setStateForPlayer(peerId, 'dead');
  renderGameGrid();
  syncConnectedPlayers();
}

// ─── Night vote ───────────────────────────────────────────────────────────────
function setPlayerWantNight(peerId, value) {
  const inGame = connectedInGame.find(p => p.id === peerId);
  if (inGame) inGame.wantStartNight = value;
  const inPlayers = players.find(p => p.id === peerId);
  if (inPlayers) inPlayers.wantStartNight = value;
  renderGameGrid();
  syncConnectedPlayers();
  checkNightVote();
}

function checkNightVote() {
  const alive = connectedInGame.filter(p => p.dead == null);
  if (alive.length === 0 || !alive.every(p => p.wantStartNight)) return;
  connectedInGame.forEach(p => { p.wantStartNight = false; });
  players.forEach(p => { p.wantStartNight = false; });
  renderGameGrid();
  updateNightBtn(false);
  syncConnectedPlayers();
  startNightFlow();
}

function updateNightBtn(active) {
  const btn = document.getElementById('startNightBtn');
  if (!btn) return;
  btn.classList.toggle('btn-ghost',   !active);
  btn.classList.toggle('btn-primary', active);
}

// ─── Sync connected players → all clients ────────────────────────────────────
function syncConnectedPlayers(isNight) {
  const msg = { type: MSG.SYNC, players: _stripImages(connectedInGame) };
  if (isNight !== undefined) msg.isNight = isNight;
  for (const conn of Object.values(connections)) conn.send(msg);
}

// ─── Night UI mode (hide/show night+role buttons) ─────────────────────────────
function setNightUIMode(active) {
  document.getElementById('startNightBtn').classList.toggle('hidden', active);
  document.getElementById('showRoleBtn').classList.toggle('hidden', active);
}

// ─── Countdown timer ──────────────────────────────────────────────────────────
let _countdownRaf = null;
let _countdownEnd = null;

function showCountdownTimer(ms) {
  hideCountdownTimer();
  _countdownEnd = Date.now() + ms;
  const el      = document.getElementById('countdownTimer');
  const display = document.getElementById('countdownDisplay');
  el.classList.remove('hidden');

  function tick() {
    const remaining = Math.max(0, _countdownEnd - Date.now());
    const m   = Math.floor(remaining / 60000);
    const s   = Math.floor((remaining % 60000) / 1000);
    const ms_ = remaining % 1000;
    display.textContent =
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + ':' +
      String(ms_).padStart(3, '0');
    if (remaining > 0) {
      _countdownRaf = requestAnimationFrame(tick);
    } else {
      hideCountdownTimer();
    }
  }
  _countdownRaf = requestAnimationFrame(tick);
}

function hideCountdownTimer() {
  if (_countdownRaf) { cancelAnimationFrame(_countdownRaf); _countdownRaf = null; }
  _countdownEnd = null;
  document.getElementById('countdownTimer')?.classList.add('hidden');
}

// ─── Restore on reload (host) ────────────────────────────────────────────────
async function restoreGameStateHost(session) {
  await loadVars();
  crystallizedPlayers = session.crystallizedPlayers || [];
  gameActive          = true;
  players             = [...crystallizedPlayers];
  connectedInGame     = crystallizedPlayers.filter(p => p.isHost);
  const hostPlayer    = crystallizedPlayers.find(p => p.isHost);
  if (hostPlayer?.dead != null) myState = 'dead';
  enterGameMode();
}

// ─── Restore on reload (guest) ───────────────────────────────────────────────
async function restoreGameStateClient(session) {
  await loadVars();
  myState         = session.myState || null;
  gameActive      = true;
  connectedInGame = [];
  enterGameMode();
  if (session.myState) applyState(session.myState, session.myStateExtra || {});
}

// ─── Enter game mode ─────────────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (!gameActive) return;
  e.preventDefault();
});

function enterGameMode() {
  document.getElementById('waitingView').style.display = 'none';
  document.getElementById('gameView').style.display = '';
  document.getElementById('gameControls').classList.remove('hidden');
  document.body.classList.add('has-game-controls');
  setNightUIMode(false);
  const nightBtn = document.getElementById('startNightBtn');
  nightBtn.disabled = (myState === 'dead');
  updateNightBtn(false);

  if (role === 'host') {
    document.getElementById('hostControls').classList.add('hidden');
    document.body.classList.remove('has-host-controls');
    document.getElementById('endGameBtn').classList.remove('hidden');
  }

  setStatus('playing');
  renderGameGrid();
}

// ─── Exit game mode ───────────────────────────────────────────────────────────
function exitGameMode() {
  cancelFlow();
  exitSleep();
  mySelection = null;
  myConfirmed = false;
  revealTeam        = null;
  revealAssignments = [];
  revealPlayerIds   = null;
  myState = null;
  setSelectionMode(false);
  setChoiceMode(false);
  document.getElementById('gameView').style.display = 'none';
  document.getElementById('gameControls').classList.add('hidden');
  document.body.classList.remove('has-game-controls');
  document.getElementById('startNightBtn').classList.add('hidden');
  document.getElementById('waitingView').style.display = '';

  setStatus('waiting');
  if (role === 'host') {
    document.getElementById('hostControls').classList.remove('hidden');
    document.body.classList.add('has-host-controls');
    document.getElementById('endGameBtn').classList.add('hidden');
  }
}

// ─── Selection mode ───────────────────────────────────────────────────────────
function handleCardSelect(targetId) {
  if (myState !== 'select') return;
  const myId = role === 'host' ? 'host' : peer?.id;
  if (States.get('select_disable_self') && targetId === myId) return;
  const newTarget = mySelection === targetId ? null : targetId;
  mySelection = newTarget;
  // setSelectionMode(newTarget !== null);
  if (role === 'host') {
    onSelectionReceived('host', newTarget);
  } else {
    hostConn.send({ type: MSG.SELECTION, targetId: newTarget });
  }
}

function onSelectionReceived(selectorId, targetId) {
  States.triggerEvent("selection", { selectorId, targetId });
  [connectedInGame, players].forEach(list => {
    list.forEach(p => {
      p.selectedBy = (p.selectedBy || []).filter(id => id !== selectorId);
    });
    if (targetId) {
      const p = list.find(p => p.id === targetId);
      if (p) p.selectedBy = [...(p.selectedBy || []), selectorId];
    }
  });
  renderGameGrid();
  syncConnectedPlayers();
}

function clearAllSelections() {
  [connectedInGame, players].forEach(list => list.forEach(p => { p.selectedBy = []; }));
  renderGameGrid();
  syncConnectedPlayers();
}

function setSelectionMode(active, label, buttonText, allowNone = false) {
  myAllowNone = active ? allowNone : false;
  document.getElementById('selectBtnWrapper').classList.toggle('hidden', !active);
  if (active) {
    document.getElementById('selectLabel').textContent = label || '';
    document.getElementById('selectBtn').textContent = buttonText || '✓ Sélectionner';
    updateSelectBtnStyle();
  }
}

function updateSelectBtnStyle() {
  const btn = document.getElementById('selectBtn');
  if (!btn) return;
  btn.classList.toggle('btn-ghost',     !myConfirmed);
  btn.classList.toggle('btn-primary',  myConfirmed);
}

function setChoiceMode(active, label, choices) {
  // document.getElementById('startNightBtn').classList.toggle('hidden', active);
  // document.getElementById('showRoleBtn').classList.toggle('hidden', active);
  document.getElementById('choiceWrapper').classList.toggle('hidden', !active);
  if (active) {
    document.getElementById('choiceLabel').textContent = label || '';
    const container = document.getElementById('choiceButtons');
    container.innerHTML = '';
    (choices || []).forEach((text, i) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.textContent = text;
      btn.addEventListener('click', () => onChoiceClick(i));
      container.appendChild(btn);
    });
  }
}

function onChoiceClick(choiceIndex) {
  setChoiceMode(false);
  if (role === 'host') {
    onChoiceReceived('host', choiceIndex);
  } else {
    hostConn.send({ type: MSG.CHOICE, choiceIndex });
  }
}

// ─── Reveal mode ─────────────────────────────────────────────────────────────
function applyReveal(team) {
  revealTeam        = team;
  revealAssignments = States.get('roles', []);
  revealPlayerIds   = null;
  renderGameGrid();
}

function applyRevealPlayers(playerIds) {
  revealPlayerIds   = playerIds;
  revealAssignments = States.get('roles', []);
  revealTeam        = null;
  renderGameGrid();
}

// ─── Render game grid ─────────────────────────────────────────────────────────
function renderGameGrid() {
  const myId          = role === 'host' ? 'host' : peer?.id;
  const isNight       = States.get('night', false);
  const nightKilledRound    = isNight ? States.get('round', 0) : null;
  const canSeeKilledTonight = getMyRole() === 'sorciere' && !States.get('sorciere_save_used');
  renderPlayersGrid(
    document.getElementById('gamePlayersGrid'),
    connectedInGame,
    { canKick: false, onSelect: handleCardSelect, myId, showSelectionBadges: myState === 'select', nightKilledRound, canSeeKilledTonight, revealTeam, revealAssignments, revealPlayerIds }
  );
  updateRoundDisplay(States.get('round', 0));
  const x = connectedInGame.length;
  if (role === 'host') {
    const y = crystallizedPlayers.length;
    document.getElementById('playerCount').textContent = `${x}/${y} joueur${y > 1 ? 's' : ''}`;
  } else {
    document.getElementById('playerCount').textContent = `${x} joueur${x > 1 ? 's' : ''}`;
  }
}

// ─── Player state system ─────────────────────────────────────────────────────

// Dispatcher central — ajouter un case ici pour chaque nouvel état
function applyState(state, extra = {}) {
  myState = (state === 'wake' || state === 'reset') ? null : state;
  if (gameActive) {
    dbGet('game_session').then(s => {
      if (s) dbSet('game_session', { ...s, myState, myStateExtra: extra });
    });
  }

  myConfirmed = false;
  mySelection = null;
  setSelectionMode(false);
  setChoiceMode(false);

  switch (state) {
    case 'wake':
      exitSleep();
      break;
    case 'sleep':
      if (extra.revived) document.getElementById('startNightBtn').disabled = false;
      closeRoleModal();
      enterSleep();
      break;
    case 'select':
      myConfirmed = false;
      exitSleep();
      setSelectionMode(true, extra.label, extra.buttonText, extra.allowNone);
      setNightUIMode(true);
      break;
    case 'choice':
      exitSleep();
      setChoiceMode(true, extra.label, extra.choices);
      break;
    case 'reset':
      myConfirmed = false;
      mySelection = null;
      setSelectionMode(false);
      setChoiceMode(false);
      exitSleep();
      break;
    case 'dead':
      document.getElementById('startNightBtn').disabled = true;
      break;
    default: exitSleep(); break;
  }
}

function enterSleep() {
  document.getElementById('sleepOverlay').style.display = 'flex';
  if (role === 'host') {
    document.getElementById('sleepWakeBtn').classList.remove('hidden');
  }
}

function exitSleep() {
  document.getElementById('sleepOverlay').style.display = 'none';
  document.getElementById('sleepWakeBtn').classList.add('hidden');
}

// Envoie un état à tous les joueurs (y compris le host lui-même)
function setStateForAll(state, extra = {}) {
  const msg = { type: MSG.PLAYER_STATE, state, ...extra };
  for (const conn of Object.values(connections)) conn.send(msg);
  applyState(state, extra);
}

// Envoie un état à un joueur précis (peerId = 'host' pour le host lui-même)
function setStateForPlayer(peerId, state, extra = {}) {
  if (peerId === 'host') {
    applyState(state, extra);
  } else {
    connections[peerId]?.send({ type: MSG.PLAYER_STATE, state, ...extra });
  }
}

// ─── Role modal ───────────────────────────────────────────────────────────────
function showRoleModal() {
  const r = ROLES.find(r => r.id === getMyRole());
  document.getElementById('roleRevealEmoji').textContent = r?.emoji || '?';
  document.getElementById('roleRevealName').textContent  = r?.label || '?';
  document.getElementById('roleRevealDesc').textContent  = r?.desc  || '';

  const coupleEl = document.getElementById('roleRevealCouple');
  const myId     = role === 'host' ? 'host' : peer?.id;
  const couple   = States.get('couple', []);
  const inCouple = couple.includes(myId);
  if (inCouple) {
    const partnerId = couple.find(id => id !== myId);
    const partner   = connectedInGame.find(p => p.id === partnerId);
    coupleEl.textContent = `💘 Lié à ${partner?.username || '???'}`;
    coupleEl.classList.remove('hidden');
  } else {
    coupleEl.classList.add('hidden');
  }

  document.getElementById('roleModal').classList.remove('hidden');
}

function closeRoleModal() {
  document.getElementById('roleModal').classList.add('hidden');
}
