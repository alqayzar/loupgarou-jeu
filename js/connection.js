// ─── Message type constants ──────────────────────────────────────────────────
const MSG = Object.freeze({
  JOIN:       'join',        // client → host: { username, image }
  SYNC:       'sync',        // host → all:   { players }  (full list, on every change)
  HOST_CLOSE: 'host_close',  // host → all:   room is closing
  KICK:       'kick',        // host → client: you have been removed
  GAME_START:    'game_start',    // host → client: { role }
  GAME_END:      'game_end',      // host → all:   game is over, back to waiting room
  PLAYER_STATE:  'player_state',  // host → client: { state } — état d'un joueur ('sleep', 'wake', …)
});

// ─── Connection state ────────────────────────────────────────────────────────
let peer           = null;  // PeerJS instance
let connections    = {};    // host only — { peerId: DataConnection }
let hostConn       = null;  // client only — DataConnection to host
let reconnectTimer = null;

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

  connections[conn.peer] = conn;

  if (gameActive) {
    // Reconnexion pendant la partie — renvoyer le rôle et mettre à jour la liste connectée
    const assignment = roleAssignments.find(a => a.id === conn.peer);
    if (assignment) {
      conn.send({ type: MSG.GAME_START, role: assignment.role });
      const player = crystallizedPlayers.find(p => p.id === conn.peer);
      if (player && !connectedInGame.find(p => p.id === conn.peer)) {
        connectedInGame.push(player);
        renderGameGrid();
        syncConnectedPlayers();
      }
    }
    return;
  }

  playerRemove(conn.peer);
  playerAdd(buildPlayer(conn.peer, resolveUsername(msg.username), msg.image, false));
  renderAll();
  syncAll();
}

function onClientDisconnect(peerId) {
  delete connections[peerId];

  if (gameActive) {
    onPlayerDisconnectedDuringGame(peerId);
    return;
  }

  playerRemove(peerId);
  renderAll();
  syncAll();
}

// Envoie la liste complète des joueurs à tous les clients connectés.
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
      if (gameActive) {
        connectedInGame = msg.players;
        renderGameGrid();
      } else {
        renderAll(msg.players);
        setStatus('waiting');
      }
      break;
    case MSG.GAME_START:
      onGameStart(msg);
      setStatus('En partie');
      break;
    case MSG.GAME_END:
      onGameEnd();
      setStatus('waiting');
      break;
    case MSG.PLAYER_STATE:
      applyState(msg.state);
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

// ─── Leave ───────────────────────────────────────────────────────────────────
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
