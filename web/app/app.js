// Mutter Web. Wires the session (client.js) and voice (audio.js) to the page: connect screen,
// channel tree, chat, voice dock, settings. Speaks to the bridge over WebSocket; the bridge is
// a byte pipe, so everything Mumble happens in this tab.

import { MumbleClient } from './client.js';
import { AudioEngine } from './audio.js';
import { THEMES, applyTheme } from './themes.js';
import { settings, saveSettings, servers, rememberServer, forgetServer, collapsedFor } from './store.js';
import { sanitize, renderMessage, imageToHtml, escapeHtml, openViewer } from './chat.js';
import { ScreenShare } from './share.js';
import { mountStage } from './stage.js';
import { ICON } from './icons.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children); return e; };
const PALETTE = ['#3D9BFF', '#3DDC84', '#FF6B35', '#C084FC', '#2DD4A7', '#FFC53D', '#FF7AA2', '#A8E831'];
const colorFor = name => { let h = 5381; for (const ch of name ?? '') h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };

const client = new MumbleClient();
const audio = new AudioEngine(client, settings);
const share = new ScreenShare(client, settings);
const ui = { scope: null, collapsed: null, target: null, popover: null, statsFor: null, renderQueued: false, inSession: false };
window.mutter = { client, audio, share, settings };   // console + tests

applyTheme(settings.theme);
for (const [id, icon] of Object.entries({ settingsBtn: 'settings', leaveBtn: 'leave', newChannelBtn: 'plus', imageBtn: 'image', sendBtn: 'send', muteBtn: 'mic', deafBtn: 'headphones', shareBtn: 'screen', settingsClose: 'close' })) $(id).innerHTML = ICON[icon];
if (!AudioEngine.supported) $('unsupported').hidden = false;

// ---- connect screen ----

function renderSavedServers() {
  const list = $('savedServers');
  list.replaceChildren();
  list.hidden = !servers.length;
  for (const s of servers) {
    const row = el('li', { className: 'saved-row' });
    const main = el('button', { type: 'button', className: 'saved-main' },
      el('span', { className: 'saved-icon', innerHTML: ICON.server }),
      el('span', { className: 'saved-text' }, el('strong', {}, s.host + (s.port !== 64738 ? `:${s.port}` : '')), el('span', { className: 'sub' }, `as ${s.username}`)));
    main.onclick = () => { fillForm(s); if (s.password !== undefined || !needsPassword(s)) connect(readForm()); else $('password').focus(); };
    const del = el('button', { type: 'button', className: 'icon small', title: 'Forget', innerHTML: ICON.trash });
    del.onclick = () => { forgetServer(s.host, s.port); renderSavedServers(); };
    row.append(main, del);
    list.append(row);
  }
}
const needsPassword = () => false;
function fillForm(s) { $('host').value = s.host ?? ''; $('port').value = s.port ?? 64738; $('username').value = s.username ?? ''; $('password').value = s.password ?? ''; $('remember').checked = s.password !== undefined; }
function readForm() {
  return { host: $('host').value.trim(), port: Number($('port').value) || 64738, username: $('username').value.trim(), password: $('password').value || undefined, remember: $('remember').checked };
}
renderSavedServers();
fillForm(servers[0] ?? { host: '', port: 64738, username: '' });

$('connectForm').addEventListener('submit', e => { e.preventDefault(); connect(readForm()); });

async function connect(target) {
  if (!target.host || !target.username) return;
  showError(null);
  ui.target = target;
  ui.collapsed = collapsedFor(target.host);
  rememberServer(target);
  renderSavedServers();
  $('serverLabel').textContent = target.port === 64738 ? target.host : `${target.host}:${target.port}`;
  $('serverInfo').hidden = false;
  $('connectBtn').disabled = true;
  client.connect(target);
  // Started inside the click so the AudioContext is allowed to run; the mic prompt appears now.
  if (AudioEngine.supported) {
    try { await audio.start({ source: new URLSearchParams(location.search).get('source') === 'tone' ? 'tone' : undefined }); }
    catch (e) { toast(`Audio failed: ${e.message}`, 'warn'); client._diag('audio', `start failed: ${e.stack}`); }
  }
}

function leave() { client.disconnect(); audio.stop(); }
$('leaveBtn').onclick = leave;
$('overlayLeave').onclick = leave;

