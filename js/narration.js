// ─── Narration ────────────────────────────────────────────────────────────────
// Tous les textes prononcés par States.say() sont centralisés ici.
// Les clés servent aussi de labels dans la section Narration des paramètres.
// Variables disponibles selon la clé : {username}, {role}, {duration}.

const NARRATION_DEFAULTS = {
  // Nuit — général
  "Village - endormissement":            "La nuit tombe sur le village. Tout le monde ferme les yeux.",
  "Village - fermer yeux":               "Tout le monde ferme les yeux.",
  "Village - réveil":                    "L'aube se lève. Villageois, ouvrez les yeux.",

  // Loups garous
  "Loups garous - réveil":               "Loups garoux ouvrez les yeux. Désignez votre proie.",
  "Loups garous - sommeil":              "Loups garoux rendormez-vous.",

  // Sorcière
  "Sorcière - réveil":                   "La sorcière s'éveille dans l'obscurité.",
  "Sorcière - proposition sauvetage":    "Souhaitez-vous utiliser votre potion de vie ?",
  "Sorcière - proposition poison":       "Avez-vous une âme à condamner ce soir ?",
  "Sorcière - sommeil":                  "La sorcière referme ses grimoires et se rendort.",

  // Voyante
  "Voyante - réveil":                    "La voyante scrute les ténèbres. Choisissez une âme à percer.",
  "Voyante - sommeil":                   "La voyante garde ses secrets et se rendort.",

  // Renard
  "Renard - réveil":                    "Le Renard ouvre les yeux. Il va flairer les esprits.",
  "Renard - résultat loup":             "L'un d'eux cache sa véritable nature. Votre flair est intact.",
  "Renard - résultat aucun loup":       "Aucun loup parmi eux. Votre instinct vous abandonne.",
  "Renard - sommeil":                   "Le Renard referme les yeux et se rendort.",

  // Cupidon
  "Cupidon - réveil":                    "Cupidon s'éveille. Il va tisser les liens du destin.",
  "Cupidon - premier amoureux":          "Désignez le premier lié.",
  "Cupidon - second amoureux":           "Désignez le second lié.",
  "Cupidon - sommeil":                   "Cupidon referme ses ailes et se rendort.",

  // Couple
  "Village - consulter rôle":            "Tout le village se reveilles afin de prendre connaissance des rôles.",
  "Couple - réveil":                     "Les liés ouvrent les yeux et se reconnaissent.",
  "Couple - sommeil":                    "Les liés se rendorment, gardant ce secret au fond d'eux.",
  "Lié - mort chagrin":                  "était lié.",

  // Vote du village
  "Vote - ouverture":                    "Le village se réunit. Il est temps de désigner un coupable.",
  "Vote - avertissement timeout":        "Le temps presse. Chaque seconde compte.",
  "Vote - ouverture avec timer":         "Le village se réunit. {duration}",
  "Vote - temps écoulé":                 "Le temps est écoulé. Le village n'a pu se décider. Personne n'est éliminé.",
  "Vote - pas de majorité":              "Aucune majorité. Le village doit revoter.",
  "Vote - vote blanc":                   "Le village choisit l'abstention. Personne n'est éliminé.",
  "Vote - élimination":                  "est chassé du village !",

  // Annonces nocturnes
  "Nuit - aucun mort":                   "Le village respire. Cette nuit, personne n'a péri.",
  "Nuit - joueur tué":                   "a été retrouvé sans vie à l'aube.",

  // Vote du maire
  "Vote - maire":                        "Avant tout, le village doit choisir son maire.",
  "Vote - maire égalité":                "Égalité ! Le village doit départager ses candidats.",
  "Vote - maire élu":                    "est proclamé maire du village !",

  // Succession du maire
  "Maire - mort successeur":             "Le maire a quitté ce monde. Son dernier acte sera de désigner son successeur.",
  "Maire - successeur désigné":          "reprend l'écharpe de maire.",

  // Fin de partie
  "Victoire ange":                        "L'Ange s'envole victorieux. Le village a condamné son sauveur.",
  "Victoire villageois":                 "Les loups sont éliminés. Le village peut enfin dormir en paix.",
  "Victoire loups garous":               "Les loups règnent sur le village. Les villageois ont succombé.",
  "Victoire couple":                     "Les liés sont les derniers survivants. L'amour a triomphé.",

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
