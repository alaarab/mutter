// Mutter Web. A Revolt/Discord-shaped shell — server rail, channel sidebar, chat, members — over
// the Mumble session (client.js) and voice (audio.js); a tabbed phone layout under 880px.
// Speaks to the bridge over WebSocket; the bridge is a byte pipe, so everything Mumble happens
// in this tab.

import { MumbleClient } from './client.js';
import { AudioEngine } from './audio.js';
import { ScreenShare } from './share.js';
import { mountStage } from './stage.js';
import { THEMES, DEFAULT_THEME, applyTheme } from './themes.js';
import { settings, saveSettings, servers, rememberServer, forgetServer, collapsedFor } from './store.js';
import { sanitize, imageToHtml, escapeHtml, plainText, openViewer } from './chat.js';
import { renderTree, refreshUser, presence } from './tree.js';
import { MessageList } from './messages.js';
import { renderMembers } from './members.js';
import { openPopover, closePopover, menuItem, profileCard, channelMenu, serverMenu } from './popovers.js';
import { $, el, avatar, colorFor, initials } from './ui.js';
import { ICON, MARK } from './icons.js';

const client = new MumbleClient();
const audio = new AudioEngine(client, settings);
const share = new ScreenShare(client, settings);
const ui = { scope: null, collapsed: null, target: null, statsFor: null, renderQueued: false, inSession: false, filter: '', unread: 0, recordingKey: false };
const wide = matchMedia('(min-width: 880px)');
window.mutter = { client, audio, share, settings, showTab };   // console + tests

settings.pttKey ??= 'Space';
if (!settings.noiseV2) { settings.noiseSuppression = 'neural'; settings.noiseV2 = true; saveSettings(); }   // Neural became the default
settings.showMembers ??= false;
settings.textSize ??= 14;
if (!THEMES[settings.theme]) { settings.theme = DEFAULT_THEME; saveSettings(); }   // the palettes were redrawn
applyTheme(settings.theme);
document.documentElement.style.setProperty('--text-size', `${settings.textSize}px`);
for (const [id, icon] of Object.entries({ railAdd: 'plus', railSettings: 'settings', newChannelBtn: 'plus', screenBtn: 'screen', serverBtn: 'info', membersBtn: 'users', imageBtn: 'plus', sendBtn: 'send', leaveBtn: 'leave', shareBtn: 'screen', muteBtn: 'mic', deafBtn: 'headphones', settingsBtn: 'settings', settingsClose: 'close', connectClose: 'close', vsLeave: 'leave' })) $(id).innerHTML = ICON[icon];
$('backBtn').prepend(el('span', { innerHTML: ICON.back }));         // the badge is already inside
$('leaveBtn').append(el('span', { textContent: 'Disconnect' }));
$('shareBtn').append(el('span', { textContent: 'Share screen' }));
document.querySelector('.search-icon').innerHTML = ICON.search;
$('railHome').innerHTML = MARK;
document.querySelector('.cap').innerHTML = MARK;
for (const c of document.querySelectorAll('.chev')) c.innerHTML = ICON.chevron;
if (!AudioEngine.supported) $('unsupported').hidden = false;

const messages = new MessageList($('messages'), {
  client, onImage: openViewer,
  onQuote: m => { const ta = $('chatInput'); ta.value = `> ${plainText(m.html).slice(0, 300)}\n${ta.value}`; ta.focus(); autoGrow(); },
  onMessageUser: s => { setScope({ sessions: [s] }); $('chatInput').focus(); },
  onMuteFor: s => { const u = client.users.get(s); if (u) { audio.setUserLocalMute(s, !u.localMute); toast(u.localMute ? `${u.name} muted for you` : `${u.name} unmuted`); scheduleRender(); } },
});

// ---- layout: desktop vs phone, tabs, panels ----

function applyLayout() {
  const desktop = wide.matches;
  document.body.dataset.layout = desktop ? 'desktop' : 'phone';
  document.body.dataset.members = desktop && settings.showMembers ? 'on' : 'off';
  $('membersBtn').classList.toggle('on', !!settings.showMembers);
  $('backBtn').hidden = desktop;
  if (desktop && document.body.dataset.tab === 'channels') showTab('chat');
  positionToasts();
}
function positionToasts() { const t = $('toasts'), m = $('main'); if (wide.matches) { t.style.left = `${m.offsetLeft}px`; t.style.width = `${m.offsetWidth}px`; } else { t.style.left = ''; t.style.width = ''; } }
wide.addEventListener('change', applyLayout);

