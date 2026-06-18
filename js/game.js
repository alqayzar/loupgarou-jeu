// ─── Game state ──────────────────────────────────────────────────────────────
let gameActive          = false;
let myRole              = null;
let crystallizedPlayers = [];   // host: liste complète figée au lancement
let roleAssignments     = [];   // host: [{ id, role }]
let connectedInGame     = [];   // in-memory: joueurs actuellement connectés en jeu

// ─── Role assignment ─────────────────────────────────────────────────────────
function assignRoles(playerList) {
  const pool = [...playerList].sort(() => Math.random() - 0.5);
  const result = [];
  let i = 0;

  for (const r of ROLES) {
    if (!r.countable || !r.enabled) continue;
    for (let k = 0; k < r.count && i < pool.length; k++, i++) {
      result.push({ id: pool[i].id, role: r.id });
    }
  }

  while (i < pool.length) {
    result.push({ id: pool[i].id, role: 'villageois' });
    i++;
  }

  return result;
}

// ─── Start game (host) ───────────────────────────────────────────────────────
async function startGame() {
  crystallizedPlayers = [...players];
  roleAssignments     = assignRoles(crystallizedPlayers);
  myRole              = roleAssignments.find(a => a.id === 'host')?.role || 'villageois';
  gameActive          = true;
  connectedInGame     = [...crystallizedPlayers];

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
    conn.send({ type: MSG.GAME_START, role: a?.role || 'villageois' });
  }

  enterGameMode();
}

// ─── End game (host) ─────────────────────────────────────────────────────────
async function endGame() {
  for (const conn of Object.values(connections)) conn.send({ type: MSG.GAME_END });

  const session = await dbGet('game_session');
  const { gameActive: _a, crystallizedPlayers: _b, roleAssignments: _c, myRole: _d, ...rest } = session;
  await dbSet('game_session', rest);

  players             = [...crystallizedPlayers];
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
  connectedInGame = [...players];

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
  const player    = crystallizedPlayers.find(p => p.id === peerId);
  connectedInGame = connectedInGame.filter(p => p.id !== peerId);
  renderGameGrid();
  syncConnectedPlayers();
  showToast(`⚠ ${player?.username || 'Un joueur'} s'est déconnecté — la partie ne peut pas continuer`);
}

// ─── Sync connected players → all clients ────────────────────────────────────
function syncConnectedPlayers() {
  const msg = { type: MSG.SYNC, players: connectedInGame };
  for (const conn of Object.values(connections)) conn.send(msg);
}

// ─── Restore on reload (host) ────────────────────────────────────────────────
async function restoreGameStateHost(session) {
  crystallizedPlayers = session.crystallizedPlayers || [];
  roleAssignments     = session.roleAssignments     || [];
  myRole              = session.myRole              || null;
  gameActive          = true;
  players             = [...crystallizedPlayers];
  connectedInGame     = crystallizedPlayers.filter(p => p.isHost);
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

  if (role === 'host') {
    document.getElementById('hostControls').classList.add('hidden');
    document.body.classList.remove('has-host-controls');
    document.getElementById('endGameBtn').classList.remove('hidden');
  }

  renderGameGrid();
}

// ─── Exit game mode ───────────────────────────────────────────────────────────
function exitGameMode() {
  document.getElementById('gameView').style.display = 'none';
  document.getElementById('gameControls').classList.add('hidden');
  document.body.classList.remove('has-game-controls');
  document.getElementById('waitingView').style.display = '';

  if (role === 'host') {
    document.getElementById('hostControls').classList.remove('hidden');
    document.body.classList.add('has-host-controls');
    document.getElementById('endGameBtn').classList.add('hidden');
  }
}

// ─── Render game grid ─────────────────────────────────────────────────────────
function renderGameGrid() {
  renderPlayersGrid(
    document.getElementById('gamePlayersGrid'),
    connectedInGame,
    { canKick: false }
  );
  const x = connectedInGame.length;
  if (role === 'host') {
    const y = crystallizedPlayers.length;
    document.getElementById('playerCount').textContent = `${x}/${y} joueur${y > 1 ? 's' : ''}`;
  } else {
    document.getElementById('playerCount').textContent = `${x} joueur${x > 1 ? 's' : ''}`;
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
