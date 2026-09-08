import { DEFAULT_THEME, appearanceForSettings } from './themes.js';

const SETTINGS_KEY = 'mutter.settings';
const SERVERS_KEY = 'mutter.servers';
const COLLAPSED_KEY = 'mutter.collapsed';
const CERTIFICATES_KEY = 'mutter.certificates';
const MAX_SAVED_SERVERS = 12;
export const credentialStorage = { available: false, notice: '' };
let restored = { servers: {}, turn: '' };
try {
  const result = await window.mutterCredentials?.read();
  if (result?.available) {
    credentialStorage.available = true;
    restored = result.value;
  }
  credentialStorage.notice = result?.error ?? '';
} catch {
  credentialStorage.notice = 'Saved passwords are unavailable. Reopen Mutter after unlocking secure storage.';
}
let lastSavedCredentials = JSON.stringify(restored);
let credentialWrites = Promise.resolve();

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
settings.appearance = appearanceForSettings(loadJson(SETTINGS_KEY, {}));
settings.turn = { url: '', username: '', credential: '', ...settings.turn };
settings.turn.credential = restored.turn || settings.turn.credential;

export function saveSettings() {
  saveJson(SETTINGS_KEY, { ...settings, turn: { ...settings.turn, credential: '' } });
  return saveCredentials();
}

const savedServers = loadJson(SERVERS_KEY, []);
export const servers = (Array.isArray(savedServers) ? savedServers : []).slice(0, MAX_SAVED_SERVERS);
for (const server of servers) {
  server.password = restored.servers[secretKey(server)] ?? server.password;
}

function secretKey(server) {
  return JSON.stringify([server.host?.toLowerCase(), Number(server.port), server.username]);
}

function saveServers() {
  saveJson(SERVERS_KEY, servers.map(({ password, ...server }) => server));
  return saveCredentials();
}

function saveCredentials() {
  if (!credentialStorage.available) return credentialWrites;
  const value = {
    servers: Object.fromEntries(servers.filter(server => typeof server.password === 'string').map(server => [secretKey(server), server.password])),
    turn: settings.turn.credential,
  };
  const encoded = JSON.stringify(value);
  if (encoded === lastSavedCredentials) return credentialWrites;
  lastSavedCredentials = encoded;
  credentialWrites = credentialWrites.then(async () => {
    if (!credentialStorage.available) return;
    try { await window.mutterCredentials.write(value); }
    catch {
      credentialStorage.available = false;
      credentialStorage.notice = 'Passwords could not be saved securely. They will stay available for this session.';
      window.dispatchEvent(new Event('mutter-credential-storage'));
    }
  });
  return credentialWrites;
}

export function flushCredentials() { return credentialWrites; }

saveSettings();
saveServers();

function certificateKey(host, port) {
  return JSON.stringify([host.toLowerCase(), Number(port)]);
}

export function certificateFor(host, port) {
  return loadJson(CERTIFICATES_KEY, {})[certificateKey(host, port)];
}

export function rememberCertificate({ host, port, fingerprint }) {
  const certificates = loadJson(CERTIFICATES_KEY, {});
  certificates[certificateKey(host, port)] = fingerprint;
  saveJson(CERTIFICATES_KEY, certificates);
}

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
  return saveServers();
}

export function forgetServer(host, port) {
  const index = servers.findIndex((server) => server.host === host && server.port === port);
  if (index >= 0) {
    servers.splice(index, 1);
    return saveServers();
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