function showTab(name) {
  if (name === 'channels' && wide.matches) name = 'chat';
  document.body.dataset.tab = name;
  $('serverBtn').classList.toggle('on', name === 'server');
  $('screenBtn').classList.toggle('on', name === 'screen');
  if (chatVisible()) { ui.unread = 0; clearUnread(); messages.clearUnread(); $('messages').scrollTop = $('messages').scrollHeight; }
  renderChanHead();
  if (name === 'server') renderServerPane();          // it only draws while it is the visible pane
}
function clearUnread() { $('backBadge').hidden = true; scheduleRender(); }
$('backBtn').onclick = () => showTab('channels');
$('serverBtn').onclick = () => showTab(document.body.dataset.tab === 'server' ? 'chat' : 'server');
$('screenBtn').onclick = () => showTab(document.body.dataset.tab === 'screen' ? 'chat' : 'screen');
$('railHome').onclick = () => showTab('chat');
$('membersBtn').onclick = () => { settings.showMembers = !settings.showMembers; saveSettings(); applyLayout(); };
const chatVisible = () => ui.inSession && (document.body.dataset.tab === 'chat' || (wide.matches && document.body.dataset.tab === 'channels')) && !document.hidden;
document.addEventListener('visibilitychange', () => { if (chatVisible()) { ui.unread = 0; clearUnread(); } });

// ---- connect: card + server rail ----

function renderSavedServers() {
  const list = $('savedServers');
  list.replaceChildren();
  list.hidden = !servers.length;
  for (const s of servers) {
    const main = el('button', { type: 'button', className: 'saved-main' },
      Object.assign(avatar(s.host, 'm'), { textContent: initials(s.host.replace(/\..*/, '')) }),
      el('span', { className: 'saved-text' }, el('strong', {}, label(s)), el('span', { className: 'sub' }, `as ${s.username}`)));
    main.onclick = () => { fillForm(s); connect(readForm()); };
    const del = el('button', { type: 'button', className: 'icon small', innerHTML: ICON.trash }); del.dataset.tip = 'Forget';
    del.onclick = () => { forgetServer(s.host, s.port); renderSavedServers(); renderRail(); };
    list.append(el('li', { className: 'saved-row' }, main, del));
  }
}
const label = s => s.port === 64738 ? s.host : `${s.host}:${s.port}`;
const sameServer = (a, b) => a && b && a.host === b.host && a.port === b.port;

function renderRail() {
  const box = $('railServers');
  box.replaceChildren();
  for (const s of servers) {
    const b = el('button', { type: 'button', className: `rail-btn server${sameServer(s, ui.target) ? ' on' : ''}${sameServer(s, ui.target) && !client.isConnected && client.state !== 'disconnected' ? ' busy' : ''}`, textContent: initials(s.host.replace(/\..*/, '')) });
    b.style.background = colorFor(s.host);
    b.dataset.tip = label(s);
    b.onclick = () => { if (sameServer(s, ui.target) && client.isConnected) { showTab('chat'); return; } fillForm(s); connect(readForm()); };
    box.append(b);
  }
}
function fillForm(s) { $('host').value = s.host ?? ''; $('port').value = s.port ?? 64738; $('username').value = s.username ?? ''; $('password').value = s.password ?? ''; $('remember').checked = s.password !== undefined; }
function readForm() {
  return { host: $('host').value.trim(), port: Number($('port').value) || 64738, username: $('username').value.trim(), password: $('password').value || undefined, remember: $('remember').checked };
}
function showConnect(open) { $('connect').hidden = !open; $('connectClose').hidden = !ui.inSession; if (open) $('host').focus(); }
$('railAdd').onclick = () => { fillForm({ host: '', port: 64738, username: servers[0]?.username ?? '' }); showConnect(true); };
$('connectClose').onclick = () => showConnect(false);
$('connectForm').addEventListener('submit', e => { e.preventDefault(); connect(readForm()); });
renderSavedServers();
fillForm(servers[0] ?? { host: '', port: 64738, username: '' });
renderRail();

