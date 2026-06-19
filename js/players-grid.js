/**
 * players-grid.js — reusable player grid renderer.
 *
 * Exposes two functions usable from any page:
 *
 *   createPlayerCard(player, options) → HTMLElement
 *   renderPlayersGrid(containerEl, players, options)
 *
 * options: {
 *   canKick: boolean          — show kick button on non-host cards
 *   onKick:  (peerId) => void — callback when kick is clicked
 * }
 */

function createPlayerCard(player, { canKick = false, onKick = null } = {}) {
  const card = document.createElement('div');
  card.id = `player-${player.id}`;
  card.className = `player-card ${player.colorClass}${player.dead != null ? ' player-dead' : ''}`;

  if (player.isHost) {
    const badge = document.createElement('div');
    badge.className = 'host-badge';
    badge.textContent = 'Host';
    card.appendChild(badge);
  }

  if (player.wantStartNight) {
    const nightBadge = document.createElement('div');
    nightBadge.className = 'night-badge';
    nightBadge.textContent = '🌙';
    card.appendChild(nightBadge);
  }

  if (player.dead != null) {
    const skull = document.createElement('div');
    skull.className = 'dead-skull';
    skull.textContent = '💀';
    card.appendChild(skull);
  }

  if (canKick && !player.isHost && onKick) {
    const kickBtn = document.createElement('button');
    kickBtn.className = 'kick-btn';
    kickBtn.textContent = '✕';
    kickBtn.title = `Exclure ${player.username}`;
    kickBtn.addEventListener('click', (e) => { e.stopPropagation(); onKick(player.id); });
    card.appendChild(kickBtn);
  }

  const avatar = document.createElement('div');
  avatar.className = 'player-avatar';
  const imgSrc = player.image ?? (typeof avatarCache !== 'undefined' ? avatarCache[player.id] : null);
  if (imgSrc) {
    const img = document.createElement('img');
    img.src = imgSrc;
    img.alt = player.username;
    avatar.appendChild(img);
  } else {
    avatar.textContent = '👤';
  }

  const name = document.createElement('div');
  name.className = 'player-name';
  name.textContent = player.username;

  card.appendChild(avatar);
  card.appendChild(name);
  return card;
}

function renderPlayersGrid(containerEl, players, options = {}) {
  containerEl.innerHTML = '';
  players.forEach((p) => containerEl.appendChild(createPlayerCard(p, options)));
}
