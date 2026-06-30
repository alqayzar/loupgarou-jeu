// ─── Role definitions ────────────────────────────────────────────────────────
// Two teams: 'wolf' and 'villager'. Sorcière, voyante, etc. are villager-type.
// locked:    can never be disabled
// countable: shows a +/− counter; count = number of players assigned this role
// Villageois is not countable — it always fills whatever slots remain
const ROLES = [
  {
    id: 'villageois', label: 'Villageois', emoji: '🌾', colorClass: 'role-teal', type: 'villager',
    locked: true, enabled: true, countable: false, count: null, max: null,
    desc: 'Les habitants du village. Leur seule arme est le vote pour éliminer les suspects chaque matin.',
  },
  {
    id: 'loupgarou', label: 'Loup Garou', emoji: '🐺', colorClass: 'role-orange', type: 'wolf',
    locked: true, enabled: true, countable: true, count: 1, max: null,
    desc: 'Chaque nuit, les loups choisissent une victime à dévorer. Ils se font passer pour des villageois.',
  },
  {
    id: 'sorciere', label: 'Sorcière', emoji: '🧙', colorClass: 'role-violet', type: 'villager',
    locked: false, enabled: true, countable: true, count: 1, max: 1,
    desc: 'Possède une potion de soin et une potion de poison, utilisables une seule fois chacune.',
  },
  {
    id: 'voyante', label: 'Voyante', emoji: '🔮', colorClass: 'role-blue', type: 'villager',
    locked: false, enabled: true, countable: true, count: 1, max: 1,
    desc: 'Chaque nuit, elle peut consulter l\'identité secrète d\'un joueur de son choix.',
  },
  {
    id: 'petite_fille', label: 'Petite Fille', emoji: '👧', colorClass: 'role-pink', type: 'villager',
    locked: false, enabled: false, countable: true, count: 1, max: null,
    maxFn: () => ROLES.find(r => r.id === 'loupgarou')?.count ?? 1,
    desc: 'Peut espionner les loups garous pendant leur phase de nuit, au risque d\'être démasquée.',
  },
  {
    id: 'cupidon', label: 'Cupidon', emoji: '💘', colorClass: 'role-red', type: 'villager',
    locked: false, enabled: false, countable: true, count: 1, max: 1,
    desc: 'La première nuit, Cupidon désigne deux liés. Si l\'un meurt, l\'autre meurt de chagrin.',
  },
  {
    id: 'renard', label: 'Renard', emoji: '🦊', colorClass: 'role-amber', type: 'villager',
    locked: false, enabled: false, countable: true, count: 1, max: 1,
    desc: 'Chaque nuit, flaire 3 joueurs. S\'il y a un loup parmi eux, il garde son pouvoir. Sinon, il ne sera plus réveillé.',
  },
  {
    id: 'ange', label: 'Ange', emoji: '👼', colorClass: 'role-lime', type: 'villager',
    locked: false, enabled: false, countable: true, count: 1, max: 1,
    desc: 'S\'il est éliminé lors du premier vote du village, l\'Ange remporte la partie seul.',
  },
  {
    id: 'chasseur', label: 'Chasseur', emoji: '🏹', colorClass: 'role-green', type: 'villager',
    locked: false, enabled: false, countable: true, count: 1, max: 1,
    desc: 'Lorsqu\'il meurt, il tire une dernière flèche et entraîne un joueur de son choix dans la mort.',
  },
  {
    id: 'salvateur', label: 'Salvateur', emoji: '🛡️', colorClass: 'role-cyan', type: 'villager',
    locked: false, enabled: false, countable: true, count: 1, max: 1,
    desc: 'Chaque nuit, protège un joueur de la mort des loups. Ne peut pas protéger la même personne deux nuits de suite. Peut se protéger lui-même.',
  },
  {
    id: 'avocat', label: 'Avocat', emoji: '⚖️', colorClass: 'role-indigo', type: 'villager',
    locked: false, enabled: false, countable: true, count: 1, max: 1,
    desc: 'Chaque nuit, immunise un joueur du vote du village. Ne peut pas choisir la même personne deux nuits de suite.',
  },
  {
    id: 'maire', label: 'Maire', emoji: '🎖️', colorClass: 'role-yellow', type: 'villager',
    locked: false, enabled: true, countable: false, count: null, max: null, assignable: false,
    desc: 'Élu par le village en début de partie via un vote. Sa voix compte double en cas d\'égalité.',
  },
];

let hostSpectator = false;

const scenarioSettings = {
  allowBlankVote:          false,
  voteTimeoutEnabled:      false,
  voteTimeoutSeconds:      120,
  announceWitchPotions:    true,
  witchKnowsDeaths:        true,
  foxSniffCount:           3,
  avocatRevote:            true,
};