function showError(text) { $('error').hidden = !text; $('error').textContent = text ?? ''; }

// ---- screens ----

function showScreen(name) {
  ui.inSession = name === 'session';
  $('connect').hidden = ui.inSession;
  $('session').hidden = !ui.inSession;
  $('dock').hidden = !ui.inSession;
  $('leaveBtn').hidden = !ui.inSession;
  if (!ui.inSession) { $('overlay').hidden = true; $('pingPill').hidden = true; closePopover(); }
}

client.addEventListener('state', () => {
  const s = client.state;
  const label = { disconnected: 'Not connected', connecting: 'Connecting…', authenticating: 'Signing in…', connected: 'Connected', reconnecting: 'Reconnecting…' }[s];
  $('stateText').textContent = label;
  $('dot').className = `dot ${s === 'connected' ? 'on' : s === 'disconnected' ? '' : 'wait'}`;
  $('connectBtn').disabled = s !== 'disconnected';
  $('connectBtn').textContent = s === 'disconnected' ? 'Connect' : label;
  if (s === 'connected') {
    if (!ui.inSession) { showScreen('session'); $('messages').replaceChildren(); for (const m of client.messages) appendMessage(m); $('chatInput').focus(); }
    $('overlay').hidden = true;
    ui.scope = null;
    audio.resync();
    scheduleRender();
  } else if (s === 'reconnecting') {
    $('overlay').hidden = false;
    $('overlayText').textContent = `Reconnecting to ${ui.target?.host}…`;
  } else if (s === 'disconnected') {
    if (ui.inSession) { showScreen('connect'); audio.stop(); }
    $('serverInfo').hidden = !ui.inSession && !ui.target;
    $('stateText').textContent = 'Not connected';
  }
});
client.addEventListener('error', e => { showError(e.detail); });
client.addEventListener('stats', () => { $('pingPill').hidden = false; $('pingPill').textContent = `${client.stats.tcpPingMs} ms`; });

// ---- channel tree ----

client.addEventListener('channels', scheduleRender);
client.addEventListener('users', scheduleRender);
// Coalesces the burst of UserState/ChannelState events in one socket message into one render.
// A microtask, not requestAnimationFrame: background tabs stop animating but still get messages.
function scheduleRender() { if (ui.renderQueued) return; ui.renderQueued = true; queueMicrotask(() => { ui.renderQueued = false; if (ui.inSession) { renderTree(); renderDock(); renderChatTitle(); } }); }

function renderTree() {
  const root = client.rootChannel;
  const frag = document.createDocumentFragment();
  if (root) renderChannel(root, 0, frag);
  $('tree').replaceChildren(frag);
}

function subtreeCount(c) { let n = client.usersIn(c.channelId).length; for (const k of client.children(c.channelId)) n += subtreeCount(k); return n; }

function renderChannel(c, depth, into) {
  const users = client.usersIn(c.channelId), kids = client.children(c.channelId);
  const collapsed = ui.collapsed.set.has(c.channelId) && c.channelId !== client.myChannel?.channelId;
  const current = c.channelId === client.myChannel?.channelId;
  const row = el('div', { className: `ch${current ? ' current' : ''}${collapsed ? ' collapsed' : ''}`, role: 'treeitem' });
  row.style.setProperty('--depth', depth);
  const disc = el('button', { type: 'button', className: `disc${users.length || kids.length ? '' : ' empty'}`, innerHTML: ICON.chevron, tabIndex: -1 });
  disc.onclick = e => { e.stopPropagation(); if (ui.collapsed.set.has(c.channelId)) ui.collapsed.set.delete(c.channelId); else ui.collapsed.set.add(c.channelId); ui.collapsed.save(); renderTree(); };
  const n = subtreeCount(c);
  row.append(disc, el('span', { className: 'name', textContent: c.name ?? '…' }), el('span', { className: 'count', textContent: n ? String(n) : '' }));
  if (!current) {
    const join = el('button', { type: 'button', className: 'join', title: 'Join', innerHTML: ICON.join });
    join.onclick = e => { e.stopPropagation(); client.joinChannel(c.channelId); };
    row.append(join);
  }
  row.onclick = () => channelPopover(row, c);
  into.append(row);
  if (collapsed) return;
  for (const u of users) into.append(userRow(u, depth + 1));
  for (const k of kids) renderChannel(k, depth + 1, into);
}