async function connect(target) {
  if (!target.host || !target.username) return;
  if (client.state !== 'disconnected') { client.disconnect(); await audio.stop(); }
  showError(null);
  ui.target = target;
  ui.collapsed = collapsedFor(target.host);
  rememberServer(target);
  renderSavedServers(); renderRail();
  $('title').textContent = label(target);
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

// ---- connection state ----

client.addEventListener('state', () => {
  const s = client.state;
  const wait = s !== 'connected' && s !== 'disconnected';
  $('dot').className = `dot ${s === 'connected' ? 'on' : wait ? 'wait' : ''}`;
  $('connectBtn').disabled = s !== 'disconnected';
  $('connectBtn').textContent = s === 'disconnected' ? 'Connect' : { connecting: 'Connecting…', authenticating: 'Signing in…', reconnecting: 'Reconnecting…' }[s];
  const vp = document.querySelector('.vp-state');
  vp.className = `vp-state${s === 'connected' ? '' : wait ? ' wait' : ' off'}`;
  vp.querySelector('.dot').className = `dot${s === 'connected' ? ' on' : wait ? ' wait' : ''}`;
  $('vpState').textContent = s === 'connected' ? 'Voice connected' : wait ? 'Connecting…' : 'Not connected';
  if (s === 'connected') {
    if (!ui.inSession) { ui.inSession = true; showConnect(false); messages.reset(); for (const m of client.messages) messages.append(m); showTab('chat'); }
    $('overlay').hidden = true;
    ui.scope = null;
    audio.resync();
    scheduleRender();
  } else if (s === 'reconnecting') {
    $('overlay').hidden = false;
    $('overlayText').textContent = `Reconnecting to ${ui.target?.host}…`;
  } else if (s === 'disconnected') {
    if (ui.inSession) { ui.inSession = false; audio.stop(); $('pingPill').hidden = true; closePopover(); }
    $('overlay').hidden = true;
    showConnect(true);
    $('subtitle').textContent = 'Not connected';
    $('memberList').replaceChildren(); $('tree').replaceChildren();
  }
  renderRail();
  renderPanels();
});
client.addEventListener('error', e => showError(e.detail));
client.addEventListener('stats', () => {
  const ms = client.stats.tcpPingMs;
  $('pingPill').hidden = false; $('pingPill').textContent = `${ms} ms`; $('pingPill').classList.toggle('slow', ms > 150);
});

// ---- rendering ----

client.addEventListener('channels', scheduleRender);
client.addEventListener('users', scheduleRender);
client.addEventListener('server', scheduleRender);
share.addEventListener('available', scheduleRender);
share.addEventListener('state', scheduleRender);
// A microtask coalesces the burst of state messages in one socket read into one render, and
// keeps working in background tabs where requestAnimationFrame stops.
function scheduleRender() { if (ui.renderQueued) return; ui.renderQueued = true; queueMicrotask(() => { ui.renderQueued = false; if (ui.inSession) renderAll(); }); }
function renderAll() {
  renderTreeNow(); renderMembersNow(); renderPanels(); renderChanHead(); renderScope(); renderServerPane();
  $('subtitle').textContent = `${client.users.size} online · in #${client.myChannel?.name ?? '—'}`;
}

const treeCtx = () => ({
  client, audio, share, collapsed: ui.collapsed?.set ?? new Set(), filter: ui.filter, unread: ui.unread,
  isCurrent: c => c.channelId === client.myChannel?.channelId,
  onToggle: c => { if (ui.collapsed.set.has(c.channelId)) ui.collapsed.set.delete(c.channelId); else ui.collapsed.set.add(c.channelId); ui.collapsed.save(); renderTreeNow(); },
  onJoin: c => client.joinChannel(c.channelId),
  onChannel: (row, c) => channelMenu(row, c, { client, isCurrent: x => x.channelId === client.myChannel?.channelId, setScope: s => { setScope(s); showTab('chat'); }, newChannel }),
  onUser: (row, u) => openProfile(row, u),
  onWatch: u => { share.watch(u.session); showTab('screen'); },
});
function renderTreeNow() { renderTree($('tree'), treeCtx()); }
function renderMembersNow() { renderMembers($('memberList'), $('memberCount'), { ...treeCtx(), onUser: (row, u) => openProfile(row, u) }); }
$('search').addEventListener('input', () => { ui.filter = $('search').value.trim().toLowerCase(); renderTreeNow(); });
$('search').addEventListener('keydown', e => { if (e.key === 'Escape') { $('search').value = ''; ui.filter = ''; renderTreeNow(); } });

function openProfile(anchor, u) {
  profileCard(anchor, u, {
    client, audio, share, presence: x => presence(x, treeCtx()),
    statsFor: (session, node) => { ui.statsFor = { session, el: node }; client.requestStats(session); },
    onMessage: x => { setScope({ sessions: [x.session] }); showTab('chat'); $('chatInput').focus(); },
    onWatch: x => { share.watch(x.session); showTab('screen'); },
    rerender: scheduleRender,
  });
}
client.addEventListener('user-stats', e => {
  const m = e.detail;
  if (ui.statsFor?.session !== m.session) return;
  const parts = [];
  if (m.onlineSecs !== undefined) parts.push(`Online ${fmtDuration(m.onlineSecs)}`);
  if (m.idleSecs) parts.push(`idle ${fmtDuration(m.idleSecs)}`);
  if (m.bandwidth) parts.push(`${Math.round(m.bandwidth / 1000)} kbit/s`);
  if (m.tcpPackets !== undefined && !m.udpPackets) parts.push('TCP only');
  ui.statsFor.el.textContent = parts.join(' · ') || 'No stats';
});
const fmtDuration = s => s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;

client.addEventListener('talking', e => { const u = client.users.get(e.detail.session); if (u) refreshUser(u, treeCtx()); renderTalkers(); renderTalkers($('vsTalkers')); });

function newChannel(parent = client.myChannel?.channelId ?? 0) {
  const name = prompt('Channel name');
  if (name?.trim()) client.createChannel(parent, name.trim(), true);
}
$('newChannelBtn').onclick = () => newChannel();
$('serverHead').onclick = () => { if (ui.inSession) serverMenu($('serverHead'), { showTab, newChannel, leave, toast, address: () => label(ui.target) }); };

function renderChanHead() {
  const tab = document.body.dataset.tab;
  const c = client.myChannel;
  const chat = tab === 'chat' || tab === 'channels';
  if (tab === 'server') { $('chatTitle').textContent = 'Server'; $('chanDesc').textContent = ui.target ? label(ui.target) : ''; $('chanSub').textContent = ui.target ? label(ui.target) : ''; }
  else if (tab === 'screen') {
    const who = share.watching ? `${client.users.get(share.watching.sender)?.name ?? ''}’s screen` : share.sharing ? 'You are sharing' : '';
    $('chatTitle').textContent = 'Screen'; $('chanDesc').textContent = who; $('chanSub').textContent = who;
  } else {
    $('chatTitle').textContent = c?.name ?? 'Chat';
    $('chanDesc').textContent = c?.description ? plainText(c.description) : '';
    $('chanSub').textContent = client.isConnected ? `${client.users.size} online` : 'Not connected';
  }
  document.querySelector('.chan-title .hash').style.display = chat ? '' : 'none';
  document.querySelector('.chan-title .chev').style.display = chat && client.isConnected ? '' : 'none';
}
$('titleBtn').onclick = () => {
  if (!client.isConnected) return;
  if (document.body.dataset.tab !== 'chat' && document.body.dataset.tab !== 'channels') return showTab('chat');
  const c = client.myChannel;
  if (c) channelMenu($('titleBtn'), c, { client, isCurrent: x => x.channelId === client.myChannel?.channelId, setScope: s => { setScope(s); showTab('chat'); }, newChannel });
};

// ---- chat ----

function sendScope() { return ui.scope ?? { channelId: client.myChannel?.channelId ?? 0 }; }
function setScope(scope) { ui.scope = scope; renderScope(); }
function renderScope() {
  const scope = sendScope(), pill = $('scopePill');
  let title = client.channels.get(scope.channelId)?.name ?? 'Chat', kind = '';
  if (scope.sessions) { const u = client.users.get(scope.sessions[0]); if (!u) { ui.scope = null; return renderScope(); } title = u.name; kind = 'dm'; }
  else if (scope.treeId !== undefined) { title = `${client.channels.get(scope.treeId)?.name ?? 'Chat'} +`; kind = 'tree'; }
  $('scopeName').textContent = title;
  pill.className = `scope ${kind}`;
  // The placeholder already names the current channel; the pill only earns its width when the
  // message is going somewhere else.
  pill.hidden = !kind && scope.channelId === client.myChannel?.channelId;
  $('chatInput').placeholder = kind === 'dm' ? `Message ${title}` : `Message #${title}`;
}
$('scopePill').onclick = () => openPopover($('scopePill'), pop => {
  const cur = client.myChannel, scope = sendScope();
  pop.append(el('h3', { className: 'mtitle', textContent: 'Send to' }));
  const actions = el('div', { className: 'actions' });
  actions.append(menuItem('message', `#${cur?.name ?? 'channel'}`, () => { setScope(null); closePopover(); }, { on: !ui.scope }));
  actions.append(menuItem('channels', `#${cur?.name ?? 'channel'} and below`, () => { setScope({ treeId: cur?.channelId ?? 0 }); closePopover(); }, { on: scope.treeId === cur?.channelId }));
  if (scope.sessions) actions.append(menuItem('close', `Stop messaging ${client.users.get(scope.sessions[0])?.name ?? ''}`, () => { setScope(null); closePopover(); }));
  pop.append(actions, el('p', { className: 'hint', textContent: 'To message one person, click their name.' }));
});

client.addEventListener('text', e => {
  if (!ui.inSession) return;
  const m = e.detail;
  if (!m.own && !m.scope?.system && !chatVisible()) {
    messages.markUnreadFromHere();
    ui.unread++;
    $('backBadge').hidden = false;
    $('backBadge').textContent = ui.unread > 99 ? '99+' : String(ui.unread);
    scheduleRender();                                   // the channel row carries the count too
  }
  messages.append(m);
});
client.addEventListener('text-failed', e => messages.markFailed(e.detail));

const ta = $('chatInput');
function autoGrow() { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`; }
ta.addEventListener('input', autoGrow);
ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chatForm').requestSubmit(); } });
$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = ta.value.trim();
  if (!text) return;
  if (client.sendText(escapeHtml(text).replace(/\n/g, '<br />'), sendScope())) { ta.value = ''; autoGrow(); }   // XHTML: murmur parses long messages strictly
});
$('imageBtn').onclick = () => $('imageInput').click();
$('imageInput').onchange = () => { const f = $('imageInput').files[0]; if (f) sendImage(f); $('imageInput').value = ''; };
ta.addEventListener('paste', e => { const f = [...e.clipboardData.items].find(i => i.type.startsWith('image/'))?.getAsFile(); if (f) { e.preventDefault(); sendImage(f); } });
$('messages').addEventListener('dragover', e => e.preventDefault());
$('messages').addEventListener('drop', e => { e.preventDefault(); const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/')); if (f) sendImage(f); });
async function sendImage(file) {
  try { client.sendText(await imageToHtml(file, client.serverInfo.imageMessageLength || 131_072), sendScope()); }
  catch (e) { toast(e.message, 'warn'); }
}
$('viewer').onclick = () => { $('viewer').hidden = true; };

// ---- server pane ----

function renderServerPane() {
  if (document.body.dataset.tab !== 'server') return;
  const info = client.serverInfo, v = info.version ?? {};
  const pane = $('serverPane');
  pane.replaceChildren();
  const welcome = el('div', { className: 'card' }, el('h3', { textContent: ui.target ? label(ui.target) : '' }));
  if (info.welcomeText) { const w = el('div', { className: 'welcome' }); w.append(sanitize(info.welcomeText)); welcome.append(w); }
  pane.append(welcome);
  const kv = el('dl', { className: 'kv' });
  const rows = [
    ['Server', `${v.release ?? 'Mumble'}${v.os ? ` on ${v.os}` : ''}`],
    ['People', `${client.users.size}${info.maxUsers ? ` of ${info.maxUsers}` : ''}`],
    ['Channels', String(client.channels.size)],
    ['Voice', `${client.stats.udp?.up ? `UDP through the bridge · ${client.stats.udp.rtt} ms` : 'TCP tunnel'} · ${client.wireFormat === 'protobuf' ? 'Mumble 1.5 packets' : 'legacy packets'}${client.stats.stalls ? ` · ${client.stats.stalls} delivery stalls` : ''}${audio.stats.underruns ? ` · ${audio.stats.underruns} playback underruns` : ''}${audio.stats.captureStalls ? ` · ${audio.stats.captureStalls} capture stalls` : ''}`],
    ['Ping', client.stats.tcpPingMs ? `${client.stats.tcpPingMs} ms` : '…'],
    ['You', `${client.myUser?.name ?? ''} · session ${client.me ?? ''}`],
    ['Limits', `${info.messageLength ?? 5000} chars, images ${Math.round((info.imageMessageLength ?? 131072) / 1024)} KB${info.allowHtml === false ? ', no HTML' : ''}`],
  ];
  for (const [k, val] of rows) kv.append(el('dt', { textContent: k }), el('dd', { textContent: val }));
  pane.append(el('div', { className: 'card' }, el('h3', { textContent: 'Connection' }), kv));
  const pre = el('pre', { className: 'diag', textContent: client.log.slice(-80).map(l => `${l.date.toLocaleTimeString([], { hour12: false })} [${l.tag}] ${l.message}`).join('\n') || 'Nothing yet.' });
  const copy = el('button', { type: 'button', className: 'ghost', textContent: 'Copy log' });
  copy.onclick = async () => { try { await navigator.clipboard.writeText(diagText()); toast('Log copied'); } catch { toast('Could not copy', 'warn'); } };
  pane.append(el('div', { className: 'card' }, el('h3', { textContent: 'Log' }), pre, el('div', { className: 'row', style: 'margin-top:8px' }, copy)));
  pre.scrollTop = pre.scrollHeight;
}
client.addEventListener('log', () => { if (document.body.dataset.tab === 'server') scheduleRender(); renderDiag(); });

// ---- voice: panels, meter, keys ----

function renderPanels() {
  const me = client.myUser;
  $('meChannel').textContent = client.myChannel?.name ?? '—';
  const av = avatar(me?.name ?? ui.target?.username ?? '?', 'l'); av.id = 'meAvatar'; av.classList.add('presence', me ? presence(me, treeCtx())[1] : 'invisible'); av.append(el('span', { className: 'sdot' }));
  if (audio.isTransmitting && !audio.muted) av.classList.add('speaking');
  $('meAvatar').replaceWith(av);
  $('meName').textContent = me?.name ?? ui.target?.username ?? '—';
  const sub = $('meStatus');
  sub.className = 'sub';
  if (audio.captureError) { sub.textContent = audio.captureError; sub.classList.add('warn'); }
  else if (audio.deafened) sub.textContent = 'Deafened';
  else if (audio.muted) sub.textContent = 'Muted';
  else { sub.textContent = { vad: 'Voice activity', ptt: `Push to talk · ${keyLabel(settings.pttKey)}`, continuous: 'Always on' }[settings.transmitMode] ?? ''; }
  for (const b of [$('muteBtn'), $('vsMute')]) {
    b.innerHTML = ICON[audio.muted ? 'micOff' : 'mic'];
    b.classList.toggle('active', audio.muted);
    b.dataset.tip = audio.muted ? 'Unmute' : 'Mute';
  }
  // The strip is the phone's whole voice UI while you're reading the chat.
  $('voiceStrip').hidden = !client.isConnected;
  $('vsChan').textContent = client.myChannel?.name ?? '';
  renderTalkers($('vsTalkers'));
  $('deafBtn').innerHTML = ICON[audio.deafened ? 'headphonesOff' : 'headphones'];
  $('deafBtn').classList.toggle('active', audio.deafened);
  $('deafBtn').dataset.tip = audio.deafened ? 'Undeafen' : 'Deafen';
  $('pttBtn').hidden = settings.transmitMode !== 'ptt';
  $('pttBtn').textContent = `Hold to talk · ${keyLabel(settings.pttKey)}`;
  $('meter').hidden = settings.transmitMode === 'ptt';
  $('meter').classList.toggle('muted', audio.muted);
  $('pttBtn').classList.toggle('active', audio.pttPressed);
  $('micStatus').textContent = audio.captureError ? `${audio.captureError}. Check the site permissions in the address bar.` : '';
  $('shareBtn').classList.toggle('active', !!share.sharing);
  $('shareBtn').innerHTML = `${ICON[share.sharing ? 'screenOff' : 'screen']}<span>${share.sharing ? 'Stop sharing' : 'Share screen'}</span>`;
  const live = !!(share.watching || share.available.size || share.sharing);
  $('screenBtn').hidden = !live; $('screenBtn').classList.toggle('live', !!(share.available.size && !share.watching));
  renderTalkers();
}
function renderTalkers(box = $('talkers')) {
  box.replaceChildren();
  const talking = [...client.users.values()].filter(u => u.talking || (u.session === client.me && audio.isTransmitting && !audio.muted));
  if (!talking.length) return;
  const stack = el('span', { className: 'stack' });
  for (const u of talking.slice(0, 4)) stack.append(avatar(u.name, 'xs'));
  box.append(stack, el('span', { textContent: talking.map(u => u.session === client.me ? 'you' : u.name).join(', ') }));
}
audio.addEventListener('state', () => { renderPanels(); if (client.myUser) refreshUser(client.myUser, treeCtx()); });
audio.addEventListener('transmit', () => { renderPanels(); if (client.myUser) refreshUser(client.myUser, treeCtx()); });
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
$('muteBtn').onclick = $('vsMute').onclick = () => audio.setMuted(!audio.muted);
$('deafBtn').onclick = () => audio.setDeafened(!audio.deafened);
$('vsLeave').onclick = leave;
$('vsGo').onclick = () => showTab('channels');
$('pttBtn').addEventListener('pointerdown', e => { e.preventDefault(); audio.setPTT(true); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('pttBtn').addEventListener(ev, () => audio.setPTT(false));

// Push to talk: any key by its `code`, or Mouse3/Mouse4/Mouse5. Letters and digits are ignored
// while typing in a field; modifiers and function keys work anywhere. The browser only sees
// keys while the window is focused.
const isTyping = e => /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
const plainKey = code => /^(Key|Digit|Numpad|Space|Backquote|Minus|Equal|Bracket|Semicolon|Quote|Comma|Period|Slash|Backslash|Enter|Backspace)/.test(code);
export function keyLabel(code) {
  if (!code) return '—';
  if (/^Mouse\d$/.test(code)) return `Mouse ${code.slice(5)}`;
  return code.replace(/^Key|^Digit/, '').replace(/^Control(Left|Right)$/, '$1 Ctrl').replace(/^Shift(Left|Right)$/, '$1 Shift').replace(/^Alt(Left|Right)$/, '$1 Alt').replace(/^Meta(Left|Right)$/, '$1 Meta').replace(/^Backquote$/, '`').replace(/([a-z])([A-Z])/g, '$1 $2');
}
window.addEventListener('keydown', e => {
  if (ui.recordingKey) { e.preventDefault(); if (e.key !== 'Escape') setPttKey(e.code); else endRecording(); return; }
  if (e.key === 'Escape') { $('viewer').hidden = true; if (!$('settings').hidden) toggleSettings(false); return; }
  if (e.code === settings.pttKey && ui.inSession && !(isTyping(e) && plainKey(e.code))) { e.preventDefault(); if (!e.repeat) audio.setPTT(true); }
});
window.addEventListener('keyup', e => { if (e.code === settings.pttKey && audio.pttPressed) { e.preventDefault(); audio.setPTT(false); } });
window.addEventListener('mousedown', e => { const code = `Mouse${e.button}`; if (ui.recordingKey && e.button >= 3) { e.preventDefault(); setPttKey(code); return; } if (code === settings.pttKey && ui.inSession) { e.preventDefault(); audio.setPTT(true); } });
window.addEventListener('mouseup', e => { if (`Mouse${e.button}` === settings.pttKey && audio.pttPressed) audio.setPTT(false); });
window.addEventListener('contextmenu', e => { if (settings.pttKey === 'Mouse2') e.preventDefault(); });
window.addEventListener('blur', () => audio.setPTT(false));
function setPttKey(code) { settings.pttKey = code; saveSettings(); endRecording(); renderPanels(); renderSettings(); }
function endRecording() { ui.recordingKey = false; $('pttKeyBtn')?.classList.remove('recording'); renderSettings(); }

// ---- screen share ----

$('shareBtn').hidden = !ScreenShare.supported;
$('shareBtn').onclick = async () => {
  if (share.sharing) return share.stop();
  try { await share.start(); showTab('screen'); }
  catch (e) { if (e.name !== 'NotAllowedError') toast(`Can't share: ${e.message}`, 'warn'); }
};
mountStage({ share, client, stage: $('stage'), tabs: [$('screenBtn')], showTab, toast });

// ---- settings ----

function toggleSettings(open = $('settings').hidden) { $('settings').hidden = !open; if (open) renderSettings(); else endRecording(); }
$('settingsBtn').onclick = () => toggleSettings();
$('railSettings').onclick = () => toggleSettings();
$('settingsClose').onclick = () => toggleSettings(false);

function segmented(id, value, onChange) {
  for (const b of $(id).querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.value === String(value));
    b.onclick = () => { onChange(b.dataset.value); saveSettings(); renderSettings(); renderPanels(); };
  }
}

