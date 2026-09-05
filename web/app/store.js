import { DEFAULT_THEME } from './themes.js';

const SETTINGS_KEY = 'mutter.settings';
const SERVERS_KEY = 'mutter.servers';
const COLLAPSED_KEY = 'mutter.collapsed';
const MAX_SAVED_SERVERS = 12;

function loadJson(key, fallback) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
    return stored ?? fallback;
  } catch {
    return fallback;
  }
}

function loadObject(key, defaults) {
  return { ...defaults, ...loadJson(key, {}) };
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const settings = loadObject(SETTINGS_KEY, {
  theme: DEFAULT_THEME,
  transmitMode: 'vad',
  vadThresholdDb: -38,
  autoSensitivity: true,
  bitrate: 40_000,
  inputDeviceId: '',
  shareAudio: true,
  stun: 'stun:stun.l.google.com:19302',
  turn: { url: '', username: '', credential: '' },
});

export function saveSettings() {
  saveJson(SETTINGS_KEY, settings);
}

export const servers = loadJson(SERVERS_KEY, []);

function serverKey(server) {
  return `${server.host}:${server.port}`;
}

export function rememberServer(target) {
  const existing = servers.findIndex((server) => serverKey(server) === serverKey(target));
  if (existing >= 0) {
    servers.splice(existing, 1);
  }
  servers.unshift({
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.remember ? target.password : undefined,
    lastUsed: Date.now(),
  });
  if (servers.length > MAX_SAVED_SERVERS) {
    servers.length = MAX_SAVED_SERVERS;
  }
  saveJson(SERVERS_KEY, servers);
}

export function forgetServer(host, port) {
  const index = servers.findIndex((server) => server.host === host && server.port === port);
  if (index >= 0) {
    servers.splice(index, 1);
    saveJson(SERVERS_KEY, servers);
  }
}

export function collapsedFor(host) {
  const all = loadJson(COLLAPSED_KEY, {});
  const set = new Set(all[host] ?? []);
  return {
    set,
    save() {
      all[host] = [...set];
      saveJson(COLLAPSED_KEY, all);
    },
  };
}