function userRow(u, depth) {
  const me = u.session === client.me;
  const row = el('div', { className: `user${me ? ' me' : ''}${u.talking || (me && audio.isTransmitting) ? ' talking' : ''}`, role: 'treeitem' });
  row.dataset.session = u.session;
  row.style.setProperty('--depth', depth);
  row.append(avatar(u), el('span', { className: 'name', textContent: u.name ?? '…' }));
  const badges = el('span', { className: 'badges' });
  if (u.prioritySpeaker) badges.append(badge('star', 'Priority speaker'));
  if (u.selfDeaf || u.deaf) badges.append(badge('headphonesOff', u.deaf ? 'Deafened by server' : 'Deafened'));
  else if (u.selfMute || u.mute || u.suppress) badges.append(badge('micOff', u.mute ? 'Muted by server' : u.suppress ? 'Suppressed' : 'Muted'));
  if (u.localMute) badges.append(badge('volumeOff', 'Muted for you'));
  if (share.available.has(u.session) || (me && share.sharing)) {
    const b = badge('screen', me ? 'You are sharing your screen' : 'Sharing screen — click to watch');
    b.classList.add('live');
    if (!me) b.onclick = e => { e.stopPropagation(); share.watch(u.session); };
    badges.append(b);
  }
  row.append(badges);
  row.onclick = () => userPopover(row, u);
  return row;
}
const badge = (icon, title) => el('span', { className: 'badge', title, innerHTML: ICON[icon] });
function avatar(u, big = false) {
  const a = el('span', { className: `avatar${big ? ' big' : ''}`, textContent: (u.name ?? '?').trim()[0]?.toUpperCase() ?? '?' });
  a.style.background = colorFor(u.name);
  return a;
}

client.addEventListener('talking', e => { for (const r of document.querySelectorAll(`[data-session="${e.detail.session}"]`)) r.classList.toggle('talking', e.detail.talking); });

// ---- popovers ----

function openPopover(anchor, build) {
  closePopover();
  const pop = $('popover');
  pop.replaceChildren();
  build(pop);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - pw - 12), top = r.bottom + 6;
  if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 6);
  pop.style.left = `${Math.max(12, left)}px`; pop.style.top = `${top}px`;
  ui.popover = { anchor };
}
function closePopover() { $('popover').hidden = true; ui.popover = null; ui.statsFor = null; }
document.addEventListener('pointerdown', e => { const pop = $('popover'); if (!pop.hidden && !pop.contains(e.target) && !ui.popover?.anchor.contains(e.target)) closePopover(); });

function channelPopover(anchor, c) {
  openPopover(anchor, pop => {
    pop.append(el('h3', { textContent: c.name }));
    if (c.description) { const d = el('div', { className: 'desc' }); d.append(sanitize(c.description)); pop.append(d); }
    const meta = [];
    if (c.temporary) meta.push('temporary');
    if (c.maxUsers) meta.push(`up to ${c.maxUsers}`);
    if (meta.length) pop.append(el('p', { className: 'hint', textContent: meta.join(' · ') }));
    const actions = el('div', { className: 'actions' });
    if (c.channelId !== client.myChannel?.channelId) actions.append(action('join', 'Join', () => { client.joinChannel(c.channelId); closePopover(); }));
    actions.append(action('message', 'Message here', () => { setScope({ channelId: c.channelId }); closePopover(); }));
    actions.append(action('message', 'Message tree', () => { setScope({ treeId: c.channelId }); closePopover(); }));
    actions.append(action('plus', 'New channel inside', () => { closePopover(); newChannel(c.channelId); }));
    pop.append(actions);
  });
}

