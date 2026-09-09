import { THEMES, DEFAULT_THEME } from './theme-data.js';

export const AUDIO_DEFAULTS = Object.freeze({
  transmitMode: 'vad',
  vadThresholdDb: -38,
  autoSensitivity: true,
  bitrate: 40_000,
  inputGain: 1,
  inputDeviceId: '',
  outputDeviceId: '',
  noiseSuppression: 'neural',
  processing: Object.freeze({ echo: true, noise: false, gain: true }),
});

const DEFAULTS = {
  ...AUDIO_DEFAULTS,
  pttKey: 'Space',
  showMembers: false,
  textSize: 14,
  shareAudio: true,
  stun: 'stun:stun.l.google.com:19302',
};

export function appearanceForSettings(settings) {
  if (['system', 'light', 'dark'].includes(settings.appearance)) return settings.appearance;
  return typeof settings.theme === 'string' && settings.theme ? (settings.theme === 'paper' ? 'light' : 'dark') : 'system';
}

export function themeName(value) {
  return typeof value === 'string' && Object.hasOwn(THEMES, value) ? value : DEFAULT_THEME;
}

export function normalizeSettings(value) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const settings = { ...saved };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = saved[key];
    settings[key] = typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value)) ? value : fallback;
  }
  settings.theme = themeName(saved.theme);
  settings.appearance = appearanceForSettings(saved);
  settings.processing = Object.fromEntries(Object.entries(AUDIO_DEFAULTS.processing)
    .map(([key, fallback]) => [key, typeof saved.processing?.[key] === 'boolean' ? saved.processing[key] : fallback]));
  settings.turn = Object.fromEntries(['url', 'username', 'credential']
    .map(key => [key, typeof saved.turn?.[key] === 'string' ? saved.turn[key] : '']));
  if (!['vad', 'ptt', 'continuous'].includes(settings.transmitMode)) settings.transmitMode = AUDIO_DEFAULTS.transmitMode;
  if (!saved.noiseV2 || !['off', 'light', 'strong', 'neural'].includes(settings.noiseSuppression)) {
    settings.noiseSuppression = AUDIO_DEFAULTS.noiseSuppression;
  }
  settings.noiseV2 = true;
  return settings;
}
