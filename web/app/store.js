import { normalizeSettings } from './preferences.js';

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
    if (Array.isArray(fallback)) return Array.isArray(stored) ? stored : fallback;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const settings = normalizeSettings(loadJson(SETTINGS_KEY, {}));
settings.turn.credential = restored.turn || settings.turn.credential;

export function saveSettings() {
  saveJson(SETTINGS_KEY, { ...settings, turn: { ...settings.turn, credential: '' } });
  return saveCredentials();
}

const savedServers = loadJson(SERVERS_KEY, []);
export const servers = [];
for (const server of savedServers) {
  if (!server || typeof server.host !== 'string' || !server.host.trim() ||
      !Number.isInteger(server.port) || server.port < 1 || server.port > 65535 ||
      typeof server.username !== 'string' || servers.some(saved => sameServer(saved, server))) continue;
  servers.push({
    host: server.host.trim(), port: server.port, username: server.username,
    password: typeof server.password === 'string' ? server.password : undefined,
    lastUsed: Number.isFinite(server.lastUsed) ? server.lastUsed : 0,
  });
  if (servers.length === MAX_SAVED_SERVERS) break;
}
for (const server of servers) {
  server.password = restored.servers[secretKey(server)] ?? server.password;
}

function secretKey(server) {
  return JSON.stringify([server.host.toLowerCase(), server.port, server.username]);
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
  return JSON.stringify([server.host.trim().toLowerCase(), Number(server.port)]);
}

export function sameServer(first, second) {
  return !!first && !!second && serverKey(first) === serverKey(second);
}

export function rememberServer(target) {
  const existing = servers.findIndex((server) => sameServer(server, target));
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
  const index = servers.findIndex((server) => sameServer(server, { host, port }));
  if (index >= 0) {
    servers.splice(index, 1);
    return saveServers();
  }
}

export function collapsedFor(host) {
  const all = loadJson(COLLAPSED_KEY, {});
  const set = new Set(Array.isArray(all[host]) ? all[host] : []);
  return {
    set,
    save() {
      all[host] = [...set];
      saveJson(COLLAPSED_KEY, all);
    },
  };
}