function userPopover(anchor, u) {
  const me = u.session === client.me;
  openPopover(anchor, pop => {
    const head = el('div', { className: 'user-head' }, avatar(u, true), el('div', {}, el('h3', { textContent: u.name }), el('p', { className: 'hint', textContent: `${me ? 'You · ' : ''}${client.channels.get(u.channelId)?.name ?? ''}` })));
    pop.append(head);
    if (u.comment) { const d = el('div', { className: 'desc' }); d.append(sanitize(u.comment)); pop.append(d); }
    if (!me) {
      const actions = el('div', { className: 'actions' });
      actions.append(action('message', 'Message', () => { setScope({ sessions: [u.session] }); closePopover(); $('chatInput').focus(); }));
      actions.append(action(u.localMute ? 'volume' : 'volumeOff', u.localMute ? 'Unmute for me' : 'Mute for me', () => { audio.setUserLocalMute(u.session, !u.localMute); closePopover(); scheduleRender(); }));
      pop.append(actions);
      const vol = el('input', { type: 'range', min: 0, max: 200, value: Math.round((u.localVolume ?? 1) * 100) });
      const volLabel = el('span', { className: 'hint', textContent: `${vol.value}%` });
      vol.oninput = () => { audio.setUserVolume(u.session, vol.value / 100); volLabel.textContent = `${vol.value}%`; };
      pop.append(el('div', { className: 'row between' }, el('span', { className: 'hint', textContent: 'Volume' }), volLabel), vol);
    }
    const stats = el('p', { className: 'hint stats', textContent: '…' });
    pop.append(stats);
    ui.statsFor = { session: u.session, el: stats };
    client.requestStats(u.session);
  });
}
const action = (icon, label, fn) => { const b = el('button', { type: 'button', className: 'action', innerHTML: `${ICON[icon]}<span>${label}</span>` }); b.onclick = fn; return b; };

client.addEventListener('user-stats', e => {
  const m = e.detail;
  if (ui.statsFor?.session !== m.session) return;
  const parts = [];
  if (m.onlineSecs !== undefined) parts.push(`online ${fmtDuration(m.onlineSecs)}`);
  if (m.idleSecs) parts.push(`idle ${fmtDuration(m.idleSecs)}`);
  if (m.bandwidth) parts.push(`${Math.round(m.bandwidth / 1000)} kbit/s`);
  if (m.tcpPackets !== undefined && !m.udpPackets) parts.push('TCP only');
  ui.statsFor.el.textContent = parts.join(' · ') || 'No stats';
});
const fmtDuration = s => s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;

function newChannel(parent = client.myChannel?.channelId ?? 0) {
  const name = prompt('Channel name');
  if (name?.trim()) client.createChannel(parent, name.trim(), true);
}
$('newChannelBtn').onclick = () => newChannel();

// ---- chat ----

function sendScope() { return ui.scope ?? { channelId: client.myChannel?.channelId ?? 0 }; }
function setScope(scope) { ui.scope = scope; renderChatTitle(); }
$('scopePill').onclick = () => setScope(null);

function renderChatTitle() {
  const scope = sendScope();
  let title = client.channels.get(scope.channelId)?.name ?? 'Chat';
  let pill = null;
  if (scope.sessions) { const u = client.users.get(scope.sessions[0]); title = u?.name ?? 'Direct'; pill = 'direct'; if (!u) ui.scope = null; }
  else if (scope.treeId !== undefined) { title = client.channels.get(scope.treeId)?.name ?? 'Chat'; pill = 'and below'; }
  else if (ui.scope) pill = 'other channel';
  $('chatTitle').textContent = title;
  $('scopePill').hidden = !pill;
  $('scopePill').textContent = pill ? `${pill} ×` : '';
  $('chatInput').placeholder = scope.sessions ? `Message ${title}` : `Message #${title}`;
}

function appendMessage(m) {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(renderMessage(m, { myChannelId: client.myChannel?.channelId ?? 0, channels: client.channels, onImage: openViewer }));
  while (box.children.length > 500) box.firstChild.remove();
  if (atBottom || m.own) box.scrollTop = box.scrollHeight;
}
client.addEventListener('text', e => { if (ui.inSession) appendMessage(e.detail); });

