// ─── Variable store ──────────────────────────────────────────────────────────
const _vars = {};  // in-memory cache — source of truth for States.get()

async function _setVar(key, value) {
  _vars[key] = value;
  await dbSet('flow_vars', { ..._vars });
}

function resetVars() {
  for (const k of Object.keys(_vars)) delete _vars[k];
  dbDel('flow_vars');
}

async function loadVars() {
  const saved = await dbGet('flow_vars');
  if (saved) Object.assign(_vars, saved);
}

// ─── Timeout registry ────────────────────────────────────────────────────────
const _pendingTimeouts = {};  // name → timeoutId
let _globalTimeoutName = null;

function _clearTimeout(name) {
  if (_pendingTimeouts[name] != null) {
    clearTimeout(_pendingTimeouts[name]);
    delete _pendingTimeouts[name];
  }
}

function _broadcastTimeoutClear() {
  const msg = { type: MSG.TIMEOUT_CLEAR };
  for (const conn of Object.values(connections)) conn.send(msg);
  hideCountdownTimer();
}

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

function onChoiceReceived(selectorId, choiceIndex) {
  triggerEvent('choice', { selectorId, choiceIndex });
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
  LOCAL:  'local',
  GLOBAL: 'global',
  get:    (key, defaultValue) => _vars[key] !== undefined ? _vars[key] : defaultValue,
  set:    (key, value, scope = 'local') => ({ type: 'set', key, value, scope }),
  wait:         (seconds)          => ({ type: 'wait',   seconds }),
  sleep:        ()                 => ({ type: 'sleep' }),
  wake:         (role)             => ({ type: 'wake',   role }),
  say:          (text, voice = {}) => ({ type: 'say',    text, voice }),
  label:        (name)             => ({ type: 'label',  name }),
  jump:         (name)             => ({ type: 'jump',   name }),
  jumpif:       (name, condition)  => ({ type: 'jumpif', name, condition }),
  // fn est appelée au moment de l'exécution et doit retourner un tableau d'étapes.
  // Utile pour des paramètres dynamiques connus seulement pendant le déroulé du jeu.
  run:          (fn)               => ({ type: 'run',    fn }),
  kill:         (peerId)           => ({ type: 'kill',   peerId }),
  revive:       (peerId)           => ({ type: 'revive', peerId }),
  select:       (role, label, buttonText, allowNone = false) => ({ type: 'select', role, label, buttonText, allowNone }),
  // Bloque le flow jusqu'à triggerEvent(name, data). handler(data) peut retourner des steps.
  on:           (name, handler)    => ({ type: 'on',     name, handler }),
  reset:        ()                 => ({ type: 'reset' }),
  choice:       (role, label, choices) => ({ type: 'choice', role, label, choices }),
  end:          ()                 => ({ type: 'end' }),
  timeout:      (name, ms, scope = 'local') => ({ type: 'timeout',      name, ms, scope }),
  clearTimeout: (name)                      => ({ type: 'clearTimeout', name }),
  many_on:      (handlers)        => ({ type: 'many_on',      handlers }),
  conditional:  (condition, ifSteps, elseSteps = []) => ({ type: 'conditional', condition, ifSteps, elseSteps }),
  reveal:       (team) => ({ type: 'reveal', team }),
  refresh:      ()     => ({ type: 'refresh' }),
  triggerEvent,
});

// ─── Flow runner ──────────────────────────────────────────────────────────────
let _flowCancelled = false;
let _currentAudio  = null;

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
    if (typeof jump === 'string') return jump;  // label non trouvé — remonter à l'appelant
    i = (jump != null) ? jump : i + 1;
  }
}

function cancelFlow() {
  _flowCancelled = true;
  if (_globalTimeoutName) { _broadcastTimeoutClear(); _globalTimeoutName = null; }
  for (const id of Object.values(_pendingTimeouts)) clearTimeout(id);
  for (const key of Object.keys(_pendingTimeouts)) delete _pendingTimeouts[key];
  for (const resolve of Object.values(_pendingEvents)) resolve({ cancelled: true });
  for (const key of Object.keys(_pendingEvents)) delete _pendingEvents[key];
  _resetSelectionTracking();
  if (_currentAudio) { _currentAudio.pause(); _currentAudio = null; }
  speechSynthesis.cancel();
}

