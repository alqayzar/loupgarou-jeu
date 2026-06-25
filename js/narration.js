// ─── Narration ────────────────────────────────────────────────────────────────
// Tous les textes prononcés par States.say() sont centralisés ici.
// Les clés servent aussi de labels dans la section Narration des paramètres.
// Variables disponibles selon la clé : {username}, {role}, {duration}.

const NARRATION_DEFAULTS = {
  // Nuit — général
  "Village - endormissement":            "Le village s'endort, fermez les yeux !",
  "Village - réveil":                    "Le village se réveille, ouvrez les yeux !",

  // Loups garous
  "Loups garous - réveil":               "Loup garou, ouvrez les yeux !",
  "Loups garous - sommeil":              "Loups garous, fermez les yeux !",

  // Sorcière
  "Sorcière - réveil":                   "Sorcière, ouvrez les yeux !",
  "Sorcière - proposition sauvetage":    "Voulez-vous sauver ce joueur ?",
  "Sorcière - proposition poison":       "Voulez vous utiliser votre poison ?",
  "Sorcière - sommeil":                  "Sorcière, fermez les yeux !",

  // Voyante
  "Voyante - réveil":                    "Voyante, ouvrez les yeux !",
  "Voyante - sommeil":                   "Voyante, fermez les yeux !",

  // Vote du village
  "Vote - ouverture":                    "Le village doit voter pour éliminer un suspect.",
  "Vote - avertissement timeout":        "Attention votre temps est compté !",
  "Vote - ouverture avec timer":         "Le village doit voter pour éliminer un suspect. {duration}",
  "Vote - temps écoulé":                 "Le village n'a pas voté dans le temps imparti, aucun joueur n'est éliminé !",
  "Vote - pas de majorité":              "Un vote majoritaire est requis !",
  "Vote - vote blanc":                   "Le village a voté blanc. Personne n'est éliminé.",
  "Vote - élimination":                  "est éliminé par le village !",

  // Annonces nocturnes
  "Nuit - aucun mort":                   "Cette nuit, personne n'est mort.",
  "Nuit - joueur tué":                   "a été tué cette nuit.",

  // Vote du maire
  "Vote - maire":                        "Le village doit élire son maire !",
  "Vote - maire égalité":                "Égalité ! Le village doit revoter pour le maire !",
  "Vote - maire élu":                    "est élu maire du village !",

  // Fin de partie
  "Victoire villageois":                 "Les villageois ont gagné ! Tous les loups garous sont morts !",
  "Victoire loups garous":               "Les loups garous ont gagné ! Ils sont maintenant majoritaires !",

  // Annonce du rôle après élimination — une entrée par rôle, générée depuis ROLES
  ...Object.fromEntries(ROLES.map(r => [
    `Annonce rôle - ${r.id}`,
    `Ce joueur était ${r.label}`,
  ])),
};

let narration      = { ...NARRATION_DEFAULTS };
let currentProfile = 'default';
let _profiles      = { default: {} };

// Retourne le texte de narration pour la clé donnée, en substituant les variables {key}.
function narrate(key, vars = {}) {
  let text = narration[key] ?? NARRATION_DEFAULTS[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{${k}}`, v);
  }
  return text;
}

async function loadNarrationSettings() {
  let profiles = await dbGet('narration_profiles');
  if (!profiles) {
    // Migration depuis l'ancien format clé unique
    const legacy = await dbGet('narration_settings');
    profiles = { default: legacy || {} };
    await dbSet('narration_profiles', profiles);
  }
  _profiles = profiles;
  const saved = await dbGet('narration_current') || 'default';
  currentProfile = _profiles[saved] ? saved : 'default';
  narration = { ...NARRATION_DEFAULTS };
  Object.assign(narration, _profiles[currentProfile] || {});
}

async function saveNarrationSettings() {
  _profiles[currentProfile] = { ...narration };
  await dbSet('narration_profiles', _profiles);
}

async function switchProfile(id) {
  await saveNarrationSettings();
  currentProfile = id;
  await dbSet('narration_current', id);
  narration = { ...NARRATION_DEFAULTS };
  Object.assign(narration, _profiles[id] || {});
}

async function createProfile(name) {
  _profiles[name] = { ...narration };  // copie du profil courant
  currentProfile  = name;
  await dbSet('narration_current', name);
  await dbSet('narration_profiles', _profiles);
}

async function deleteProfile(id) {
  if (id === 'default') return;
  delete _profiles[id];
  await dbSet('narration_profiles', _profiles);
  if (currentProfile === id) {
    currentProfile = 'default';
    await dbSet('narration_current', 'default');
    narration = { ...NARRATION_DEFAULTS };
    Object.assign(narration, _profiles.default || {});
  }
}

function resetNarrationSettings() {
  narration = { ...NARRATION_DEFAULTS };
  _profiles[currentProfile] = {};
  saveNarrationSettings();
}

// S'assure qu'une entrée narration existe pour ce joueur (sans écraser une valeur existante).
function ensurePlayerNarration(username) {
  const key = `Joueur - ${username}`;
  if (narration[key] === undefined) {
    narration[key] = username;
    saveNarrationSettings();
  }
}


// ─── Trim silence ──────────────────────────────────────────────────────────────
// Retire les plages silencieuses aux deux extrémités d'un audio encodé en data URL.
// Retourne un nouveau data URL (WAV 16-bit) tronqué, ou le data URL original en cas d'échec.
async function trimSilence(dataURL, threshold = 0.01) {
  const audioCtx = new AudioContext();
  try {
    const arrayBuffer = await (await fetch(dataURL)).arrayBuffer();
    const buf         = await audioCtx.decodeAudioData(arrayBuffer);
    const ch          = buf.numberOfChannels;
    const len         = buf.length;
    let start = len - 1, end = 0;

    for (let c = 0; c < ch; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        if (Math.abs(data[i]) > threshold) { if (i < start) start = i; break; }
      }
      for (let i = len - 1; i >= 0; i--) {
        if (Math.abs(data[i]) > threshold) { if (i > end) end = i; break; }
      }
    }

    if (start >= end) return dataURL;

    const trimLen = end - start + 1;
    const trimmed = audioCtx.createBuffer(ch, trimLen, buf.sampleRate);
    for (let c = 0; c < ch; c++) {
      trimmed.copyToChannel(buf.getChannelData(c).subarray(start, end + 1), c);
    }
    return await _audioBufferToDataURL(trimmed);
  } catch {
    return dataURL;
  } finally {
    audioCtx.close();
  }
}

function _audioBufferToDataURL(buf) {
  const ch  = buf.numberOfChannels;
  const sr  = buf.sampleRate;
  const len = buf.length;
  const bps = 2; // 16-bit
  const dataSize = len * ch * bps;
  const ab   = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const ws   = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  ws(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true);  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);  view.setUint32(24, sr, true);
  view.setUint32(28, sr * ch * bps, true);
  view.setUint16(32, ch * bps, true); view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(c)[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }

  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.readAsDataURL(new Blob([ab], { type: 'audio/wav' }));
  });
}