$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  if (client.sendText(escapeHtml(text).replace(/\n/g, '<br>'), sendScope())) $('chatInput').value = '';
});
$('imageBtn').onclick = () => $('imageInput').click();
$('imageInput').onchange = () => { const f = $('imageInput').files[0]; if (f) sendImage(f); $('imageInput').value = ''; };
$('chatInput').addEventListener('paste', e => { const f = [...e.clipboardData.items].find(i => i.type.startsWith('image/'))?.getAsFile(); if (f) { e.preventDefault(); sendImage(f); } });
$('messages').addEventListener('dragover', e => e.preventDefault());
$('messages').addEventListener('drop', e => { e.preventDefault(); const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/')); if (f) sendImage(f); });
async function sendImage(file) {
  try { client.sendText(await imageToHtml(file, client.serverInfo.imageMessageLength ?? 131_072), sendScope()); }
  catch (e) { toast(e.message, 'warn'); }
}
$('viewer').onclick = () => { $('viewer').hidden = true; };

// ---- voice dock ----

function renderDock() {
  const me = client.myUser;
  if (!me) return;
  $('meAvatar').replaceWith(Object.assign(avatar(me, true), { id: 'meAvatar' }));
  $('meAvatar').dataset.session = client.me;
  $('meAvatar').classList.toggle('talking', audio.isTransmitting);
  $('meName').textContent = me.name;
  $('meChannel').textContent = client.myChannel?.name ?? '';
  renderVoiceState();
}

function renderVoiceState() {
  $('muteBtn').innerHTML = ICON[audio.muted ? 'micOff' : 'mic'];
  $('muteBtn').classList.toggle('active', audio.muted);
  $('muteBtn').title = audio.muted ? 'Unmute' : 'Mute';
  $('deafBtn').innerHTML = ICON[audio.deafened ? 'headphonesOff' : 'headphones'];
  $('deafBtn').classList.toggle('active', audio.deafened);
  $('deafBtn').title = audio.deafened ? 'Undeafen' : 'Deafen';
  const mode = settings.transmitMode;
  $('pttBtn').hidden = mode !== 'ptt';
  $('meter').classList.toggle('muted', audio.muted);
  $('meterLabel').textContent = audio.captureError ?? (audio.muted ? 'Muted' : mode === 'continuous' ? 'Always on' : mode === 'ptt' ? 'Hold Space' : '');
  $('meter').classList.toggle('warn', !!audio.captureError);
  $('meAvatar').classList.toggle('talking', audio.isTransmitting);
  $('pttBtn').classList.toggle('active', audio.pttPressed);
  $('micStatus').textContent = audio.captureError ? `${audio.captureError}. Check the site permissions in the address bar.` : '';
}
audio.addEventListener('state', renderVoiceState);
audio.addEventListener('transmit', () => { renderVoiceState(); const row = document.querySelector(`.user[data-session="${client.me}"]`); row?.classList.toggle('talking', audio.isTransmitting); });
audio.addEventListener('level', () => {
  const pct = db => Math.max(0, Math.min(100, (db + 70) / 60 * 100));
  const level = pct(audio.inputLevelDb), mark = pct(audio.thresholdDb);
  $('meterFill').style.width = `${level}%`;
  $('meterFill').classList.toggle('open', audio.isTransmitting);
  $('meterMark').style.left = `${mark}%`;
  $('meterMark').hidden = settings.transmitMode !== 'vad';
  if (!$('settings').hidden) { $('sMeterFill').style.width = `${level}%`; $('sMeterMark').style.left = `${mark}%`; $('thresholdLabel').textContent = `${Math.round(audio.thresholdDb)} dB${settings.autoSensitivity ? ' auto' : ''}`; }
});

$('muteBtn').onclick = () => audio.setMuted(!audio.muted);
$('deafBtn').onclick = () => audio.setDeafened(!audio.deafened);

// ---- screen share ----

$('shareBtn').hidden = !ScreenShare.supported;
$('shareBtn').onclick = async () => {
  if (share.sharing) return share.stop();
  try { await share.start(); }
  catch (e) { if (e.name !== 'NotAllowedError') toast(`Can't share: ${e.message}`, 'warn'); }
};
share.addEventListener('state', () => {
  $('shareBtn').classList.toggle('active', !!share.sharing);
  $('shareBtn').innerHTML = ICON[share.sharing ? 'screenOff' : 'screen'];
  $('shareBtn').title = share.sharing ? 'Stop sharing' : 'Share screen';
  scheduleRender();
});
share.addEventListener('available', scheduleRender);
mountStage({ share, client, stage: $('stage'), session: $('session'), toast });
for (const ev of ['pointerdown']) $('pttBtn').addEventListener(ev, e => { e.preventDefault(); audio.setPTT(true); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('pttBtn').addEventListener(ev, () => audio.setPTT(false));

const isTyping = e => /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closePopover(); $('viewer').hidden = true; if (!$('settings').hidden) toggleSettings(false); return; }
  if (e.code === 'Space' && !isTyping(e) && ui.inSession) { e.preventDefault(); if (!e.repeat) audio.setPTT(true); }
});
window.addEventListener('keyup', e => { if (e.code === 'Space' && audio.pttPressed) { e.preventDefault(); audio.setPTT(false); } });
window.addEventListener('blur', () => audio.setPTT(false));

// ---- settings ----

function toggleSettings(open = $('settings').hidden) { $('settings').hidden = !open; if (open) renderSettings(); }
$('settingsBtn').onclick = () => toggleSettings();
$('settingsClose').onclick = () => toggleSettings(false);

function segmented(id, value, onChange) {
  for (const b of $(id).querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.value === String(value));
    b.onclick = () => { onChange(b.dataset.value); segmented(id, b.dataset.value, onChange); saveSettings(); renderVoiceState(); renderSettings(); };
  }
}

