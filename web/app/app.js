// Mutter Web. The iPhone app's session in a small window: a header, one pane at a time
// (Channels, Chat, Server, Screen) behind a tab strip, and the voice dock — two columns when
// the window is wide enough. Speaks to the bridge over WebSocket; the bridge is a byte pipe,
// so everything Mumble happens in this tab.

import { MumbleClient } from './client.js';
import { AudioEngine } from './audio.js';
import { ScreenShare } from './share.js';
import { mountStage } from './stage.js';
import { THEMES, applyTheme } from './themes.js';
import { settings, saveSettings, servers, rememberServer, forgetServer, collapsedFor } from './store.js';
import { sanitize, renderMessage, imageToHtml, escapeHtml, openViewer } from './chat.js';
import { $, el, avatar } from './ui.js';
import { ICON } from './icons.js';

const client = new MumbleClient();
const audio = new AudioEngine(client, settings);
const share = new ScreenShare(client, settings);
const ui = { scope: null, collapsed: null, target: null, popover: null, statsFor: null, renderQueued: false, inSession: false, filter: '', unread: 0 };
const wide = matchMedia('(min-width: 880px)');
window.mutter = { client, audio, share, settings };   // console + tests

applyTheme(settings.theme);
for (const [id, icon] of Object.entries({ leaveBtn: 'leave', newChannelBtn: 'plus', imageBtn: 'image', sendBtn: 'send', muteBtn: 'mic', deafBtn: 'headphones', shareBtn: 'screen', settingsBtn: 'settings', settingsClose: 'close' })) $(id).innerHTML = ICON[icon];
document.querySelector('.search-icon').innerHTML = ICON.search;
document.querySelector('#scopePill .chev').innerHTML = ICON.chevron;
for (const [tab, icon] of [['channels', 'channels'], ['chat', 'message'], ['screen', 'screen'], ['server', 'server']]) $('tabs').querySelector(`[data-tab="${tab}"] i`).innerHTML = ICON[icon];
if (!AudioEngine.supported) $('unsupported').hidden = false;

// ---- tabs ----

function showTab(name) {
  if (name === 'channels' && wide.matches) name = 'chat';
  document.body.dataset.tab = name;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === name);
  if (name === 'chat' || (wide.matches && name === 'channels')) { ui.unread = 0; $('unread').hidden = true; }
  if (name === 'chat') { const box = $('messages'); box.scrollTop = box.scrollHeight; }
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
wide.addEventListener('change', () => showTab(document.body.dataset.tab));
const chatVisible = () => ui.inSession && (document.body.dataset.tab === 'chat' || (wide.matches && document.body.dataset.tab === 'channels'));

// ---- connect screen ----

function renderSavedServers() {
  const list = $('savedServers');
  list.replaceChildren();
  list.hidden = !servers.length;
  for (const s of servers) {
    const main = el('button', { type: 'button', className: 'saved-main' },
      el('span', { className: 'saved-icon', innerHTML: ICON.server }),
      el('span', { className: 'saved-text' }, el('strong', {}, s.host + (s.port !== 64738 ? `:${s.port}` : '')), el('span', { className: 'sub' }, `as ${s.username}`)));
    main.onclick = () => { fillForm(s); connect(readForm()); };
    const del = el('button', { type: 'button', className: 'icon small', title: 'Forget', innerHTML: ICON.trash });
    del.onclick = () => { forgetServer(s.host, s.port); renderSavedServers(); };
    list.append(el('li', { className: 'saved-row' }, main, del));
  }
}
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
  $('title').textContent = target.port === 64738 ? target.host : `${target.host}:${target.port}`;
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

// ---- screens and connection state ----

function showScreen(name) {
  ui.inSession = name === 'session';
  $('connect').hidden = ui.inSession;
  $('session').hidden = !ui.inSession;
  $('dock').hidden = !ui.inSession;
  $('leaveBtn').hidden = !ui.inSession;
  if (!ui.inSession) { $('overlay').hidden = true; $('pingPill').hidden = true; $('title').textContent = 'Mutter'; closePopover(); }
}

