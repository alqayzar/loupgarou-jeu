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
    States.say(narration["Loups garous - réveil"]),
    States.select('loupgarou', 'Selectionner une victime !', '🐺 Désigner'),
    States.on('confirm_selection_all', (targets) => {
      const victim = getMajority(targets);
      return victim
        ? [States.kill(victim)]
        : [States.jump("begin_wolf_vote")];
    }),
    States.say(narration["Loups garous - sommeil"]),
    States.sleep(),
  ];
}

function witchFlow() {
  return [
    // States.wake('sorciere'),
    States.say(narration["Sorcière - réveil"]),
    States.run(() => {
      const deaths = getRoundDeaths();
      if (deaths.length === 0 || States.get('sorciere_save_used')) return [];
      return [
        States.say(narration["Sorcière - proposition sauvetage"]),
        States.choice('sorciere', `Voulez-vous sauver ${deaths[0].username} ?`, ['💊 Sauver', 'Non']),
        States.on('choice', ({ choiceIndex }) => {
          if (choiceIndex === 0) {
            return [
              States.set('sorciere_save_used', true, States.GLOBAL),
              States.revive(deaths[0].id),
            ];
          }
          return [];
        }),
      ];
    }),
    States.run(() => {
      if (States.get('sorciere_poison_used')) return [];
      return [
        States.say(narration["Sorcière - proposition poison"]),
        States.choice('sorciere', 'Voulez vous utiliser votre poison ?', ['☠️ Empoisonner', 'Non']),
        States.on('choice', ({ choiceIndex }) => choiceIndex !== 0 ? [] : [
          States.select('sorciere', 'Choisissez votre victime.', '☠️ Empoisonner'),
          States.on('confirm_selection_all', (targets) => [
            States.set('sorciere_poison_used', true, States.GLOBAL),
            States.kill(targets[0]),
          ]),
        ]),
      ];
    }),
    States.say(narration["Sorcière - sommeil"]),
    States.sleep(),
  ];
}

function seerFlow() {
  return [
    States.wake('voyante'),
    States.say(narration["Voyante - réveil"]),
    States.select('voyante', 'Choisissez un joueur à observer.', '🔮 Observer'),
    States.on('confirm_selection_all', (targets) => {
      const assignment = roleAssignments.find(a => a.id === targets[0]);
      const role = assignment?.role || 'inconnu';
      return [
        States.choice('voyante', `Ce joueur est : ${role}`, ['OK']),
        States.on('choice', () => []),
      ];
    }),
    States.say(narration["Voyante - sommeil"]),
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

    States.say(narration['Vote - ouverture']),
    States.run(() => scenarioSettings.voteTimeoutEnabled
      ? [States.say(narrate('Vote - avertissement timeout'))]
      : []),

    States.select('alive', 'Votez pour éliminer un suspect.', '🗳️ Voter', scenarioSettings.allowBlankVote),

    States.run(() => scenarioSettings.voteTimeoutEnabled
      ? [States.timeout('village_vote', scenarioSettings.voteTimeoutSeconds * 1000, States.GLOBAL)]
      : []),
    
    States.many_on({
      'timeout:village_vote': () => [
        States.reset(),
        States.say(narration['Vote - temps écoulé']),
      ],
      'confirm_selection_all': (targets) => {
      const victim = getMajority(targets);
      if (!victim) return [
        States.clearTimeout('village_vote'),
        States.say(narration['Vote - pas de majorité']),
        States.jump('begin_village_vote'),
      ];
      if (victim === 'none') return [
        States.say(narration['Vote - vote blanc']),
      ];
      const player     = connectedInGame.find(p => p.id === victim);
      const assignment = roleAssignments.find(a => a.id === victim);
      const role       = assignment?.role || 'inconnu';
      return [
        States.clearTimeout('village_vote'),
        States.say(narrate(`Joueur - ${player?.username || 'Un joueur'}`)),
        States.say(narration['Vote - élimination']),
        States.say(narrate(`Annonce rôle - ${role}`)),
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
          States.say(narration['Victoire villageois']),
          States.reveal('villageois'),
          States.jump('exit'),
        ];
      }
      if (wolves.length >= villagers.length) {
        return [
          States.say(narration['Victoire loups garous']),
          States.reveal('loupgarou'),
          States.jump('exit'),
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
      if (deaths.length === 0) return [States.say(narration['Nuit - aucun mort'])];
      return deaths.flatMap(p => {
        const role = roleAssignments.find(a => a.id === p.id)?.role || 'inconnu';
        return [
          States.say(narrate(`Joueur - ${p.username}`)),
          States.say(narration['Nuit - joueur tué']),
          States.say(narrate(`Annonce rôle - ${role}`)),
        ];
      });
    }),
  ];
}

// function testTimeoutFlow() {
//   return [
//     States.wait(3),
//     States.timeout('hello', 20_000, States.GLOBAL),
//     States.select(null, 'Selectionner qqchose', 'Bouton'),
//     States.many_on({
//       'timeout:hello' : () => [
//         States.say("Vous n'avez pas voter à temps, c'est problématique !"),
//       ],
//       'confirm_selection_all' : () => [
//         States.clearTimeout('hello'),
//         States.say("Bien joué vous avez vôté à temps !"),
//       ],
//     }),
//     States.reset(),
//     States.on('timeout:hello', () => [States.say("TIMEOUT !")]),
//   ];
// }

function defaultNightFlow() {
  return [
    States.set('night', true, States.GLOBAL),
    States.sleep(),
    States.say(""),
    States.say(narration["Village - endormissement"]),

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
    States.say(narration["Village - réveil"]),
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