async function renderSettings() {
  segmented('transmitMode', settings.transmitMode, v => { settings.transmitMode = v; });
  $('transmitHint').textContent = { vad: 'Sends when you speak. Space also talks.', ptt: 'Hold Space or the Talk button.', continuous: 'Always sending while unmuted.' }[settings.transmitMode];
  segmented('bitrate', settings.bitrate, v => audio.setBitrate(Number(v)));
  $('autoSens').checked = settings.autoSensitivity;
  $('threshold').value = settings.vadThresholdDb;
  $('threshold').disabled = settings.autoSensitivity;
  $('thresholdLabel').textContent = `${Math.round(audio.thresholdDb)} dB${settings.autoSensitivity ? ' auto' : ''}`;
  const swatches = $('themes');
  swatches.replaceChildren(...Object.entries(THEMES).map(([name, t]) => {
    const b = el('button', { type: 'button', className: `swatch${settings.theme === name ? ' on' : ''}`, title: t.title });
    b.style.setProperty('--sw-bg', t.bg); b.style.setProperty('--sw-accent', t.accent);
    b.onclick = () => { settings.theme = name; saveSettings(); applyTheme(name); renderSettings(); };
    return b;
  }));
  $('turnUrl').value = settings.turn.url; $('turnUser').value = settings.turn.username; $('turnPass').value = settings.turn.credential;
  const devices = await audio.inputDevices();
  const sel = $('micSelect');
  sel.replaceChildren(el('option', { value: '', textContent: 'Default microphone' }), ...devices.map((d, i) => el('option', { value: d.deviceId, textContent: d.label || `Microphone ${i + 1}` })));
  sel.value = devices.some(d => d.deviceId === settings.inputDeviceId) ? settings.inputDeviceId : '';
  renderVoiceState();
}
$('autoSens').onchange = () => { settings.autoSensitivity = $('autoSens').checked; saveSettings(); renderSettings(); };
$('threshold').oninput = () => { settings.vadThresholdDb = Number($('threshold').value); saveSettings(); $('thresholdLabel').textContent = `${settings.vadThresholdDb} dB`; };
$('micSelect').onchange = async () => { await audio.setInputDevice($('micSelect').value); saveSettings(); };
for (const [id, key] of [['turnUrl', 'url'], ['turnUser', 'username'], ['turnPass', 'credential']]) $(id).onchange = () => { settings.turn[key] = $(id).value.trim(); saveSettings(); };

$('diagBtn').onclick = () => { const d = $('diag'); d.hidden = !d.hidden; $('diagBtn').textContent = d.hidden ? 'Show log' : 'Hide log'; renderDiag(); };
$('diagCopy').onclick = async () => { try { await navigator.clipboard.writeText(diagText()); toast('Log copied'); } catch { toast('Could not copy', 'warn'); } };
const diagText = () => client.log.map(l => `${l.date.toISOString()} [${l.tag}] ${l.message}`).join('\n');
function renderDiag() { if ($('diag').hidden) return; $('diag').textContent = diagText() || 'Nothing yet.'; $('diag').scrollTop = $('diag').scrollHeight; }
client.addEventListener('log', renderDiag);

// ---- toasts ----

client.addEventListener('notice', e => toast(e.detail.text, e.detail.kind));
function toast(text, kind = 'info') {
  const t = el('div', { className: `toast ${kind}`, textContent: text });
  $('toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'warn' ? 6000 : 3500);
  while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
}

// ---- boot ----

if (location.hash === '#auto' && servers[0]) connect(servers[0]);
