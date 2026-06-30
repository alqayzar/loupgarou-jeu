// ─── Flow helpers ────────────────────────────────────────────────────────────

// Retourne le peerId majoritaire (> 50 % des votes) ou null si aucune majorité.
function getMajority(peerIds) {
  const counts = {};
  for (const id of peerIds) counts[id] = (counts[id] ?? 0) + 1;
  const half = peerIds.length / 2;
  for (const [id, count] of Object.entries(counts)) {
    if (count > half) return id;
  }
  return null;
}

// Retourne le peerId ayant reçu le plus de votes.
// En cas d'égalité parfaite entre les premiers, retourne null.
function getMostVoted(peerIds) {
  if (!peerIds.length) return null;
  const counts = {};
  for (const id of peerIds) counts[id] = (counts[id] ?? 0) + 1;
  const max = Math.max(...Object.values(counts));
  const leaders = Object.keys(counts).filter(id => counts[id] === max);
  return leaders.length === 1 ? leaders[0] : null;
}

// Retourne true si au moins un joueur vivant (ou tué cette nuit) possède ce rôle.
// Un joueur tué cette nuit (dead === round) est encore considéré vivant pendant la nuit.
function isRolePresent(role) {
  return States.get('roles', []).some(a =>
    a.role === role &&
    connectedInGame.some(p => p.id === a.id && (p.dead == null || p.dead === (States.get('round', 0))))
  );
}

// Retourne les joueurs tués durant ce round.
function getRoundDeaths() {
  return connectedInGame.filter(p => p.dead === (States.get('round', 0)));
}

// ─── Night flow ───────────────────────────────────────────────────────────────
function wolfFlow() {
  return [
    States.label("begin_wolf_vote"),
    // States.wake('loupgarou'),
    States.say(narrate("Loups garous - réveil")),
    States.select('loupgarou', 'Selectionner une victime !', '🐺 Désigner'),
    States.on('confirm_selection_all', (targets) => {
      const victim = getMostVoted(Object.values(targets));
      if (!victim) return [States.jump("begin_wolf_vote")];
      const protectedId = States.get('salvateur_protected');
      return victim === protectedId ? [] : [States.kill(victim)];
    }),
    States.say(narrate("Loups garous - sommeil")),
    States.sleep(),
  ];
}

function avocatFlow() {
  return [
    States.say(narrate("Avocat - réveil")),
    States.label('avocat_pick'),
    States.select('avocat', 'Choisissez un joueur à immuniser du vote.', '⚖️ Défendre'),
    States.on('confirm_selection_all', (targets) => {
      const chosen = Object.values(targets)[0];
      if (chosen === States.get('avocat_protected')) {
        return [
          States.say(narrate('Avocat - même joueur')),
          States.jump('avocat_pick'),
        ];
      }
      return [States.set('avocat_protected', chosen, States.LOCAL)];
    }),
    States.say(narrate("Avocat - sommeil")),
    States.sleep(),
  ];
}

function salvateurFlow() {
  return [
    States.say(narrate("Salvateur - réveil")),
    States.label('salvateur_pick'),
    States.select('salvateur', 'Choisissez un joueur à protéger.', '🛡️ Protéger'),
    States.on('confirm_selection_all', (targets) => {
      const chosen = Object.values(targets)[0];
      if (chosen === States.get('salvateur_protected')) {
        return [
          States.say(narrate('Salvateur - même joueur')),
          States.jump('salvateur_pick'),
        ];
      }
      return [States.set('salvateur_protected', chosen, States.LOCAL)];
    }),
    States.say(narrate("Salvateur - sommeil")),
    States.sleep(),
  ];
}

