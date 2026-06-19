// ─── Event registry ───────────────────────────────────────────────────────────
const _pendingEvents = {};

function triggerEvent(name, data) {
  const resolve = _pendingEvents[name];
  if (resolve) {
    delete _pendingEvents[name];
    resolve({ data, cancelled: false });
  }
}

// ─── Selection confirmation tracking ─────────────────────────────────────────
let _selectCount   = 0;  // nombre de joueurs ayant reçu le mode sélection
let _confirmCount  = 0;  // nombre de joueurs ayant confirmé leur sélection
const _confirmations = {};  // selectorId → targetId

function _resetSelectionTracking() {
  _selectCount  = 0;
  _confirmCount = 0;
  for (const k of Object.keys(_confirmations)) delete _confirmations[k];
}

function onConfirmSelectionReceived(selectorId, targetId) {
  if (!Object.prototype.hasOwnProperty.call(_confirmations, selectorId)) _confirmCount++;
  _confirmations[selectorId] = targetId;
  if (_selectCount > 0 && _confirmCount >= _selectCount) {
    const targets = Object.values(_confirmations);
    _resetSelectionTracking();
    triggerEvent('confirm_selection_all', targets);
  }
}

function onCancelSelectionReceived(selectorId) {
  if (Object.prototype.hasOwnProperty.call(_confirmations, selectorId)) {
    delete _confirmations[selectorId];
    _confirmCount--;
  }
}

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
  wait:         (seconds)          => ({ type: 'wait',   seconds }),
  sleep:        ()                 => ({ type: 'sleep' }),
  wake:         (role)             => ({ type: 'wake',   role }),
  say:          (text, voice = {}) => ({ type: 'say',    text, voice }),
  label:        (name)             => ({ type: 'label',  name }),
  jumpif:       (name, condition)  => ({ type: 'jumpif', name, condition }),
  // fn est appelée au moment de l'exécution et doit retourner un tableau d'étapes.
  // Utile pour des paramètres dynamiques connus seulement pendant le déroulé du jeu.
  run:          (fn)               => ({ type: 'run',    fn }),
  kill:         (peerId)           => ({ type: 'kill',   peerId }),
  select:       (role)             => ({ type: 'select', role }),
  // Bloque le flow jusqu'à triggerEvent(name, data). handler(data) peut retourner des steps.
  on:           (name, handler)    => ({ type: 'on',     name, handler }),
  reset:        ()                 => ({ type: 'reset' }),
  triggerEvent,
});

// ─── Flow runner ──────────────────────────────────────────────────────────────
let _flowCancelled = false;

async function runFlow(steps) {
  if (!steps || steps.lenght === 0) return;

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
  for (const resolve of Object.values(_pendingEvents)) {
    resolve({ cancelled: true });
  }
  for (const key of Object.keys(_pendingEvents)) delete _pendingEvents[key];
  _resetSelectionTracking();
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
    case 'reset':
      setStateForAll('reset');
      break;
    case 'on': {
      const result = await new Promise(resolve => {
        _pendingEvents[step.name] = resolve;
      });
      if (!result.cancelled && step.handler) {
        const steps = step.handler(result.data);
        if (Array.isArray(steps) && steps.length) await runFlow(steps);
      }
      break;
    }
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

// Met en mode sélection les joueurs possédant le rôle spécifié (vivants uniquement).
// Si roleId est null, tous les joueurs vivants passent en mode sélection.
function _selectRole(roleId) {
  _resetSelectionTracking();
  const alive = connectedInGame.filter(p => p.dead == null);
  const targets = roleId
    ? roleAssignments.filter(a => a.role === roleId && alive.some(p => p.id === a.id))
    : alive;
  _selectCount = targets.length;
  for (const { id } of targets) setStateForPlayer(id, 'select');
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