client.addEventListener('state', () => {
  const s = client.state;
  const label = { disconnected: 'Not connected', connecting: 'Connecting…', authenticating: 'Signing in…', connected: 'Connected', reconnecting: 'Reconnecting…' }[s];
  $('dot').className = `dot ${s === 'connected' ? 'on' : s === 'disconnected' ? '' : 'wait'}`;
  $('connectBtn').disabled = s !== 'disconnected';
  $('connectBtn').textContent = s === 'disconnected' ? 'Connect' : label;
  if (s === 'connected') {
    if (!ui.inSession) {
      showScreen('session');
      showTab(wide.matches ? 'chat' : 'channels');
      $('messages').replaceChildren();
      for (const m of client.messages) appendMessage(m);
    }
    $('overlay').hidden = true;
    ui.scope = null;
    audio.resync();
    scheduleRender();
  } else if (s === 'reconnecting') {
    $('overlay').hidden = false;
    $('overlayText').textContent = `Reconnecting to ${ui.target?.host}…`;
    renderSubtitle();
  } else if (s === 'disconnected') {
    if (ui.inSession) { showScreen('connect'); audio.stop(); }
    renderSubtitle();
  } else renderSubtitle();
});
client.addEventListener('error', e => showError(e.detail));
client.addEventListener('stats', () => {
  const ms = client.stats.tcpPingMs;
  $('pingPill').hidden = false; $('pingPill').textContent = `${ms} ms`; $('pingPill').classList.toggle('slow', ms > 150);
});

function renderSubtitle() {
  if (!client.isConnected) { $('subtitle').textContent = { connecting: 'Connecting…', authenticating: 'Signing in…', reconnecting: 'Reconnecting…' }[client.state] ?? 'Not connected'; return; }
  const n = client.users.size;
  $('subtitle').textContent = `${n} online · in ${client.myChannel?.name ?? '—'}`;
}

// ---- channel tree ----

client.addEventListener('channels', scheduleRender);
client.addEventListener('users', scheduleRender);
// Coalesces the burst of UserState/ChannelState events in one socket message into one render.
// A microtask, not requestAnimationFrame: background tabs stop animating but still get messages.
function scheduleRender() { if (ui.renderQueued) return; ui.renderQueued = true; queueMicrotask(() => { ui.renderQueued = false; if (ui.inSession) { renderTree(); renderDock(); renderChatTitle(); renderSubtitle(); renderServerPane(); } }); }

$('search').addEventListener('input', () => { ui.filter = $('search').value.trim().toLowerCase(); renderTree(); });
$('search').addEventListener('keydown', e => { if (e.key === 'Escape') { $('search').value = ''; ui.filter = ''; renderTree(); } });

function renderTree() {
  const root = client.rootChannel;
  const frag = document.createDocumentFragment();
  if (root && ui.filter) renderFiltered(frag);
  else if (root) renderChannel(root, 0, frag);
  $('tree').replaceChildren(frag);
}