function witchFlow() {
  return [
    // States.wake('sorciere'),
    States.say(narrate("Sorcière - réveil")),
    States.run(() => {
      const deaths = getRoundDeaths();
      if (deaths.length === 0 || States.get('sorciere_save_used')) return [];
      const announce = scenarioSettings.announceWitchPotions ? [States.say(narrate("Sorcière - proposition sauvetage"))] : [];
      if (scenarioSettings.witchKnowsDeaths) {
        const choices = [...deaths.map(p => `💊 ${p.username}`), '❌ Aucun'];
        return [
          ...announce,
          States.choice('sorciere', 'Souhaitez-vous utiliser votre potion de vie ?', choices),
          States.on('choice', ({ choiceIndex }) => {
            if (choiceIndex === choices.length - 1) return [States.refresh()];
            return [
              States.set('sorciere_save_used', true, States.GLOBAL),
              States.revive(deaths[choiceIndex].id),
            ];
          }),
        ];
      } else {
        return [
          ...announce,
          States.choice('sorciere', 'Souhaitez-vous utiliser votre potion de vie ?', ['💊 Utiliser', '❌ Ne pas utiliser']),
          States.on('choice', ({ choiceIndex }) => {
            if (choiceIndex !== 0) return [States.refresh()];
            const saved = deaths[Math.floor(Math.random() * deaths.length)];
            return [
              States.set('sorciere_save_used', true, States.GLOBAL),
              States.revive(saved.id),
            ];
          }),
        ];
      }
    }),
    States.run(() => {
      if (States.get('sorciere_poison_used')) return [];
      return [
        ...(scenarioSettings.announceWitchPotions ? [States.say(narrate("Sorcière - proposition poison"))] : []),
        States.choice('sorciere', 'Voulez vous utiliser votre poison ?', ['☠️ Empoisonner', 'Non']),
        States.on('choice', ({ choiceIndex }) => choiceIndex !== 0 ? [] : [
          States.select('sorciere', 'Choisissez votre victime.', '☠️ Empoisonner'),
          States.on('confirm_selection_all', (targets) => [
            States.set('sorciere_poison_used', true, States.GLOBAL),
            States.kill(Object.values(targets)[0]),
          ]),
        ]),
      ];
    }),
    States.say(narrate("Sorcière - sommeil")),
    States.sleep(),
  ];
}

function seerFlow() {
  return [
    States.wake('voyante'),
    States.say(narrate("Voyante - réveil")),
    States.select('voyante', 'Choisissez un joueur à observer.', '🔮 Observer'),
    States.on('confirm_selection_all', (targets) => {
      const assignment = States.get('roles', []).find(a => a.id === Object.values(targets)[0]);
      const role = assignment?.role || 'inconnu';
      return [
        States.choice('voyante', `Ce joueur est : ${role}`, ['OK']),
        States.on('choice', () => []),
      ];
    }),
    States.say(narrate("Voyante - sommeil")),
    States.sleep(),
  ];
}

function _formatVoteDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `Vous avez ${s} seconde${s > 1 ? 's' : ''} pour voter.`;
  if (s === 0) return `Vous avez ${m} minute${m > 1 ? 's' : ''} pour voter.`;
  return `Vous avez ${m} minute${m > 1 ? 's' : ''} et ${s} seconde${s > 1 ? 's' : ''} pour voter.`;
}

function mayorVoteFlow() {
  return [
    States.say(narrate('Vote - maire')),
    States.label('begin_mayor_vote'),
    States.set('select_disable_self', true, States.GLOBAL),
    States.select('alive', 'Votez pour élire le maire.', '🎖️ Élire'),
    States.on('confirm_selection_all', (targets) => {
      const mayor = getMostVoted(Object.values(targets));
      if (!mayor) return [
        States.reset(),
        States.say(narrate('Vote - maire égalité')),
        States.jump('begin_mayor_vote'),
      ];
      const player = connectedInGame.find(p => p.id === mayor);
      return [
        States.reset(),
        States.say(narrate(`Joueur - ${player?.username || 'Un joueur'}`)),
        States.say(narrate('Vote - maire élu')),
        States.set('maire', mayor, States.GLOBAL),
        States.refresh(),
      ];
    }),
    States.set('select_disable_self', false, States.GLOBAL),
  ];
}