async function renderSettings() {
  segmented('transmitMode', settings.transmitMode, v => { settings.transmitMode = v; });
  $('transmitHint').textContent = { vad: `Opens the mic when it hears you. ${keyLabel(settings.pttKey)} talks too.`, ptt: `Hold ${keyLabel(settings.pttKey)} or the button.`, continuous: 'Always sending while unmuted.' }[settings.transmitMode];
  let keyRow = $('pttKeyRow');
  if (!keyRow) {
    keyRow = el('div', { id: 'pttKeyRow', className: 'row between', style: 'margin-top:8px' }, el('span', { className: 'hint', textContent: 'Push-to-talk key' }), el('button', { id: 'pttKeyBtn', type: 'button', className: 'keycap' }));
    $('transmitHint').after(keyRow);
    $('pttKeyBtn').onclick = () => { ui.recordingKey = !ui.recordingKey; $('pttKeyBtn').classList.toggle('recording', ui.recordingKey); $('pttKeyBtn').textContent = ui.recordingKey ? 'Press a key…' : keyLabel(settings.pttKey); };
  }
  if (!ui.recordingKey) $('pttKeyBtn').textContent = keyLabel(settings.pttKey);
  segmented('bitrate', settings.bitrate, v => audio.setBitrate(Number(v)));
  segmented('noiseSuppression', settings.noiseSuppression, v => audio.setNoiseSuppression(v));
  $('noiseHint').textContent = { off: 'Only the browser’s own echo cancellation.', light: 'Spectral suppressor, −10 dB on steady hiss, fans and hum.', strong: 'Spectral suppressor at −22 dB plus a keyboard-click ducker.', neural: `RNNoise, the neural denoiser Mumble desktop uses: removes hiss, fans, keyboards and babble and tells the voice gate what is speech.${audio.neural === false ? ' Not available here — falling back to Strong.' : ''}` }[settings.noiseSuppression] ?? '';
  segmented('textSize', settings.textSize, v => { settings.textSize = Number(v); document.documentElement.style.setProperty('--text-size', `${v}px`); });
  $('autoSens').checked = settings.autoSensitivity;
  $('threshold').value = settings.autoSensitivity ? Math.round(audio.thresholdDb) : settings.vadThresholdDb;
  $('threshold').disabled = settings.autoSensitivity;
  $('thresholdLabel').textContent = `${Math.round(audio.thresholdDb)} dB${settings.autoSensitivity ? ' auto' : ''}`;
  $('themes').replaceChildren(...Object.entries(THEMES).map(([name, t]) => {
    const b = el('button', { type: 'button', className: `swatch${settings.theme === name ? ' on' : ''}` }); b.dataset.tip = t.title;
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
  renderPanels();
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

applyLayout();
showTab('chat');
showConnect(true);
renderPanels();
if (location.hash === '#auto' && servers[0]) connect(servers[0]);
