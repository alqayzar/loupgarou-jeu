// ─── Game state ──────────────────────────────────────────────────────────────
let gameActive          = false;
let round               = 0;     // numéro de la nuit en cours (0 = partie non commencée)
let myState             = null;   // état courant du joueur local
let myRole              = null;
let mySelection         = null;  // peerId de la carte sélectionnée par le joueur local
let myConfirmed         = false; // true si le joueur local a confirmé sa sélection
let crystallizedPlayers = [];   // host: liste complète figée au lancement
let roleAssignments     = [];   // host: [{ id, role }]
let connectedInGame     = [];   // in-memory: joueurs actuellement connectés en jeu

// ─── Start game (host) ───────────────────────────────────────────────────────
async function startGame() {
  crystallizedPlayers = [...players];
  roleAssignments     = assignRoles(crystallizedPlayers);
  myRole              = roleAssignments.find(a => a.id === 'host')?.role || 'villageois';
  gameActive          = true;
  connectedInGame     = [...crystallizedPlayers];

  if (hostSpectator) {
    [connectedInGame, crystallizedPlayers].forEach(list => {
      const h = list.find(p => p.isHost);
      if (h) h.dead = 0;
    });
    applyState('dead');
  }

  const session = await dbGet('game_session');
  await dbSet('game_session', {
    ...session,
    gameActive: true,
    crystallizedPlayers,
    roleAssignments,
    myRole,
  });

  for (const [peerId, conn] of Object.entries(connections)) {
    const a = roleAssignments.find(a => a.id === peerId);
    conn.send({ type: MSG.GAME_START, role: a?.role || 'villageois', players: _stripImages(connectedInGame) });
    _sendAvatars(conn, connectedInGame);
  }

  enterGameMode();
}

function updateRoundDisplay(r) {
  const el = document.getElementById('roundDisplay');
  if (el) el.textContent = r > 0 ? `Nuit ${r}` : '';
}

async function startNightFlow() {
  round++;
  updateRoundDisplay(round);
  setNightUIMode(true);
  syncConnectedPlayers(true);

  let all_confirmed = false;

  await runFlow([
    // States.wait(5),
    States.say("Veuillez séléctionner"),
    States.label("redo selection"),
    States.select(null),
    States.on("confirm_selection_all", (targets) => {
      all_confirmed = targets.length > 0 && targets.every(t => t === targets[0]);
    }),
    States.reset(),
    States.jumpif("redo selection", () => !all_confirmed),
    States.say("On continue maintenant."),
    States.wait(10000000),
    States.say('La nuit tombe sur le village…'),
    States.sleep(),
    States.wait(2),
    States.wake('loupgarou'),
    States.say('Loups Garous, ouvrez les yeux.'),
    States.wait(4),
    States.run(() => {
      const victims = connectedInGame.filter(p => {
        const a = roleAssignments.find(a => a.id === p.id);
        return p.dead == null && a?.role !== 'loupgarou';
      });
      if (victims.length === 0) return [];
      const victim = victims[Math.floor(Math.random() * victims.length)];
      return [States.kill(victim.id)];
    }),
    States.say('Loups Garous, fermez les yeux.'),
    States.sleep(),
    States.wait(1),

    States.jumpif('apres_sorciere', () => !roleAssignments.some(a => a.role === 'sorciere')),
    States.wake('sorciere'),
    States.say('Sorcière, ouvrez les yeux.'),
    States.wait(4),
    States.say('Sorcière, fermez les yeux.'),
    States.sleep(),
    States.wait(1),
    States.label('apres_sorciere'),

    States.say('Le jour se lève.'),
    States.wake(null),
    States.run(() => {
      const morts = connectedInGame.filter(p => p.dead === round);
      if (morts.length === 0) return [States.say('Cette nuit, personne n\'est mort.')];
      return morts.map(p => States.say(`${p.username} est mort.`));
    }),
  ]);
  setNightUIMode(false);
  syncConnectedPlayers(false);
}

// ─── End game (host) ─────────────────────────────────────────────────────────
async function endGame() {
  for (const conn of Object.values(connections)) conn.send({ type: MSG.GAME_END });

  const session = await dbGet('game_session');
  const { gameActive: _a, crystallizedPlayers: _b, roleAssignments: _c, myRole: _d, ...rest } = session;
  await dbSet('game_session', rest);

  players             = crystallizedPlayers.map(({ dead: _, wantStartNight: __, selectedBy: ___, ...p }) => p);
  gameActive          = false;
  myRole              = null;
  crystallizedPlayers = [];
  roleAssignments     = [];
  connectedInGame     = [];

  exitGameMode();
  renderAll();
  syncAll();
}

// ─── Game start received (guest) ─────────────────────────────────────────────
async function onGameStart(msg) {
  myRole          = msg.role;
  gameActive      = true;
  connectedInGame = msg.players ?? [...players];

  const session = await dbGet('game_session');
  await dbSet('game_session', { ...session, gameActive: true, myRole });

  enterGameMode();
}