function villageVoteFlow() {
  return [
    States.say(narrate('Vote - ouverture')),
    States.run(() => scenarioSettings.voteTimeoutEnabled
      ? [States.say(narrate('Vote - avertissement timeout'))]
      : []),

    States.label('begin_village_vote'),

    States.select('alive', 'Votez pour éliminer un suspect.', '🗳️ Voter', scenarioSettings.allowBlankVote),

    States.run(() => scenarioSettings.voteTimeoutEnabled
      ? [States.timeout('village_vote', scenarioSettings.voteTimeoutSeconds * 1000, States.GLOBAL)]
      : []),

    States.many_on({
      'timeout:village_vote': () => [
        States.reset(),
        States.say(narrate('Vote - temps écoulé')),
      ],
      'confirm_selection_all': (targets) => {
        const maire = States.get('maire');
        const votes = Object.entries(targets).flatMap(([sid, tid]) => maire && sid === maire ? [tid, tid] : [tid]);
        const victim = getMostVoted(votes);
        if (!victim) return [
          States.clearTimeout('village_vote'),
          States.reset(),
          States.say(narrate('Vote - pas de majorité')),
          States.jump('begin_village_vote'),
        ];
        if (victim === 'none') return [
          States.clearTimeout('village_vote'),
          States.reset(),
          States.say(narrate('Vote - vote blanc')),
        ];
        if (victim === States.get('avocat_protected')) return [
          States.clearTimeout('village_vote'),
          States.reset(),
          States.say(narrate('Avocat - joueur sauvé')),
          ...(scenarioSettings.avocatRevote ? [States.jump('begin_village_vote')] : []),
        ];
        const player     = connectedInGame.find(p => p.id === victim);
        const assignment = States.get('roles', []).find(a => a.id === victim);
        const role       = assignment?.role || 'inconnu';
        return [
          States.clearTimeout('village_vote'),
          States.reset(),
          States.say(narrate(`Joueur - ${player?.username || 'Un joueur'}`)),
          States.say(narrate('Vote - élimination')),
          States.say(narrate(`Annonce rôle - ${role}`)),
          angelWinFlow(victim),
          States.kill(victim),
          coupleDieFlow(victim),
          hunterFlow(victim),
          ...(victim === States.get('maire') ? mayorSuccessionFlow(victim) : []),
        ];
      },
    }),
  ];
}

function checkWinFlow() {
  return [
    States.run(() => {
      const alive  = connectedInGame.filter(p => p.dead == null);
      const roles  = States.get('roles', []);
      const couple = States.get('couple', []);

      // Couple win — doit être vérifié avant la victoire des loups
      if (
        couple.length === 2 &&
        alive.length === 2 &&
        couple.every(id => alive.some(p => p.id === id))
      ) {
        gameActive = false;
        return [
          States.say(narrate('Victoire couple')),
          States.reveal('villageois'),
          States.jump('exit'),
        ];
      }

      const wolves    = alive.filter(p => roles.some(a => a.id === p.id && a.role === 'loupgarou'));
      const villagers = alive.filter(p => !roles.some(a => a.id === p.id && a.role === 'loupgarou'));

      if (wolves.length === 0) {
        gameActive = false;
        return [
          States.say(narrate('Victoire villageois')),
          States.reveal('villageois'),
          States.jump('exit'),
        ];
      }
      if (wolves.length >= villagers.length) {
        gameActive = false;
        return [
          States.say(narrate('Victoire loups garous')),
          States.reveal('loupgarou'),
          States.jump('exit'),
        ];
      }
      return [];
    }),
  ];
}

function mayorSuccessionFlow(mayorId) {
  return [
    States.say(narrate('Maire - mort successeur')),
    States.select_player(mayorId, 'Désignez votre successeur.', '🎖️ Désigner'),
    States.on('confirm_selection_all', (targets) => {
      const successor = Object.values(targets)[0];
      const player = connectedInGame.find(p => p.id === successor);
      return [
        States.reset(),
        States.say(narrate(`Joueur - ${player?.username || 'Un joueur'}`)),
        States.say(narrate('Vote - maire élu')),
        States.set('maire', successor, States.GLOBAL),
        States.refresh(),
      ];
    }),
  ];
}

function angelWinFlow(victimId) {
  return States.run(() => {
    const isAngel = States.get('roles', []).some(a => a.id === victimId && a.role === 'ange');
    if (!isAngel || States.get('round', 0) !== 1) return [];
    gameActive = false;
    return [
      States.say(narrate('Victoire ange')),
      States.reveal_players([victimId]),
      States.jump('exit'),
    ];
  });
}

