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

// Retourne true si au moins un joueur vivant (ou tué cette nuit) possède ce rôle.
// Un joueur tué cette nuit (dead === round) est encore considéré vivant pendant la nuit.
function isRolePresent(role) {
  return roleAssignments.some(a =>
    a.role === role &&
    connectedInGame.some(p => p.id === a.id && (p.dead == null || p.dead === round))
  );
}

// Retourne les joueurs tués durant ce round.
function getRoundDeaths() {
  return connectedInGame.filter(p => p.dead === round);
}

// ─── Night flow ───────────────────────────────────────────────────────────────
function wolfFlow() {
  return [
    States.label("begin_wolf_vote"),
    // States.wake('loupgarou'),
    States.say("Loup garou, ouvrez les yeux !"),
    States.select('loupgarou', 'Selectionner une victime !', '🐺 Désigner'),
    States.on('confirm_selection_all', (targets) => {
      const victim = getMajority(targets);
      return victim
        ? [States.kill(victim)]
        : [States.jump("begin_wolf_vote")];
    }),
    States.say("Loups garous, fermez les yeux !"),
    States.sleep(),
  ];
}

function witchFlow() {
  return [
    // States.wake('sorciere'),
    States.say("Sorcière, ouvrez les yeux !"),
    States.run(() => {
      const witch  = roleAssignments.find(a => a.role === 'sorciere');
      const deaths = getRoundDeaths();
      if (deaths.length === 0 || witch.saveUsed >= 1) return [];
      return [
        States.say('Voulez-vous sauver ce joueur ?'),
        States.choice('sorciere', `Voulez-vous sauver ${deaths[0].username} ?`, ['💊 Sauver', 'Non']),
        States.on('choice', ({ choiceIndex }) => {
          if (choiceIndex === 0) {
            witch.saveUsed++;
            return [States.revive(deaths[0].id)];
          }
          return [];
        }),
      ];
    }),
    States.run(() => {
      const witch = roleAssignments.find(a => a.role === 'sorciere');
      if (witch.poisonUsed >= 1) return [];
      return [
        States.say('Voulez vous utiliser votre poison ?'),
        States.choice('sorciere', 'Voulez vous utiliser votre poison ?', ['☠️ Empoisonner', 'Non']),
        States.on('choice', ({ choiceIndex }) => choiceIndex !== 0 ? [] : [
          States.select('sorciere', 'Choisissez votre victime.', '☠️ Empoisonner'),
          States.on('confirm_selection_all', (targets) => {
            witch.poisonUsed++;
            return [States.kill(targets[0])];
          }),
        ]),
      ];
    }),
    States.say("Sorcière, fermez les yeux !"),
    States.sleep(),
  ];
}

function seerFlow() {
  return [
    States.wake('voyante'),
    States.say("Voyante, ouvrez les yeux !"),
    States.select('voyante', 'Choisissez un joueur à observer.', '🔮 Observer'),
    States.on('confirm_selection_all', (targets) => {
      const assignment = roleAssignments.find(a => a.id === targets[0]);
      const role = assignment?.role || 'inconnu';
      return [
        States.choice('voyante', `Ce joueur est : ${role}`, ['OK']),
        States.on('choice', () => []),
      ];
    }),
    States.say("Voyante, fermez les yeux !"),
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

function villageVoteFlow() {
  return [
    States.label('begin_village_vote'),

    States.run(() => scenarioSettings.voteTimeoutEnabled
      ? [States.say('Le village doit voter pour éliminer un suspect. ' + _formatVoteDuration(scenarioSettings.voteTimeoutSeconds))]
      : [States.say('Le village doit voter pour éliminer un suspect.')]),

    States.select('alive', 'Votez pour éliminer un suspect.', '🗳️ Voter', scenarioSettings.allowBlankVote),

    States.run(() => scenarioSettings.voteTimeoutEnabled
      ? [States.timeout('village_vote', scenarioSettings.voteTimeoutSeconds * 1000, States.GLOBAL)]
      : []),
    
    States.many_on({
      'timeout:village_vote': () => [
        States.reset(),
        States.say("Le village n'a pas voté dans le temps imparti, aucun joueur n'est éliminé !"),
      ],
      'confirm_selection_all': (targets) => {
      const victim = getMajority(targets);
      if (!victim) return [
        States.clearTimeout('village_vote'),
        States.say('Un vote majoritaire est requis !'),
        States.jump('begin_village_vote'),
      ];
      if (victim === 'none') return [
        States.say("Le village a voté blanc. Personne n'est éliminé."),
      ];
      const player     = connectedInGame.find(p => p.id === victim);
      const assignment = roleAssignments.find(a => a.id === victim);
      const role       = assignment?.role || 'inconnu';
      return [
        States.clearTimeout('village_vote'),
        States.say(`${player?.username || 'Un joueur'} est éliminé par le village ! Ce joueur était ${role}.`),
        States.kill(victim),
      ];
    }}),
  ];
}

function checkWinFlow() {
  return [
    States.run(() => {
      const alive     = connectedInGame.filter(p => p.dead == null);
      const wolves    = alive.filter(p => roleAssignments.some(a => a.id === p.id && a.role === 'loupgarou'));
      const villagers = alive.filter(p => !roleAssignments.some(a => a.id === p.id && a.role === 'loupgarou'));

      if (wolves.length === 0) {
        return [
          States.say('Les villageois ont gagné ! Tous les loups garous sont morts !'),
          States.reveal('villageois'),
        ];
      }
      if (wolves.length >= villagers.length) {
        return [
          States.say('Les loups garous ont gagné ! Ils sont maintenant majoritaires !'),
          States.reveal('loupgarou'),
        ];
      }
      return [];
    }),
  ];
}

function announceDeathsFlow() {
  return [
    States.run(() => {
      const deaths = getRoundDeaths();
      if (deaths.length === 0) return [States.say("Cette nuit, personne n'est mort.")];
      return deaths.map(p => States.say(`${p.username} a été tué cette nuit.`));
    }),
  ];
}

function testTimeoutFlow() {
  return [
    States.wait(3),
    States.timeout('hello', 20_000, States.GLOBAL),
    States.select(null, 'Selectionner qqchose', 'Bouton'),
    States.many_on({
      'timeout:hello' : () => [
        States.say("Vous n'avez pas voter à temps, c'est problématique !"),
      ],
      'confirm_selection_all' : () => [
        States.clearTimeout('hello'),
        States.say("Bien joué vous avez vôté à temps !"),
      ],
    }),
    States.reset(),
    States.on('timeout:hello', () => [States.say("TIMEOUT !")]),
  ];
}

function defaultNightFlow() {
  return [
    States.set('night', true, States.GLOBAL),
    States.sleep(),
    States.say(""),
    States.say("Le village s'endort"),

    States.wait(3),
    ...wolfFlow(),
    States.wait(3),
    
    States.jumpif('after_witch', () => !isRolePresent('sorciere')),
    ...witchFlow(),
    States.wait(3),
    States.label('after_witch'),

    States.jumpif('after_seer', () => !isRolePresent('voyante')),
    ...seerFlow(),
    States.wait(3),
    States.label('after_seer'),

    States.set('night', false, States.GLOBAL),
    States.say("Le village se reveilles"),
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
  round++;
  updateRoundDisplay(round);
  saveRound();
  setNightUIMode(true);
  syncConnectedPlayers(true);

  await runFlow(defaultNightFlow());

  if (gameActive) {
    setStateForAll('reset');
    setNightUIMode(false);
    syncConnectedPlayers(false);
  }
}
