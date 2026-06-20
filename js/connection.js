// ─── Message type constants ──────────────────────────────────────────────────
const MSG = Object.freeze({
  JOIN:       'join',        // client → host: { username, image }
  SYNC:       'sync',        // host → all:   { players }  (full list, on every change)
  HOST_CLOSE: 'host_close',  // host → all:   room is closing
  KICK:       'kick',        // host → client: you have been removed
  GAME_START:    'game_start',    // host → client: { role, players }
  GAME_END:      'game_end',      // host → all:   game is over, back to waiting room
  PLAYER_STATE:  'player_state',  // host → client: { state } — état d'un joueur ('sleep', 'wake', …)
  START_NIGHT:   'start_night',   // client → host: demande de lancer la nuit
  AVATARS:            'avatars',            // host → client: { avatars: { peerId: imageDataUrl } }
  SELECTION:          'selection',          // client → host: { targetId: peerId|null } — live badge update
  CONFIRM_SELECTION:  'confirm_selection',  // client → host: { targetId: peerId|null } — confirme la sélection
  CANCEL_SELECTION:   'cancel_selection',   // client → host: annule la confirmation
  CHOICE:             'choice',             // client → host: { choiceIndex } — réponse à un States.choice
  SET_VAR:            'set_var',            // host → clients: { key, value } — variable globale
});

// Retire les images des objets joueurs avant envoi réseau.
function _stripImages(playerList) {
  return playerList.map(({ image: _, ...p }) => p);
}

// Envoie les avatars d'une liste de joueurs à une connexion.
function _sendAvatars(conn, playerList) {
  const avatars = {};
  playerList.forEach(p => { if (p.image) avatars[p.id] = p.image; });
  if (Object.keys(avatars).length) conn.send({ type: MSG.AVATARS, avatars });
}

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
    if (profile.image) cacheAvatars({ host: profile.image });
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
  switch (msg.type) {
    case MSG.START_NIGHT:         setPlayerWantNight(conn.peer, msg.value); break;
    case MSG.SELECTION:           onSelectionReceived(conn.peer, msg.targetId); break;
    case MSG.CONFIRM_SELECTION:   onConfirmSelectionReceived(conn.peer, msg.targetId); break;
    case MSG.CANCEL_SELECTION:    onCancelSelectionReceived(conn.peer); break;
    case MSG.CHOICE:              onChoiceReceived(conn.peer, msg.choiceIndex); break;
    case MSG.JOIN:
      connections[conn.peer] = conn;
    
      if (gameActive) {
        // Reconnexion pendant la partie — renvoyer le rôle et mettre à jour la liste connectée
        const assignment = roleAssignments.find(a => a.id === conn.peer);
        if (assignment) {
          conn.send({ type: MSG.GAME_START, role: assignment.role, players: _stripImages(connectedInGame) });
          _sendAvatars(conn, connectedInGame);
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
      // Envoyer tous les avatars au nouveau client, et son avatar à tous les autres
      _sendAvatars(conn, players);
      if (msg.image) {
        for (const [pid, c] of Object.entries(connections)) {
          if (pid !== conn.peer) c.send({ type: MSG.AVATARS, avatars: { [conn.peer]: msg.image } });
        }
      }
      break;
    default: break;
  }
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

// Envoie la liste complète des joueurs à tous les clients connectés (sans images).
function syncAll() {
  const msg = { type: MSG.SYNC, players: _stripImages(players) };
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
    if (profile.image) cacheAvatars({ [id]: profile.image });
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
        const me = connectedInGame.find(p => p.id === peer?.id);
        if (me) updateNightBtn(me.wantStartNight ?? false);
        if (msg.round != null) { round = msg.round; updateRoundDisplay(round); saveRound(); }
        if (msg.isNight != null) setNightUIMode(msg.isNight);
      } else {
        renderAll(msg.players);
        setStatus('waiting');
      }
      break;
    case MSG.GAME_START:
      onGameStart(msg);
      break;
    case MSG.GAME_END:
      onGameEnd();
      setStatus('waiting');
      break;
    case MSG.AVATARS:
      cacheAvatars(msg.avatars);
      if (gameActive) renderGameGrid(); else renderAll();
      break;
    case MSG.PLAYER_STATE:
      applyState(msg.state, msg);
      break;
    case MSG.HOST_CLOSE:
      showToast('La room a été fermée');
      setTimeout(goHome, 2000);
      break;
    case MSG.KICK:
      showToast('Vous avez été exclu de la partie');
      setTimeout(async () => { await dbDel('game_session'); goHome(); }, 1800);
      break;
    case MSG.SET_VAR:
      _setVar(msg.key, msg.value);
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