function hunterFlow(hunterId) {
  return States.run(() => {
    const isHunter = States.get('roles', []).some(a => a.id === hunterId && a.role === 'chasseur');
    if (!isHunter) return [];
    return [
      States.say(narrate('Chasseur - pouvoir')),
      States.select_player(hunterId, 'Désignez un joueur à emporter avec vous.', '🏹 Viser'),
      States.on('confirm_selection_all', (targets) => {
        const victim = Object.values(targets)[0];
        const player = connectedInGame.find(p => p.id === victim);
        const role   = States.get('roles', []).find(a => a.id === victim)?.role || 'inconnu';
        return [
          States.reset(),
          States.say(narrate(`Joueur - ${player?.username || 'Un joueur'}`)),
          States.say(narrate('Chasseur - tir')),
          States.say(narrate(`Annonce rôle - ${role}`)),
          States.kill(victim),
          ...coupleDieFlow(victim),
        ];
      }),
    ];
  });
}

function coupleDieFlow(victimId) {
  return [
    States.run(() => {
      const couple = States.get('couple', []);
      if (!couple.includes(victimId)) return [];
      const partnerId = couple.find(id => id !== victimId);
      const partner   = connectedInGame.find(p => p.id === partnerId && p.dead == null);
      if (!partner) return [];
      const role = States.get('roles', []).find(a => a.id === partnerId)?.role || 'inconnu';
      return [
        States.say(narrate(`Joueur - ${partner.username}`)),
        States.say(narrate('Lié - mort chagrin')),
        States.say(narrate(`Annonce rôle - ${role}`)),
        States.kill(partnerId),
      ];
    })
  ];
}

function announceDeathsFlow() {
  return [
    States.refresh(),
    States.run(() => {
      const deaths = getRoundDeaths();
      if (deaths.length === 0) return [States.say(narrate('Nuit - aucun mort'))];
      return deaths.flatMap(p => {
        const role = States.get('roles', []).find(a => a.id === p.id)?.role || 'inconnu';
        return [
          States.say(narrate(`Joueur - ${p.username}`)),
          States.say(narrate('Nuit - joueur tué')),
          States.say(narrate(`Annonce rôle - ${role}`)),
          ...coupleDieFlow(p.id),
          hunterFlow(p.id),
        ];
      });
    }),
    States.run(() => {
      const mayorId = States.get('maire');
      if (!mayorId) return [];
      const deaths = getRoundDeaths();
      if (!deaths.find(p => p.id === mayorId)) return [];
      return mayorSuccessionFlow(mayorId);
    }),
  ];
}

function foxFlow() {
  const count = Math.max(1, scenarioSettings.foxSniffCount ?? 3);

  const pickSteps = [];
  for (let i = 1; i <= count; i++) {
    pickSteps.push(
      States.label(`fox_pick_${i}`),
      States.run(() => {
        const prevIds = Array.from({ length: i - 1 }, (_, k) => States.get(`renard_pick_${k + 1}`));
        const names   = prevIds.map(id => connectedInGame.find(p => p.id === id)?.username).filter(Boolean);
        const label   = names.length === 0
          ? `Vous devez selectionner ${count} joueurs. Désigner le premier joueur.`
          : `Désigner un joueur avec ${names.join(', ')}.`;
        return [States.select('renard', label, '🦊 Flairer')];
      }),
      States.on('confirm_selection_all', (targets) => {
        const pick = Object.values(targets)[0];
        for (let j = 1; j < i; j++) {
          if (pick === States.get(`renard_pick_${j}`)) return [States.jump(`fox_pick_${i}`)];
        }
        return [States.set(`renard_pick_${i}`, pick, States.LOCAL)];
      }),
    );
  }

  return [
    States.say(narrate('Renard - réveil')),
    ...pickSteps,
    States.run(() => {
      const picks   = Array.from({ length: count }, (_, k) => States.get(`renard_pick_${k + 1}`));
      const roles   = States.get('roles', []);
      const hasWolf = picks.some(id => roles.find(a => a.id === id)?.role === 'loupgarou');
      const key     = hasWolf ? 'Renard - résultat loup' : 'Renard - résultat aucun loup';
      return [
        ...(hasWolf ? [] : [States.set('renard_power_lost', true, States.GLOBAL)]),
        States.choice('renard', narrate(key), ['OK']),
        States.on('choice', () => []),
      ];
    }),
    States.say(narrate('Renard - sommeil')),
    States.sleep(),
  ];
}

