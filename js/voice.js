/**
 * voice.js — Web Speech API wrapper.
 *
 * Exposes:
 *   say(text, overrides)   — speak text with current config + optional per-call overrides
 *   setVoiceConfig(partial) — update one or more config keys
 *   getVoiceConfig()        — read current config (returns a copy)
 *   getAvailableVoices()    — synchronous list of loaded voices
 *   onVoicesReady(callback) — fires callback(voices) once the voice list is available
 */

const voiceConfig = {
  voiceURI: null, // null = browser default
  pitch:    1,
  rate:     1,
  volume:   1,
};

function say(text, overrides = {}) {
  if (!window.speechSynthesis || !text) return;
  speechSynthesis.cancel();

  const cfg = { ...voiceConfig, ...overrides };
  const utt = new SpeechSynthesisUtterance(text);
  utt.pitch  = cfg.pitch;
  utt.rate   = cfg.rate;
  utt.volume = cfg.volume;

  if (cfg.voiceURI) {
    const voice = speechSynthesis.getVoices().find(v => v.voiceURI === cfg.voiceURI);
    if (voice) utt.voice = voice;
  }

  speechSynthesis.speak(utt);
}

function setVoiceConfig(partial) {
  Object.assign(voiceConfig, partial);
  dbSet('voice_config', { ...voiceConfig });
}

async function loadVoiceConfig() {
  const saved = await dbGet('voice_config');
  if (saved) Object.assign(voiceConfig, saved);
}

function getVoiceConfig() {
  return { ...voiceConfig };
}

function getAvailableVoices() {
  return window.speechSynthesis?.getVoices() ?? [];
}

// Voices load asynchronously in Chromium — always go through this helper.
function onVoicesReady(callback) {
  if (!window.speechSynthesis) return;
  const voices = getAvailableVoices();
  if (voices.length > 0) { callback(voices); return; }
  speechSynthesis.addEventListener('voiceschanged', () => callback(getAvailableVoices()), { once: true });
}
