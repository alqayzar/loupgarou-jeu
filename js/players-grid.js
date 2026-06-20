/**
 * players-grid.js — reusable player grid renderer.
 *
 * Exposes two functions usable from any page:
 *
 *   createPlayerCard(player, options) → HTMLElement
 *   renderPlayersGrid(containerEl, players, options)
 *
 * options: {
 *   canKick:  boolean          — show kick button on non-host cards
 *   onKick:   (peerId) => void — callback when kick is clicked
 *   onSelect: (peerId) => void — callback when a living card is clicked
 *   myId:     string           — local player's peerId (used for selection highlight)
 * }
 */

function createPlayerCard(player, { canKick = false, onKick = null, onSelect = null, myId = null, showSelectionBadges = false, nightKilledRound = null, canSeeKilledTonight = false, revealTeam = null, revealAssignments = [], onHostClick = null } = {}) {
  const killedTonight    = nightKilledRound != null && player.dead === nightKilledRound;
  const isDead           = player.dead != null && !killedTonight;
  const isSelected       = myId && (player.selectedBy || []).includes(myId);
  const revealAssignment = revealAssignments.find(a => a.id === player.id);
  const revealRoleData   = revealAssignment && typeof ROLES !== 'undefined' ? ROLES.find(r => r.id === revealAssignment.role) : null;
  const isRevealTeam     = revealAssignment && (
    revealTeam === 'loupgarou' ? revealAssignment.role === 'loupgarou' : revealAssignment.role !== 'loupgarou'
  );

  const card = document.createElement('div');
  card.id = `player-${player.id}`;
  card.className = [
    'player-card',
    player.colorClass,
    isDead                                    ? 'player-dead'           : '',
    killedTonight && canSeeKilledTonight      ? 'player-killed-tonight' : '',
    isSelected                                ? 'selected-by-me'        : '',
  ].filter(Boolean).join(' ');

  if (onSelect && !isDead) {
    card.classList.add('selectable');
    card.addEventListener('click', () => onSelect(player.id));
  }

  if (onHostClick && player.isHost) {
    card.classList.add('selectable');
    card.addEventListener('click', () => onHostClick(player.id));
  }

  // Wrapper pour positionner le badge rôle par-dessus l'avatar sans altérer overflow
  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'player-avatar-wrap';

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
  avatarWrap.appendChild(avatar);

  if (revealRoleData) {
    const roleBadge = document.createElement('div');
    roleBadge.className = 'reveal-role-badge';
    roleBadge.textContent = revealRoleData.emoji || '?';
    avatarWrap.appendChild(roleBadge);
  }

  const name = document.createElement('div');
  name.className = 'player-name';
  name.textContent = player.username;

  card.appendChild(avatarWrap);
  card.appendChild(name);

  // Badges positionnés par-dessus l'avatar
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

  if (isDead) {
    const skull = document.createElement('div');
    skull.className = 'dead-skull';
    skull.textContent = '💀';
    card.appendChild(skull);
  }

  if (killedTonight && canSeeKilledTonight && !States.get('night')) {
    const badge = document.createElement('div');
    badge.className = 'killed-tonight-badge';
    badge.textContent = '🩸';
    card.appendChild(badge);
  }

  if (isRevealTeam) {
    const crown = document.createElement('div');
    crown.className = 'reveal-crown';
    crown.textContent = '👑';
    card.appendChild(crown);
  }

  if (canKick && !player.isHost && onKick) {
    const kickBtn = document.createElement('button');
    kickBtn.className = 'kick-btn';
    kickBtn.textContent = '✕';
    kickBtn.title = `Exclure ${player.username}`;
    kickBtn.addEventListener('click', (e) => { e.stopPropagation(); onKick(player.id); });
    card.appendChild(kickBtn);
  }

  // Badges des joueurs ayant sélectionné cette carte
  const selectors = showSelectionBadges ? (player.selectedBy || []) : [];
  if (selectors.length) {
    const badges = document.createElement('div');
    badges.className = 'selection-badges';
    const MAX_VISIBLE = 5;
    const visible  = selectors.slice(0, MAX_VISIBLE);
    const overflow = selectors.length - MAX_VISIBLE;
    visible.forEach(selectorId => {
      const badge = document.createElement('div');
      badge.className = 'selection-badge';
      const inGame = typeof connectedInGame !== 'undefined'
        ? connectedInGame.find(p => p.id === selectorId)
        : null;
      const img = inGame?.image
        ?? (typeof avatarCache !== 'undefined' ? avatarCache[selectorId] : null);
      if (img) {
        const imgEl = document.createElement('img');
        imgEl.src = img;
        badge.appendChild(imgEl);
      } else {
        badge.textContent = '?';
      }
      badges.appendChild(badge);
    });
    if (overflow > 0) {
      const extra = document.createElement('div');
      extra.className = 'selection-badge selection-badge-overflow';
      extra.textContent = `+${overflow}`;
      badges.appendChild(extra);
    }
    card.appendChild(badges);
  }

  return card;
}

function renderPlayersGrid(containerEl, players, options = {}) {
  containerEl.innerHTML = '';
  players.forEach((p) => containerEl.appendChild(createPlayerCard(p, options)));
}