function cupidFlow() {
  return [
    States.say(narrate('Cupidon - réveil')),
    States.label('cupidon_first_pick'),
    States.say(narrate('Cupidon - premier amoureux')),
    States.select('cupidon', 'Choisissez le premier lié.', '💘 Lier'),
    States.on('confirm_selection_all', (targets) => {
      const peerIdA = Object.values(targets)[0];
      return [
        States.set('cupidon_first', peerIdA, States.LOCAL),
      ];
    }),
    States.label('cupidon_second_pick'),
    States.say(narrate('Cupidon - second amoureux')),
    States.select('cupidon', 'Choisissez le second lié.', '💘 Lier'),
    States.on('confirm_selection_all', (targets) => {
      const peerIdA = States.get('cupidon_first');
      const peerIdB = Object.values(targets)[0];
      if (peerIdB === peerIdA) return [
        States.say(narrate('Cupidon - même joueur')),
        States.jump('cupidon_second_pick'),
      ];
      return [
        States.set('couple', [peerIdA, peerIdB], States.GLOBAL),
      ];
    }),
    States.say(narrate('Cupidon - sommeil')),
    States.sleep(),
    States.wake(null),
    States.show_role_btn(true),
    States.say(narrate('Village - consulter rôle')),
    States.wait(5),
    States.show_role_btn(false),
    States.sleep(),
    States.say(narrate('Village - fermer yeux')),
    States.wait(3),
    States.run(() => {
      const couple = States.get('couple', []);
      for (const id of couple) setStateForPlayer(id, 'wake', {});
      return [];
    }),
    States.say(narrate('Couple - réveil')),
    States.run(() => {
      const couple = States.get('couple', []);
      for (const id of couple) setStateForPlayer(id, 'choice', { label: 'Vous vous êtes reconnus.', choices: ['✓ OK'] });
      return [States.on('choice', () => [])];
    }),
    States.say(narrate('Couple - sommeil')),
    States.sleep(),
  ];
}

function defaultNightFlow() {
  return [
    States.set('night', true, States.GLOBAL),
    States.sleep(),
    States.say(""),
    States.say(narrate("Village - endormissement")),

    States.jumpif('after_cupid', () => States.get('round', 0) !== 1 || !isRolePresent('cupidon')),
    States.wait(3),
    ...cupidFlow(),
    States.label('after_cupid'),

    States.jumpif('after_fox', () => !isRolePresent('renard') || States.get('renard_power_lost')),
    ...foxFlow(),
    States.wait(3),
    States.label('after_fox'),

    States.jumpif('after_seer', () => !isRolePresent('voyante')),
    ...seerFlow(),
    States.wait(3),
    States.label('after_seer'),

    States.jumpif('after_salvateur', () => !isRolePresent('salvateur')),
    ...salvateurFlow(),
    States.wait(3),
    States.label('after_salvateur'),

    ...wolfFlow(),
    States.wait(3),

    States.jumpif('after_witch', () => !isRolePresent('sorciere')),
    ...witchFlow(),
    States.wait(3),
    States.label('after_witch'),

    States.jumpif('after_avocat', () => !isRolePresent('avocat')),
    ...avocatFlow(),
    States.wait(3),
    States.label('after_avocat'),

    States.set('night', false, States.GLOBAL),
    States.refresh(),
    States.say(narrate("Village - réveil")),
    States.wake(null),
    States.wait(2),
    ...announceDeathsFlow(),
    ...checkWinFlow(),
    States.wait(2),
    ...villageVoteFlow(),
    ...checkWinFlow(),
  ];
}

async function startNightFlow() {
  setNightUIMode(true);
  syncConnectedPlayers(true);

  await runFlow([
    States.set('round', (States.get('round', 0)) + 1, States.GLOBAL),
    States.refresh(),
    ...defaultNightFlow(),
  ]);

  if (gameActive) {
    setStateForAll('reset');
    setNightUIMode(false);
    syncConnectedPlayers(false);
  }
}

// ─── Pre-game flow ────────────────────────────────────────────────────────────
// Appelé juste après le lancement du jeu, avant la première nuit.
// Retourner [] pour désactiver.
async function preGameFlow() {
  if (!ROLES.find(r => r.id === 'maire')?.enabled) return;

  setNightUIMode(true);
  syncConnectedPlayers(true);

  await runFlow([
    ...mayorVoteFlow()
  ]);

  if (gameActive) {
    setStateForAll('reset');
    setNightUIMode(false);
    syncConnectedPlayers(false);
  }
}