// ─── Step executors ───────────────────────────────────────────────────────────
// Retourne un index si l'étape provoque un saut, undefined sinon.
async function _executeStep(step, labels) {
  switch (step.type) {
    case 'wait':   await _wait(step.seconds);         break;
    case 'sleep':  clearAllSelections(); setStateForAll('sleep'); break;
    case 'wake':   _wakeRole(step.role);              break;
    case 'say':    await _say(step.text, step.voice); break;
    case 'label':  /* marqueur, rien à exécuter */    break;
    case 'jump':
      return (step.name in labels) ? labels[step.name] : step.name;
    case 'jumpif':
      if (step.condition()) return (step.name in labels) ? labels[step.name] : step.name;
      break;
    case 'run': {
      const label = await runFlow(step.fn());
      if (label) return label;
      break;
    }
    case 'kill':   killPlayer(step.peerId);   break;
    case 'revive': revivePlayer(step.peerId); break;
    case 'end':    cancelFlow(); endGame();   break;
    case 'timeout': {
      if (step.scope === States.GLOBAL) {
        // Écraser l'ancien timeout global s'il existe
        if (_globalTimeoutName) {
          _clearTimeout(_globalTimeoutName);
          _broadcastTimeoutClear();
        }
        _globalTimeoutName = step.name;
        const startMsg = { type: MSG.TIMEOUT_START, ms: step.ms };
        for (const conn of Object.values(connections)) conn.send(startMsg);
        showCountdownTimer(step.ms);
      }
      const id = setTimeout(() => {
        delete _pendingTimeouts[step.name];
        if (_globalTimeoutName === step.name) {
          _globalTimeoutName = null;
          _broadcastTimeoutClear();
        }
        triggerEvent('timeout:' + step.name, null);
      }, step.ms);
      _pendingTimeouts[step.name] = id;
      break;  // non-bloquant — le flow continue immédiatement
    }
    case 'clearTimeout': {
      const wasGlobal = _globalTimeoutName === step.name;
      _clearTimeout(step.name);
      if (wasGlobal) {
        _globalTimeoutName = null;
        _broadcastTimeoutClear();
      }
      break;
    }
    case 'set': {
      await _setVar(step.key, step.value);
      if (step.scope === States.GLOBAL) {
        const msg = { type: MSG.SET_VAR, key: step.key, value: step.value };
        for (const conn of Object.values(connections)) conn.send(msg);
      }
      break;
    }
    case 'select':
      _selectRole(step.role, step.label, step.buttonText, step.allowNone);
      break;
    case 'reset':
      setStateForAll('reset');
      clearAllSelections();
      break;
    case 'choice':
      _choiceRole(step.role, step.label, step.choices);
      break;
    case 'on': {
      const result = await new Promise(resolve => {
        _pendingEvents[step.name] = resolve;
      });
      if (!result.cancelled && step.handler) {
        const steps = step.handler(result.data);
        if (Array.isArray(steps) && steps.length) {
          const label = await runFlow(steps);
          if (typeof label === 'string') return (label in labels) ? labels[label] : label;
        }
      }
      break;
    }
    case 'reveal': {
      const msg = { type: MSG.REVEAL, team: step.team };
      for (const conn of Object.values(connections)) conn.send(msg);
      applyReveal(step.team, States.get('roles', []));
      break;
    }
    case 'refresh': {
      renderGameGrid();
      const msg = { type: MSG.REFRESH_GRID };
      for (const conn of Object.values(connections)) conn.send(msg);
      break;
    }
    case 'conditional': {
      const truthy = typeof step.condition === 'function' ? step.condition() : step.condition;
      const branch = truthy ? step.ifSteps : step.elseSteps;
      if (branch.length) {
        const label = await runFlow(branch);
        if (typeof label === 'string') return (label in labels) ? labels[label] : label;
      }
      break;
    }
    case 'many_on': {
      const result = await new Promise(resolve => {
        for (const [name, handler] of Object.entries(step.handlers)) {
          _pendingEvents[name] = ({ data, cancelled }) => {
            for (const n of Object.keys(step.handlers)) delete _pendingEvents[n];
            resolve({ data, handler, cancelled });
          };
        }
      });
      if (!result.cancelled && result.handler) {
        const steps = result.handler(result.data);
        if (Array.isArray(steps) && steps.length) {
          const label = await runFlow(steps);
          if (typeof label === 'string') return (label in labels) ? labels[label] : label;
        }
      }
      break;
    }
  }
  return null;
}

function _wait(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// Réveille les joueurs possédant le rôle spécifié.
// Si roleId est vide ou null, réveille tout le monde.
// Le host est traité directement (pas via le réseau).
function _wakeRole(roleId) {
  if (!roleId) { setStateForAll('wake'); return; }
  const targets = States.get('roles', []).filter(a => a.role === roleId);
  for (const { id } of targets) {
    setStateForPlayer(id, 'wake');
  }
}

// Met en mode sélection les joueurs possédant le rôle spécifié (vivants uniquement).
// Si roleId est null, tous les joueurs vivants passent en mode sélection.
function _choiceRole(roleId, label, choices) {
  const alive = connectedInGame.filter(p => p.dead == null || p.dead === States.get('round', 0));
  const targets = roleId
    ? States.get('roles', []).filter(a => a.role === roleId && alive.some(p => p.id === a.id))
    : alive;
  for (const { id } of targets) setStateForPlayer(id, 'choice', { label, choices });
}

function _selectRole(roleId, label, buttonText, allowNone = false) {
  _resetSelectionTracking();
  clearAllSelections();
  let targets;
  if (roleId === 'alive') {
    targets = connectedInGame.filter(p => p.dead == null);
  } else {
    const pool = connectedInGame.filter(p => p.dead == null || p.dead === States.get('round', 0));
    targets = roleId ? States.get('roles', []).filter(a => a.role === roleId && pool.some(p => p.id === a.id)) : pool;
  }
  _selectCount = targets.length;
  for (const { id } of targets) setStateForPlayer(id, 'select', { label, buttonText, allowNone });
}

// Prononce le texte et attend la fin avant de passer à l'étape suivante.
// Si le texte commence par '#', lit le fichier audio encodé en data URL après le '#'.
function _say(text, voiceParams) {
  if (text && text.startsWith('#')) {
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      _currentAudio = new Audio(text.slice(1));
      _currentAudio.onended = () => { _currentAudio = null; resolve(); };
      _currentAudio.onerror = () => { _currentAudio = null; resolve(); };
      _currentAudio.play().catch(() => { _currentAudio = null; resolve(); });
    });
  }
  return new Promise((resolve) => {
    _currentAudio = null;
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
    setTimeout(() => speechSynthesis.speak(utter), 100);
  });
}
