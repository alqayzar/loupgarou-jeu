// ─── State builders ───────────────────────────────────────────────────────────
// Utiliser ces helpers pour déclarer les étapes d'un flow :
//   runFlow([
//     States.label('debut_nuit'),
//     States.say('La nuit tombe…'),
//     States.sleep(),
//     States.wait(2),
//     States.wake('loupgarou'),
//     States.say('Loups, ouvrez les yeux.', { pitch: 0.7 }),
//     States.jumpif('debut_nuit', () => roundCount < 3),
//   ])
const States = Object.freeze({
  wait:   (seconds)             => ({ type: 'wait',   seconds }),
  sleep:  ()                    => ({ type: 'sleep' }),
  wake:   (role)                => ({ type: 'wake',   role }),
  say:    (text, voice = {})    => ({ type: 'say',    text, voice }),
  label:  (name)                => ({ type: 'label',  name }),
  jumpif: (name, condition)     => ({ type: 'jumpif', name, condition }),
  // fn est appelée au moment de l'exécution et doit retourner un tableau d'étapes.
  // Utile pour des paramètres dynamiques connus seulement pendant le déroulé du jeu.
  run:    (fn)                  => ({ type: 'run',    fn }),
  kill:   (peerId)              => ({ type: 'kill',   peerId }),
  select: (role)                => ({ type: 'select', role }),
});

// ─── Flow runner ──────────────────────────────────────────────────────────────
let _flowCancelled = false;

async function runFlow(steps) {
  _flowCancelled = false;

  // Pré-scanner les labels : nom → index dans steps
  const labels = {};
  steps.forEach((step, i) => {
    if (step.type === 'label') labels[step.name] = i;
  });

  let i = 0;
  while (i < steps.length && !_flowCancelled) {
    const jump = await _executeStep(steps[i], labels);
    i = (jump !== undefined) ? jump : i + 1;
  }
}

function cancelFlow() {
  _flowCancelled = true;
  speechSynthesis.cancel();
}

// ─── Step executors ───────────────────────────────────────────────────────────
// Retourne un index si l'étape provoque un saut, undefined sinon.
async function _executeStep(step, labels) {
  switch (step.type) {
    case 'wait':   await _wait(step.seconds);         break;
    case 'sleep':  setStateForAll('sleep');           break;
    case 'wake':   _wakeRole(step.role);              break;
    case 'say':    await _say(step.text, step.voice); break;
    case 'label':  /* marqueur, rien à exécuter */    break;
    case 'jumpif':
      if (step.condition()) return labels[step.name];
      break;
    case 'run':
      await runFlow(step.fn());
      break;
    case 'kill':
      killPlayer(step.peerId);
      break;
    case 'select':
      _selectRole(step.role);
      break;
  }
}

function _wait(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// Réveille les joueurs possédant le rôle spécifié.
// Si roleId est vide ou null, réveille tout le monde.
// Le host est traité directement (pas via le réseau).
function _wakeRole(roleId) {
  if (!roleId) { setStateForAll('wake'); return; }
  const targets = roleAssignments.filter(a => a.role === roleId);
  for (const { id } of targets) {
    setStateForPlayer(id, 'wake');
  }
}

// Met en mode sélection les joueurs possédant le rôle spécifié.
// Si roleId est null, tout le monde passe en mode sélection.
function _selectRole(roleId) {
  if (!roleId) { setStateForAll('select'); return; }
  const targets = roleAssignments.filter(a => a.role === roleId);
  for (const { id } of targets) {
    setStateForPlayer(id, 'select');
  }
}

// Prononce le texte et attend la fin avant de passer à l'étape suivante.
function _say(text, voiceParams) {
  return new Promise((resolve) => {
    const config = { ...getVoiceConfig(), ...voiceParams };
    const utter  = new SpeechSynthesisUtterance(text);
    utter.pitch  = config.pitch  ?? 1;
    utter.rate   = config.rate   ?? 1;
    utter.volume = config.volume ?? 1;
    if (config.voiceURI) {
      const v = getAvailableVoices().find(v => v.voiceURI === config.voiceURI);
      if (v) utter.voice = v;
    }
    utter.onend  = resolve;
    utter.onerror = resolve;  // ne jamais bloquer le flow sur une erreur vocale
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);
  });
}