// ─── Game end received (guest) ────────────────────────────────────────────────
async function onGameEnd() {
  const session = await dbGet('game_session');
  const { gameActive: _a, myRole: _b, ...rest } = session;
  await dbSet('game_session', rest);

  gameActive      = false;
  myRole          = null;
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

// ─── Kill a player (host) ────────────────────────────────────────────────────
function killPlayer(peerId) {
  const inGame = connectedInGame.find(p => p.id === peerId);
  if (inGame) { inGame.dead = round; inGame.wantStartNight = false; }
  const inPlayers = players.find(p => p.id === peerId);
  if (inPlayers) { inPlayers.dead = round; inPlayers.wantStartNight = false; }
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
  const msg = { type: MSG.SYNC, players: _stripImages(connectedInGame), round };
  if (isNight !== undefined) msg.isNight = isNight;
  for (const conn of Object.values(connections)) conn.send(msg);
}

// ─── Night UI mode (hide/show night+role buttons) ─────────────────────────────
function setNightUIMode(active) {
  document.getElementById('startNightBtn').classList.toggle('hidden', active);
  document.getElementById('showRoleBtn').classList.toggle('hidden', active);
}

// ─── Restore on reload (host) ────────────────────────────────────────────────
async function restoreGameStateHost(session) {
  crystallizedPlayers = session.crystallizedPlayers || [];
  roleAssignments     = session.roleAssignments     || [];
  myRole              = session.myRole              || null;
  gameActive          = true;
  players             = [...crystallizedPlayers];
  connectedInGame     = crystallizedPlayers.filter(p => p.isHost);
  const hostPlayer    = crystallizedPlayers.find(p => p.isHost);
  if (hostPlayer?.dead != null) myState = 'dead';
  enterGameMode();
}

// ─── Restore on reload (guest) ───────────────────────────────────────────────
function restoreGameStateClient(session) {
  myRole          = session.myRole || null;
  gameActive      = true;
  connectedInGame = [];
  enterGameMode();
}

// ─── Enter game mode ─────────────────────────────────────────────────────────
function enterGameMode() {
  document.getElementById('waitingView').style.display = 'none';
  document.getElementById('gameView').style.display = '';
  document.getElementById('gameControls').classList.remove('hidden');
  document.body.classList.add('has-game-controls');
  setNightUIMode(false);
  const nightBtn = document.getElementById('startNightBtn');
  nightBtn.disabled = (myState === 'dead');
  updateNightBtn(false);
  updateRoundDisplay(round);

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
  round = 0;
  mySelection = null;
  myConfirmed = false;
  setSelectionMode(false);
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

function setSelectionMode(active) {
  document.getElementById('startNightBtn').classList.toggle('hidden', active);
  document.getElementById('showRoleBtn').classList.toggle('hidden', active);
  document.getElementById('selectBtn').classList.toggle('hidden', !active);
  if (active) updateSelectBtnStyle();
}

function updateSelectBtnStyle() {
  const btn = document.getElementById('selectBtn');
  if (!btn) return;
  btn.classList.toggle('btn-ghost',     !myConfirmed);
  btn.classList.toggle('btn-confirmed',  myConfirmed);
}

// ─── Render game grid ─────────────────────────────────────────────────────────
function renderGameGrid() {
  const myId = role === 'host' ? 'host' : peer?.id;
  renderPlayersGrid(
    document.getElementById('gamePlayersGrid'),
    connectedInGame,
    { canKick: false, onSelect: handleCardSelect, myId }
  );
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
function applyState(state) {
  myState = (state === 'wake' || state === 'reset') ? null : state;
  switch (state) {
    case 'sleep':
      enterSleep();
      break;
    case 'select':
      myConfirmed = false;
      exitSleep();
      setSelectionMode(true);
      break;
    case 'reset':
      myConfirmed = false;
      mySelection = null;
      setSelectionMode(false);
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
function setStateForAll(state) {
  const msg = { type: MSG.PLAYER_STATE, state };
  for (const conn of Object.values(connections)) conn.send(msg);
  applyState(state);
}

// Envoie un état à un joueur précis (peerId = 'host' pour le host lui-même)
function setStateForPlayer(peerId, state) {
  if (peerId === 'host') {
    applyState(state);
  } else {
    connections[peerId]?.send({ type: MSG.PLAYER_STATE, state });
  }
}

// ─── Role modal ───────────────────────────────────────────────────────────────
function showRoleModal() {
  const r = ROLES.find(r => r.id === myRole);
  document.getElementById('roleRevealEmoji').textContent = r?.emoji || '?';
  document.getElementById('roleRevealName').textContent  = r?.label || '?';
  document.getElementById('roleRevealDesc').textContent  = r?.desc  || '';
  document.getElementById('roleModal').classList.remove('hidden');
}

function closeRoleModal() {
  document.getElementById('roleModal').classList.add('hidden');
}