// Nombre de joueurs effectivement jouables (exclut le host s'il est spectateur)
function playableCount() {
  return Math.max(0, players.length - (hostSpectator ? 1 : 0));
}

// Retourne le message d'erreur empêchant le lancement, ou null si la partie peut démarrer
function getStartError() {
  if (playableCount() < 3) return 'Il faut au moins 3 joueurs jouables';
  const wolves = ROLES.filter(r => r.type === 'wolf' && r.enabled).reduce((s, r) => s + r.count, 0);
  if (wolves >= getVillagersCount()) return 'Les loups sont trop nombreux par rapport aux villageois';
  return null;
}

// Camp des villageois = tous les joueurs jouables qui ne sont pas loups
function getVillagersCount() {
  const wolves = ROLES
    .filter(r => r.type === 'wolf' && r.enabled)
    .reduce((s, r) => s + r.count, 0);
  return Math.max(0, playableCount() - wolves);
}

// Slots plain villageois restants après attribution de tous les rôles nommés
function getPlainVillagerCount() {
  const taken = ROLES.filter(r => r.countable && r.enabled).reduce((s, r) => s + r.count, 0);
  return Math.max(0, playableCount() - taken);
}

// Max slots qu'un rôle peut occuper = total jouable − slots pris par les autres rôles − 1 (réserve villageois)
function getMaxCount(roleId) {
  const r = ROLES.find(r => r.id === roleId);
  const total = playableCount();
  if (total === 0) return 1;
  const otherTotal = ROLES
    .filter(r => r.id !== roleId && r.countable && r.enabled)
    .reduce((sum, r) => sum + r.count, 0);
  const formulaMax = Math.max(1, total - otherTotal - 1);
  const hardMax = r?.maxFn ? r.maxFn() : r?.max;
  return hardMax != null ? Math.min(hardMax, formulaMax) : formulaMax;
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

function saveRoleSettings() {
  const state = ROLES.map(r => ({ id: r.id, enabled: r.enabled, count: r.count }));
  dbSet('role_settings', { roles: state, hostSpectator, scenarioSettings: { ...scenarioSettings } });
}

async function loadRoleSettings() {
  const saved = await dbGet('role_settings');
  if (!saved) return;
  const roles = Array.isArray(saved) ? saved : saved.roles;  // compat ancien format
  roles?.forEach(({ id, enabled, count }) => {
    const r = ROLES.find(r => r.id === id);
    if (!r) return;
    if (!r.locked) r.enabled = enabled;
    if (r.countable && count != null) r.count = count;
  });
  if (saved.hostSpectator != null) hostSpectator = saved.hostSpectator;
  if (saved.scenarioSettings) Object.assign(scenarioSettings, saved.scenarioSettings);
}

function assignRoles(playerList) {
  const eligible = hostSpectator ? playerList.filter(p => !p.isHost) : playerList;
  const shuffled  = [...eligible].sort(() => Math.random() - 0.5);
  const result    = [];
  let idx = 0;

  for (const r of ROLES.filter(r => r.enabled && r.id !== 'villageois' && r.assignable !== false)) {
    const count = r.countable ? r.count : 1;
    for (let i = 0; i < count && idx < shuffled.length; i++, idx++) {
      result.push({ id: shuffled[idx].id, role: r.id });
    }
  }

  while (idx < shuffled.length) {
    result.push({ id: shuffled[idx++].id, role: 'villageois' });
  }

  // Host spectateur : toujours villageois mais marqué hors-jeu dans startGame
  if (hostSpectator) {
    const host = playerList.find(p => p.isHost);
    if (host) result.push({ id: host.id, role: 'villageois' });
  }

  return result;
}

function renderRoles() {
  const list = document.getElementById('rolesGrid');
  list.innerHTML = '';

  ROLES.forEach((r) => {
    if (r.countable && r.enabled) r.count = Math.min(r.count, getMaxCount(r.id));

    const item = document.createElement('div');
    item.className = ['role-item', r.colorClass, r.locked ? 'locked' : '', !r.enabled ? 'disabled' : '']
      .filter(Boolean).join(' ');

    const emoji = document.createElement('span');
    emoji.className = 'role-item-emoji';
    emoji.textContent = r.emoji;

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
    } else if (r.assignable === false) {
      const electedEl = document.createElement('span');
      electedEl.className = 'role-auto-label';
      electedEl.textContent = 'Élu';
      right.appendChild(electedEl);
    } else {
      const autoEl = document.createElement('span');
      autoEl.className = 'role-auto-label';
      autoEl.textContent = players.length > 0 ? `auto · ${getPlainVillagerCount()}` : 'auto';
      right.appendChild(autoEl);
    }

    item.appendChild(emoji);
    item.appendChild(body);
    item.appendChild(right);

    if (!r.locked) item.addEventListener('click', () => toggleRole(r.id));

    list.appendChild(item);
  });

  updateStartBtn();
}