function renderFiltered(into) {
  const q = ui.filter;
  for (const c of [...client.channels.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) if ((c.name ?? '').toLowerCase().includes(q)) into.append(channelRow(c, 0, true));
  for (const u of [...client.users.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) if ((u.name ?? '').toLowerCase().includes(q)) into.append(userRow(u, 0, client.channels.get(u.channelId)?.name));
  if (!into.childNodes.length) into.append(el('p', { className: 'hint', textContent: 'Nothing matches.', style: 'padding: 8px 12px' }));
}

function subtreeCount(c) { let n = client.usersIn(c.channelId).length; for (const k of client.children(c.channelId)) n += subtreeCount(k); return n; }

function renderChannel(c, depth, into) {
  const users = client.usersIn(c.channelId), kids = client.children(c.channelId);
  const collapsed = ui.collapsed.set.has(c.channelId) && c.channelId !== client.myChannel?.channelId;
  into.append(channelRow(c, depth, false, collapsed, users.length + kids.length > 0));
  if (collapsed) return;
  for (const u of users) into.append(userRow(u, depth + 1));
  for (const k of kids) renderChannel(k, depth + 1, into);
}

function channelRow(c, depth, flat, collapsed = false, hasChildren = true) {
  const current = c.channelId === client.myChannel?.channelId;
  const row = el('div', { className: `ch${current ? ' current' : ''}${collapsed ? ' collapsed' : ''}`, role: 'treeitem' });
  row.style.setProperty('--depth', depth);
  const disc = el('button', { type: 'button', className: `disc${hasChildren && !flat ? '' : ' empty'}`, innerHTML: ICON.chevron, tabIndex: -1 });
  disc.onclick = e => { e.stopPropagation(); if (ui.collapsed.set.has(c.channelId)) ui.collapsed.set.delete(c.channelId); else ui.collapsed.set.add(c.channelId); ui.collapsed.save(); renderTree(); };
  const n = subtreeCount(c);
  row.append(disc, el('span', { className: 'hash', textContent: '#' }), el('span', { className: 'name', textContent: c.name ?? '…' }));
  if (n) row.append(el('span', { className: 'count', textContent: c.maxUsers ? `${n}/${c.maxUsers}` : String(n) }));
  if (!current) {
    const join = el('button', { type: 'button', className: 'join', title: 'Join', innerHTML: ICON.join });
    join.onclick = e => { e.stopPropagation(); client.joinChannel(c.channelId); };
    row.append(join);
  }
  row.onclick = () => channelPopover(row, c);
  return row;
}

function userStatus(u, me) {
  if (u.talking || (me && audio.isTransmitting)) return ['Speaking', 'speaking'];
  if (u.selfDeaf || u.deaf) return [u.deaf ? 'Deafened by server' : 'Deafened', 'warn'];
  if (u.selfMute || u.mute || u.suppress) return [u.mute ? 'Muted by server' : u.suppress ? 'Suppressed' : 'Muted', ''];
  if (u.localMute) return ['Muted for you', 'warn'];
  if (share.available.has(u.session) || (me && share.sharing)) return ['Sharing screen', 'live'];
  return ['', ''];
}

function userRow(u, depth, where) {
  const me = u.session === client.me;
  const talking = u.talking || (me && audio.isTransmitting);
  const row = el('div', { className: `user${me ? ' me' : ''}${talking ? ' talking' : ''}`, role: 'treeitem' });
  row.dataset.session = u.session;
  row.style.setProperty('--depth', depth);
  const av = avatar(u.name, 'm');
  if (u.selfDeaf || u.deaf) av.append(el('span', { className: 'over', innerHTML: ICON.headphonesOff }));
  else if (u.selfMute || u.mute || u.suppress) av.append(el('span', { className: 'over', innerHTML: ICON.micOff }));
  const name = el('span', { className: 'name' }, el('span', { textContent: u.name ?? '…' }));
  if (me) name.append(el('span', { className: 'you', textContent: 'you' }));
  if (u.prioritySpeaker) name.append(el('span', { className: 'star', title: 'Priority speaker', innerHTML: ICON.star }));
  const [text, cls] = userStatus(u, me);
  const status = el('span', { className: `status ${cls}`, textContent: where ? (text ? `${text} · #${where}` : `#${where}`) : text });
  row.append(av, el('span', { className: 'col' }, name, status));
  if (share.available.has(u.session)) {
    const b = el('button', { type: 'button', className: 'live-badge', title: 'Watch their screen', innerHTML: ICON.screen });
    b.onclick = e => { e.stopPropagation(); share.watch(u.session); showTab('screen'); };
    row.append(b);
  }
  row.onclick = () => userPopover(row, u);
  return row;
}

client.addEventListener('talking', e => {
  for (const r of document.querySelectorAll(`.user[data-session="${e.detail.session}"]`)) {
    r.classList.toggle('talking', e.detail.talking);
    const u = client.users.get(e.detail.session);
    if (u) { const [text, cls] = userStatus(u, u.session === client.me); const s = r.querySelector('.status'); s.textContent = text; s.className = `status ${cls}`; }
  }
  renderTalkers();
});

// ---- popovers ----

function openPopover(anchor, build) {
  closePopover();
  const pop = $('popover');
  pop.replaceChildren();
  build(pop);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - pw - 10), top = r.bottom + 6;
  if (top + ph > window.innerHeight - 10) top = Math.max(10, r.top - ph - 6);
  pop.style.left = `${Math.max(10, left)}px`; pop.style.top = `${top}px`;
  ui.popover = { anchor };
}
function closePopover() { $('popover').hidden = true; ui.popover = null; ui.statsFor = null; }
document.addEventListener('pointerdown', e => { const pop = $('popover'); if (!pop.hidden && !pop.contains(e.target) && !ui.popover?.anchor.contains(e.target)) closePopover(); });
const action = (icon, label, fn, on = false) => { const b = el('button', { type: 'button', className: `action${on ? ' on' : ''}`, innerHTML: `${ICON[icon]}<span>${label}</span>` }); b.onclick = fn; return b; };

function channelPopover(anchor, c) {
  openPopover(anchor, pop => {
    pop.append(el('h3', {}, el('span', { className: 'hash', textContent: '# ' }), c.name ?? ''));
    if (c.description) { const d = el('div', { className: 'desc' }); d.append(sanitize(c.description)); pop.append(d); }
    const meta = [];
    if (c.temporary) meta.push('temporary');
    if (c.maxUsers) meta.push(`up to ${c.maxUsers}`);
    if (meta.length) pop.append(el('p', { className: 'hint', textContent: meta.join(' · ') }));
    const actions = el('div', { className: 'actions' });
    if (c.channelId !== client.myChannel?.channelId) actions.append(action('join', 'Join', () => { client.joinChannel(c.channelId); closePopover(); }));
    actions.append(action('message', 'Message here', () => { setScope({ channelId: c.channelId }); closePopover(); showTab('chat'); }));
    actions.append(action('message', 'Message here and below', () => { setScope({ treeId: c.channelId }); closePopover(); showTab('chat'); }));
    actions.append(action('plus', 'New channel inside', () => { closePopover(); newChannel(c.channelId); }));
    pop.append(actions);
  });
}

function userPopover(anchor, u) {
  const me = u.session === client.me;
  openPopover(anchor, pop => {
    pop.append(el('div', { className: 'user-head' }, avatar(u.name, 'l'), el('div', {}, el('h3', { textContent: u.name }), el('p', { className: 'hint', textContent: `${me ? 'You · ' : ''}#${client.channels.get(u.channelId)?.name ?? ''}` }))));
    if (u.comment) { const d = el('div', { className: 'desc' }); d.append(sanitize(u.comment)); pop.append(d); }
    if (!me) {
      const actions = el('div', { className: 'actions' });
      actions.append(action('message', 'Message', () => { setScope({ sessions: [u.session] }); closePopover(); showTab('chat'); $('chatInput').focus(); }));
      actions.append(action(u.localMute ? 'volume' : 'volumeOff', u.localMute ? 'Unmute for me' : 'Mute for me', () => { audio.setUserLocalMute(u.session, !u.localMute); closePopover(); scheduleRender(); }));
      if (share.available.has(u.session)) actions.append(action('screen', 'Watch their screen', () => { share.watch(u.session); closePopover(); showTab('screen'); }));
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

function renderChatTitle() {
  const scope = sendScope(), pill = $('scopePill');
  let title = client.channels.get(scope.channelId)?.name ?? 'Chat', kind = '';
  if (scope.sessions) { const u = client.users.get(scope.sessions[0]); if (!u) { ui.scope = null; return renderChatTitle(); } title = u.name; kind = 'dm'; }
  else if (scope.treeId !== undefined) { title = `${client.channels.get(scope.treeId)?.name ?? 'Chat'} +`; kind = 'tree'; }
  $('chatTitle').textContent = title;
  pill.className = `scope ${kind}`;
  $('chatInput').placeholder = kind === 'dm' ? `Message ${title}` : 'Message';
}
$('scopePill').onclick = () => openPopover($('scopePill'), pop => {
  const cur = client.myChannel, scope = sendScope();
  pop.append(el('h3', { textContent: 'Send to' }));
  const actions = el('div', { className: 'actions' });
  actions.append(action('message', `#${cur?.name ?? 'channel'}`, () => { setScope(null); closePopover(); }, !ui.scope || (scope.channelId === cur?.channelId && scope.treeId === undefined && !scope.sessions)));
  actions.append(action('channels', `#${cur?.name ?? 'channel'} and below`, () => { setScope({ treeId: cur?.channelId ?? 0 }); closePopover(); }, scope.treeId === cur?.channelId));
  if (scope.sessions) actions.append(action('close', `Stop messaging ${client.users.get(scope.sessions[0])?.name ?? ''}`, () => { setScope(null); closePopover(); }));
  pop.append(actions, el('p', { className: 'hint', textContent: 'To message one person, tap them in Channels.' }));
});

function appendMessage(m) {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const prev = client.messages[client.messages.indexOf(m) - 1];
  box.append(renderMessage(m, { myChannelId: client.myChannel?.channelId ?? 0, channels: client.channels, onImage: openViewer, prev }));
  while (box.children.length > 500) box.firstChild.remove();
  if (atBottom || m.own) box.scrollTop = box.scrollHeight;
  if (!m.own && !m.scope?.system && !chatVisible()) { ui.unread++; $('unread').hidden = false; $('unread').textContent = ui.unread > 99 ? '99+' : String(ui.unread); }
}
client.addEventListener('text', e => { if (ui.inSession) appendMessage(e.detail); });
client.addEventListener('text-failed', e => {
  const bubble = $('messages').querySelector(`[data-id="${e.detail.id}"]`);
  if (!bubble || bubble.classList.contains('failed')) return;
  bubble.classList.add('failed');
  bubble.querySelector('.col')?.append(el('div', { className: 'failed-note', textContent: `Not delivered · ${e.detail.failed}` }));
});

$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  if (client.sendText(escapeHtml(text).replace(/\n/g, '<br />'), sendScope())) $('chatInput').value = '';   // XHTML: murmur parses long messages strictly
});
$('imageBtn').onclick = () => $('imageInput').click();
$('imageInput').onchange = () => { const f = $('imageInput').files[0]; if (f) sendImage(f); $('imageInput').value = ''; };
$('chatInput').addEventListener('paste', e => { const f = [...e.clipboardData.items].find(i => i.type.startsWith('image/'))?.getAsFile(); if (f) { e.preventDefault(); sendImage(f); } });
$('messages').addEventListener('dragover', e => e.preventDefault());
$('messages').addEventListener('drop', e => { e.preventDefault(); const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/')); if (f) sendImage(f); });
async function sendImage(file) {
  try { client.sendText(await imageToHtml(file, client.serverInfo.imageMessageLength || 131_072), sendScope()); }
  catch (e) { toast(e.message, 'warn'); }
}
$('viewer').onclick = () => { $('viewer').hidden = true; };

// ---- server pane ----

function renderServerPane() {
  const info = client.serverInfo, v = info.version ?? {};
  const pane = $('serverPane');
  pane.replaceChildren();
  const welcome = el('div', { className: 'card' }, el('h3', { textContent: ui.target?.host ?? '' }));
  if (info.welcomeText) { const w = el('div', { className: 'welcome' }); w.append(sanitize(info.welcomeText)); welcome.append(w); }
  pane.append(welcome);
  const kv = el('dl', { className: 'kv' });
  const rows = [
    ['Server', `${v.release ?? 'Mumble'}${v.os ? ` on ${v.os}` : ''}`],
    ['People', `${client.users.size}${info.maxUsers ? ` of ${info.maxUsers}` : ''}`],
    ['Channels', String(client.channels.size)],
    ['Voice', `${client.wireFormat === 'protobuf' ? 'Mumble 1.5 packets' : 'legacy packets'}, tunnelled over TCP`],
    ['Ping', client.stats.tcpPingMs ? `${client.stats.tcpPingMs} ms` : '…'],
    ['You', `${client.myUser?.name ?? ''} · session ${client.me ?? ''}`],
    ['Limits', `${info.messageLength ?? 5000} chars, images ${Math.round((info.imageMessageLength ?? 131072) / 1024)} KB${info.allowHtml === false ? ', no HTML' : ''}`],
  ];
  for (const [k, val] of rows) kv.append(el('dt', { textContent: k }), el('dd', { textContent: val }));
  pane.append(el('div', { className: 'card' }, el('h3', { textContent: 'Connection' }), kv));
  const diag = el('div', { className: 'card' }, el('h3', { textContent: 'Log' }));
  const pre = el('pre', { className: 'diag', textContent: client.log.slice(-60).map(l => `${l.date.toLocaleTimeString([], { hour12: false })} [${l.tag}] ${l.message}`).join('\n') || 'Nothing yet.' });
  const copy = el('button', { type: 'button', className: 'ghost', textContent: 'Copy log' });
  copy.onclick = async () => { try { await navigator.clipboard.writeText(diagText()); toast('Log copied'); } catch { toast('Could not copy', 'warn'); } };
  diag.append(pre, el('div', { className: 'row', style: 'margin-top:8px' }, copy));
  pane.append(diag);
  pre.scrollTop = pre.scrollHeight;
}
client.addEventListener('server', scheduleRender);
client.addEventListener('log', () => { if (document.body.dataset.tab === 'server') scheduleRender(); renderDiag(); });

// ---- voice dock ----

function renderDock() {
  $('meChannel').textContent = client.myChannel?.name ?? '—';
  renderTalkers();
  renderVoiceState();
}

function renderTalkers() {
  const box = $('talkers');
  box.replaceChildren();
  box.className = 'talkers';
  const talking = [...client.users.values()].filter(u => u.talking || (u.session === client.me && audio.isTransmitting));
  if (talking.length) {
    const stack = el('span', { className: 'stack' });
    for (const u of talking.slice(0, 5)) stack.append(avatar(u.name, 's'));
    box.append(stack, el('span', { className: 'names', textContent: talking.map(u => u.session === client.me ? 'you' : u.name).join(', ') }));
    box.classList.add('on');
    return;
  }
  if (audio.captureError) { box.textContent = audio.captureError; box.classList.add('warn'); return; }
  box.textContent = audio.muted ? 'Muted' : { vad: 'Voice activity', ptt: 'Push to talk · hold Space', continuous: 'Always on' }[settings.transmitMode] ?? '';
}

function renderVoiceState() {
  $('muteBtn').innerHTML = ICON[audio.muted ? 'micOff' : 'mic'];
  $('muteBtn').classList.toggle('active', audio.muted);
  $('muteBtn').classList.toggle('live', audio.isTransmitting && !audio.muted);
  $('muteBtn').title = audio.muted ? 'Unmute' : 'Mute';
  $('deafBtn').innerHTML = ICON[audio.deafened ? 'headphonesOff' : 'headphones'];
  $('deafBtn').classList.toggle('active', audio.deafened);
  $('deafBtn').title = audio.deafened ? 'Undeafen' : 'Deafen';
  $('pttBtn').hidden = settings.transmitMode !== 'ptt';
  $('meter').hidden = settings.transmitMode === 'ptt';
  $('meter').classList.toggle('muted', audio.muted);
  $('pttBtn').classList.toggle('active', audio.pttPressed);
  $('micStatus').textContent = audio.captureError ? `${audio.captureError}. Check the site permissions in the address bar.` : '';
  const me = document.querySelector(`.user[data-session="${client.me}"]`);
  if (me) { me.classList.toggle('talking', audio.isTransmitting); const u = client.myUser; if (u) { const [t, c] = userStatus(u, true); const s = me.querySelector('.status'); s.textContent = t; s.className = `status ${c}`; } }
}
audio.addEventListener('state', () => { renderVoiceState(); renderTalkers(); });
audio.addEventListener('transmit', () => { renderVoiceState(); renderTalkers(); });
audio.addEventListener('level', () => {
  const pct = db => Math.max(0, Math.min(100, (db + 70) / 60 * 100));
  const level = pct(audio.inputLevelDb), mark = pct(audio.thresholdDb);
  $('meterFill').style.width = `${level}%`;
  $('meterFill').classList.toggle('open', audio.isTransmitting);
  $('meterMark').style.left = `${mark}%`;
  $('meterMark').hidden = settings.transmitMode !== 'vad';
  if (!$('settings').hidden) {
    $('sMeterFill').style.width = `${level}%`; $('sMeterMark').style.left = `${mark}%`;
    $('thresholdLabel').textContent = `${Math.round(audio.thresholdDb)} dB${settings.autoSensitivity ? ' auto' : ''}`;
    $('floorHint').textContent = settings.autoSensitivity ? `Room noise is about ${Math.round(audio.noiseFloorDb)} dB; the gate opens 12 dB above it and follows the room.` : 'Fixed threshold. Turn on automatic sensitivity to follow the room.';
  }
});

$('muteBtn').onclick = () => audio.setMuted(!audio.muted);
$('deafBtn').onclick = () => audio.setDeafened(!audio.deafened);
$('pttBtn').addEventListener('pointerdown', e => { e.preventDefault(); audio.setPTT(true); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('pttBtn').addEventListener(ev, () => audio.setPTT(false));

const isTyping = e => /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closePopover(); $('viewer').hidden = true; if (!$('settings').hidden) toggleSettings(false); return; }
  if (e.code === 'Space' && !isTyping(e) && ui.inSession) { e.preventDefault(); if (!e.repeat) audio.setPTT(true); }
});
window.addEventListener('keyup', e => { if (e.code === 'Space' && audio.pttPressed) { e.preventDefault(); audio.setPTT(false); } });
window.addEventListener('blur', () => audio.setPTT(false));

// ---- screen share ----

$('shareBtn').hidden = !ScreenShare.supported;
$('shareBtn').onclick = async () => {
  if (share.sharing) return share.stop();
  try { await share.start(); showTab('screen'); }
  catch (e) { if (e.name !== 'NotAllowedError') toast(`Can't share: ${e.message}`, 'warn'); }
};
share.addEventListener('state', () => {
  $('shareBtn').classList.toggle('active', !!share.sharing);
  $('shareBtn').innerHTML = ICON[share.sharing ? 'screenOff' : 'screen'];
  $('shareBtn').title = share.sharing ? 'Stop sharing' : 'Share screen';
  scheduleRender();
});
share.addEventListener('available', scheduleRender);
mountStage({ share, client, stage: $('stage'), tab: $('tabScreen'), showTab, toast });

// ---- settings ----

function toggleSettings(open = $('settings').hidden) { $('settings').hidden = !open; if (open) renderSettings(); }
$('settingsBtn').onclick = () => toggleSettings();
$('settingsClose').onclick = () => toggleSettings(false);

function segmented(id, value, onChange) {
  for (const b of $(id).querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.value === String(value));
    b.onclick = () => { onChange(b.dataset.value); saveSettings(); renderSettings(); renderDock(); };
  }
}

async function renderSettings() {
  segmented('transmitMode', settings.transmitMode, v => { settings.transmitMode = v; });
  $('transmitHint').textContent = { vad: 'Opens the mic when it hears you. Space talks too.', ptt: 'Hold Space or the button.', continuous: 'Always sending while unmuted.' }[settings.transmitMode];
  segmented('bitrate', settings.bitrate, v => audio.setBitrate(Number(v)));
  segmented('noiseSuppression', settings.noiseSuppression, v => audio.setNoiseSuppression(v));
  $('autoSens').checked = settings.autoSensitivity;
  $('threshold').value = settings.autoSensitivity ? Math.round(audio.thresholdDb) : settings.vadThresholdDb;
  $('threshold').disabled = settings.autoSensitivity;
  $('thresholdLabel').textContent = `${Math.round(audio.thresholdDb)} dB${settings.autoSensitivity ? ' auto' : ''}`;
  $('themes').replaceChildren(...Object.entries(THEMES).map(([name, t]) => {
    const b = el('button', { type: 'button', className: `swatch${settings.theme === name ? ' on' : ''}`, title: t.title });
    b.style.setProperty('--sw-bg', t.bg); b.style.setProperty('--sw-accent', t.accent);
    b.onclick = () => { settings.theme = name; saveSettings(); applyTheme(name); renderSettings(); };
    return b;
  }));
  $('turnUrl').value = settings.turn.url; $('turnUser').value = settings.turn.username; $('turnPass').value = settings.turn.credential;
  $('shareAudio').checked = settings.shareAudio !== false;
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
$('shareAudio').onchange = () => { settings.shareAudio = $('shareAudio').checked; saveSettings(); };

$('diagBtn').onclick = () => { const d = $('diag'); d.hidden = !d.hidden; $('diagBtn').textContent = d.hidden ? 'Show log' : 'Hide log'; renderDiag(); };
$('diagCopy').onclick = async () => { try { await navigator.clipboard.writeText(diagText()); toast('Log copied'); } catch { toast('Could not copy', 'warn'); } };
const diagText = () => client.log.map(l => `${l.date.toISOString()} [${l.tag}] ${l.message}`).join('\n');
function renderDiag() { if ($('diag').hidden) return; $('diag').textContent = diagText() || 'Nothing yet.'; $('diag').scrollTop = $('diag').scrollHeight; }

// ---- toasts ----

client.addEventListener('notice', e => toast(e.detail.text, e.detail.kind));
function toast(text, kind = 'info') {
  const icon = { join: 'userPlus', leave: 'userMinus', move: 'join', warn: 'warn', info: 'info' }[kind] ?? 'info';
  const t = el('div', { className: `toast ${kind}`, innerHTML: ICON[icon] }, el('span', { textContent: text }));
  $('toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'warn' ? 6000 : 3200);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
}

// ---- boot ----

if (location.hash === '#auto' && servers[0]) connect(servers[0]);
