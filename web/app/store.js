// Everything that survives a reload lives in localStorage: settings, saved servers, and which
// channels are collapsed. Plain JSON, one key each.

function load(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? 'null') } ?? fallback; } catch { return fallback; }
}
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

export const settings = load('mutter.settings', {
  theme: 'midnight', transmitMode: 'vad', vadThresholdDb: -38, autoSensitivity: true, bitrate: 40_000, inputDeviceId: '',
  shareAudio: true, turn: { url: '', username: '', credential: '' },
});
export const saveSettings = () => save('mutter.settings', settings);

/// Saved servers, most recently used first. `password` is kept only if the user asked.
export const servers = (() => { try { return JSON.parse(localStorage.getItem('mutter.servers') ?? '[]'); } catch { return []; } })();
export function rememberServer(target) {
  const key = s => `${s.host}:${s.port}`;
  const i = servers.findIndex(s => key(s) === key(target));
  if (i >= 0) servers.splice(i, 1);
  servers.unshift({ host: target.host, port: target.port, username: target.username, password: target.remember ? target.password : undefined, lastUsed: Date.now() });
  if (servers.length > 12) servers.length = 12;
  save('mutter.servers', servers);
}
export function forgetServer(host, port) {
  const i = servers.findIndex(s => s.host === host && s.port === port);
  if (i >= 0) { servers.splice(i, 1); save('mutter.servers', servers); }
}

export function collapsedFor(host) {
  const all = load('mutter.collapsed', {});
  const set = new Set(all[host] ?? []);
  return { set, save() { all[host] = [...set]; save('mutter.collapsed', all); } };
}
