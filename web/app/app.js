import { MumbleClient } from './client.js';
import { AudioEngine } from './audio.js';
import { ScreenShare, probeIce } from './share.js';
import { mountStage } from './stage.js';
import { mountRoom } from './room.js';
import { THEMES, DEFAULT_THEME, applyTheme } from './themes.js';
import { settings, saveSettings, servers, rememberServer, forgetServer, collapsedFor } from './store.js';
import { DEFAULT_IMAGE_LIMIT, sanitize, imageToHtml, escapeHtml, plainText, openViewer } from './chat.js';
import { DEFAULT_PORT } from '../src/mumble.js';
import { renderTree, refreshUser, presence } from './tree.js';
import { MessageList } from './messages.js';
import { renderMembers } from './members.js';
import { openPopover, closePopover, menuItem, profileCard, channelMenu, serverMenu } from './popovers.js';
import { $, el, avatar, colorFor, initials } from './ui.js';
import { ICON, MARK } from './icons.js';

const DEFAULT_MESSAGE_LIMIT = 5000;
const QUOTE_MAX_CHARS = 300;
const COMPOSER_MAX_HEIGHT = 200;
const TOAST_MS = 3200;
const WARN_TOAST_MS = 6000;
const TOAST_FADE_MS = 300;
const MAX_TOASTS = 3;
const LOG_TAIL = 80;
const METER_FLOOR_DB = -70;
const METER_RANGE_DB = 60;
const MOUSE_BUTTON_AS_PTT_FROM = 3;

const client = new MumbleClient();
const audio = new AudioEngine(client, settings);
const share = new ScreenShare(client, settings);
const ui = {
  scope: null,
  collapsed: null,
  target: null,
  statsFor: null,
  renderQueued: false,
  inSession: false,
  filter: '',
  unread: 0,
  recordingKey: false,
};
const wide = matchMedia('(min-width: 880px)');
window.mutter = { client, audio, share, settings, showTab };

function migrateSettings() {
  settings.pttKey ??= 'Space';
  if (!settings.noiseV2) {
    settings.noiseSuppression = 'neural';
    settings.noiseV2 = true;
    saveSettings();
  }
  settings.showMembers ??= false;
  settings.processing ??= { echo: true, noise: false, gain: true };
  settings.textSize ??= 14;
  if (!THEMES[settings.theme]) {
    settings.theme = DEFAULT_THEME;
    saveSettings();
  }
}

function applyTextSize(px) {
  document.documentElement.style.setProperty('--text-size', `${px}px`);
}

function mountIcons() {
  const icons = {
    railAdd: 'plus',
    railSettings: 'settings',
    newChannelBtn: 'plus',
    voiceBtn: 'volume',
    screenBtn: 'screen',
    serverBtn: 'info',
    membersBtn: 'users',
    imageBtn: 'plus',
    sendBtn: 'send',
    leaveBtn: 'leave',
    shareBtn: 'screen',
    muteBtn: 'mic',
    deafBtn: 'headphones',
    settingsBtn: 'settings',
    settingsClose: 'close',
    connectClose: 'close',
    vsLeave: 'leave',
  };
  for (const [id, icon] of Object.entries(icons)) {
    $(id).innerHTML = ICON[icon];
  }
  $('backBtn').prepend(el('span', { innerHTML: ICON.back }));
  $('leaveBtn').append(el('span', { textContent: 'Disconnect' }));
  $('shareBtn').append(el('span', { textContent: 'Share screen' }));
  document.querySelector('.search-icon').innerHTML = ICON.search;
  $('railHome').innerHTML = MARK;
  document.querySelector('.cap').innerHTML = MARK;
  for (const chevron of document.querySelectorAll('.chev')) {
    chevron.innerHTML = ICON.chevron;
  }
}

migrateSettings();
applyTheme(settings.theme);
applyTextSize(settings.textSize);
mountIcons();
const room = mountRoom({
  container: $('paneVoice'),
  client,
  audio,
  share,
  settings,
  canShare: ScreenShare.supported,
  leave,
  onShare: () => $('shareBtn').click(),
  onUser: (tile, user) => openProfile(tile, user),
});
if (!AudioEngine.supported) {
  $('unsupported').hidden = false;
}

const messages = new MessageList($('messages'), {
  client,
  onImage: openViewer,
  onQuote: (message) => {
    const input = $('chatInput');
    input.value = `> ${plainText(message.html).slice(0, QUOTE_MAX_CHARS)}\n${input.value}`;
    input.focus();
    autoGrowComposer();
  },
  onMessageUser: (session) => {
    setScope({ sessions: [session] });
    $('chatInput').focus();
  },
  onMuteFor: (session) => {
    const user = client.users.get(session);
    if (!user) {
      return;
    }
    audio.setUserLocalMute(session, !user.localMute);
    toast(user.localMute ? `${user.name} muted for you` : `${user.name} unmuted`);
    scheduleRender();
  },
});

function applyLayout() {
  const desktop = wide.matches;
  document.body.dataset.layout = desktop ? 'desktop' : 'phone';
  document.body.dataset.members = desktop && settings.showMembers ? 'on' : 'off';
  $('membersBtn').classList.toggle('on', !!settings.showMembers);
  $('backBtn').hidden = desktop;
  if (desktop && document.body.dataset.tab === 'channels') {
    showTab('chat');
  }
  positionToasts();
}

function positionToasts() {
  const toasts = $('toasts');
  const main = $('main');
  if (wide.matches) {
    toasts.style.left = `${main.offsetLeft}px`;
    toasts.style.width = `${main.offsetWidth}px`;
  } else {
    toasts.style.left = '';
    toasts.style.width = '';
  }
}

function chatVisible() {
  const tab = document.body.dataset.tab;
  const chatTab = tab === 'chat' || (wide.matches && tab === 'channels');
  return ui.inSession && chatTab && !document.hidden;
}

function clearUnread() {
  ui.unread = 0;
  $('backBadge').hidden = true;
  scheduleRender();
}

function showTab(name) {
  if (name === 'channels' && wide.matches) {
    name = 'chat';
  }
  document.body.dataset.tab = name;
  $('serverBtn').classList.toggle('on', name === 'server');
  $('screenBtn').classList.toggle('on', name === 'screen');
  $('voiceBtn').classList.toggle('on', name === 'voice');
  if (name === 'voice') {
    room.render();
  }
  if (chatVisible()) {
    clearUnread();
    messages.clearUnread();
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  renderChannelHead();
  if (name === 'server') {
    renderServerPane();
  }
}

function toggleTab(name) {
  showTab(document.body.dataset.tab === name ? 'chat' : name);
}

wide.addEventListener('change', applyLayout);
$('backBtn').onclick = () => showTab('channels');
$('serverBtn').onclick = () => toggleTab('server');
$('voiceBtn').onclick = () => toggleTab('voice');
$('screenBtn').onclick = () => toggleTab('screen');
$('railHome').onclick = () => showTab('chat');
$('membersBtn').onclick = () => {
  settings.showMembers = !settings.showMembers;
  saveSettings();
  applyLayout();
};
document.addEventListener('visibilitychange', () => {
  if (chatVisible()) {
    clearUnread();
  }
});

const serverLabel = (server) => (server.port === DEFAULT_PORT ? server.host : `${server.host}:${server.port}`);
const serverInitials = (server) => initials(server.host.replace(/\..*/, ''));
const sameServer = (a, b) => a && b && a.host === b.host && a.port === b.port;

function renderSavedServers() {
  const list = $('savedServers');
  list.replaceChildren();
  list.hidden = !servers.length;
  for (const server of servers) {
    const picture = Object.assign(avatar(server.host, 'm'), { textContent: serverInitials(server) });
    const main = el(
      'button',
      { type: 'button', className: 'saved-main' },
      picture,
      el('span', { className: 'saved-text' }, el('strong', {}, serverLabel(server)), el('span', { className: 'sub' }, `as ${server.username}`))
    );
    main.onclick = () => {
      fillForm(server);
      connect(readForm());
    };
    const forget = el('button', { type: 'button', className: 'icon small', innerHTML: ICON.trash });
    forget.dataset.tip = 'Forget';
    forget.onclick = () => {
      forgetServer(server.host, server.port);
      renderSavedServers();
      renderRail();
    };
    list.append(el('li', { className: 'saved-row' }, main, forget));
  }
}

function renderRail() {
  const rail = $('railServers');
  rail.replaceChildren();
  for (const server of servers) {
    const isActive = sameServer(server, ui.target);
    const isBusy = isActive && !client.isConnected && client.state !== 'disconnected';
    const button = el('button', {
      type: 'button',
      className: `rail-btn server${isActive ? ' on' : ''}${isBusy ? ' busy' : ''}`,
      textContent: serverInitials(server),
    });
    button.style.background = colorFor(server.host);
    button.dataset.tip = serverLabel(server);
    button.onclick = () => {
      if (isActive && client.isConnected) {
        showTab('chat');
        return;
      }
      fillForm(server);
      connect(readForm());
    };
    rail.append(button);
  }
}

function fillForm(server) {
  $('host').value = server.host ?? '';
  $('port').value = server.port ?? DEFAULT_PORT;
  $('username').value = server.username ?? '';
  $('password').value = server.password ?? '';
  $('remember').checked = server.password !== undefined;
}

function readForm() {
  return {
    host: $('host').value.trim(),
    port: Number($('port').value) || DEFAULT_PORT,
    username: $('username').value.trim(),
    password: $('password').value || undefined,
    remember: $('remember').checked,
  };
}

function showConnect(open) {
  $('connect').hidden = !open;
  $('connectClose').hidden = !ui.inSession;
  if (open) {
    $('host').focus();
  }
}

function showError(text) {
  $('error').hidden = !text;
  $('error').textContent = text ?? '';
}

async function connect(target) {
  if (!target.host || !target.username) {
    return;
  }
  if (client.state !== 'disconnected') {
    client.disconnect();
    await audio.stop();
  }
  showError(null);
  ui.target = target;
  ui.collapsed = collapsedFor(target.host);
  rememberServer(target);
  renderSavedServers();
  renderRail();
  $('title').textContent = serverLabel(target);
  $('connectBtn').disabled = true;
  client.connect(target);
  if (!AudioEngine.supported) {
    return;
  }
  const useTone = new URLSearchParams(location.search).get('source') === 'tone';
  try {
    await audio.start({ source: useTone ? 'tone' : undefined });
  } catch (error) {
    toast(`Audio failed: ${error.message}`, 'warn');
    client.diag('audio', `start failed: ${error.stack}`);
  }
}

function leave() {
  client.disconnect();
  audio.stop();
}

$('railAdd').onclick = () => {
  fillForm({ host: '', port: DEFAULT_PORT, username: servers[0]?.username ?? '' });
  showConnect(true);
};
$('connectClose').onclick = () => showConnect(false);
$('connectForm').addEventListener('submit', (event) => {
  event.preventDefault();
  connect(readForm());
});
$('leaveBtn').onclick = leave;
$('overlayLeave').onclick = leave;
renderSavedServers();
fillForm(servers[0] ?? { host: '', port: DEFAULT_PORT, username: '' });
renderRail();

const CONNECT_BUTTON_TEXT = {
  connecting: 'Connecting…',
  authenticating: 'Signing in…',
  reconnecting: 'Reconnecting…',
};

function renderConnectionState() {
  const state = client.state;
  const connected = state === 'connected';
  const waiting = !connected && state !== 'disconnected';
  const dotClass = connected ? 'on' : waiting ? 'wait' : '';
  $('dot').className = `dot ${dotClass}`;
  $('connectBtn').disabled = state !== 'disconnected';
  $('connectBtn').textContent = state === 'disconnected' ? 'Connect' : CONNECT_BUTTON_TEXT[state];
  const voiceState = document.querySelector('.vp-state');
  voiceState.className = `vp-state${connected ? '' : waiting ? ' wait' : ' off'}`;
  voiceState.querySelector('.dot').className = `dot${dotClass ? ` ${dotClass}` : ''}`;
  $('vpState').textContent = connected ? 'Voice connected' : waiting ? 'Connecting…' : 'Not connected';
}

function enterSession() {
  if (!ui.inSession) {
    ui.inSession = true;
    showConnect(false);
    messages.reset();
    for (const message of client.messages) {
      messages.append(message);
    }
    showTab('chat');
  }
  $('overlay').hidden = true;
  ui.scope = null;
  audio.resync();
  scheduleRender();
}

function exitSession() {
  if (ui.inSession) {
    ui.inSession = false;
    audio.stop();
    $('pingPill').hidden = true;
    closePopover();
  }
  $('overlay').hidden = true;
  showConnect(true);
  $('subtitle').textContent = 'Not connected';
  $('memberList').replaceChildren();
  $('tree').replaceChildren();
}

client.addEventListener('state', () => {
  renderConnectionState();
  if (client.state === 'connected') {
    enterSession();
  } else if (client.state === 'reconnecting') {
    $('overlay').hidden = false;
    $('overlayText').textContent = `Reconnecting to ${ui.target?.host}…`;
  } else if (client.state === 'disconnected') {
    exitSession();
  }
  renderRail();
  renderPanels();
});
client.addEventListener('error', (event) => showError(event.detail));
client.addEventListener('stats', () => {
  const ms = client.stats.tcpPingMs;
  $('pingPill').hidden = false;
  $('pingPill').textContent = `${ms} ms`;
  $('pingPill').classList.toggle('slow', ms > 150);
});

function scheduleRender() {
  if (ui.renderQueued) {
    return;
  }
  ui.renderQueued = true;
  queueMicrotask(() => {
    ui.renderQueued = false;
    if (ui.inSession) {
      renderAll();
    }
  });
}

function renderAll() {
  renderTreeNow();
  renderMembersNow();
  renderPanels();
  renderChannelHead();
  renderScope();
  renderServerPane();
  if (document.body.dataset.tab === 'voice') {
    room.render();
  }
  $('subtitle').textContent = `${client.users.size} online · in #${client.myChannel?.name ?? '—'}`;
}

client.addEventListener('channels', scheduleRender);
client.addEventListener('users', scheduleRender);
client.addEventListener('server', scheduleRender);
share.addEventListener('available', scheduleRender);
share.addEventListener('state', scheduleRender);

const isCurrentChannel = (channel) => channel.channelId === client.myChannel?.channelId;

function messageChannel(scope) {
  setScope(scope);
  showTab('chat');
}

function treeContext() {
  return {
    client,
    audio,
    share,
    collapsed: ui.collapsed?.set ?? new Set(),
    filter: ui.filter,
    unread: ui.unread,
    isCurrent: isCurrentChannel,
    onToggle: (channel) => {
      const collapsed = ui.collapsed.set;
      if (collapsed.has(channel.channelId)) {
        collapsed.delete(channel.channelId);
      } else {
        collapsed.add(channel.channelId);
      }
      ui.collapsed.save();
      renderTreeNow();
    },
    onJoin: (channel) => client.joinChannel(channel.channelId),
    onChannel: (row, channel) => openChannelMenu(row, channel),
    onUser: (row, user) => openProfile(row, user),
    onWatch: (user) => watchUser(user),
  };
}

function openChannelMenu(anchor, channel) {
  channelMenu(anchor, channel, { client, isCurrent: isCurrentChannel, setScope: messageChannel, newChannel });
}

function watchUser(user) {
  share.watch(user.session);
  showTab('screen');
}

function renderTreeNow() {
  renderTree($('tree'), treeContext());
}

function renderMembersNow() {
  renderMembers($('memberList'), $('memberCount'), treeContext());
}

$('search').addEventListener('input', () => {
  ui.filter = $('search').value.trim().toLowerCase();
  renderTreeNow();
});
$('search').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    $('search').value = '';
    ui.filter = '';
    renderTreeNow();
  }
});

function openProfile(anchor, user) {
  profileCard(anchor, user, {
    client,
    audio,
    share,
    presence: (someone) => presence(someone, treeContext()),
    statsFor: (session, node) => {
      ui.statsFor = { session, el: node };
      client.requestStats(session);
    },
    onMessage: (someone) => {
      messageChannel({ sessions: [someone.session] });
      $('chatInput').focus();
    },
    onWatch: watchUser,
    rerender: scheduleRender,
  });
}

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

client.addEventListener('user-stats', (event) => {
  const stats = event.detail;
  if (ui.statsFor?.session !== stats.session) {
    return;
  }
  const parts = [];
  if (stats.onlineSecs !== undefined) {
    parts.push(`Online ${formatDuration(stats.onlineSecs)}`);
  }
  if (stats.idleSecs) {
    parts.push(`idle ${formatDuration(stats.idleSecs)}`);
  }
  if (stats.bandwidth) {
    parts.push(`${Math.round(stats.bandwidth / 1000)} kbit/s`);
  }
  if (stats.tcpPackets !== undefined && !stats.udpPackets) {
    parts.push('TCP only');
  }
  ui.statsFor.el.textContent = parts.join(' · ') || 'No stats';
});

client.addEventListener('talking', (event) => {
  const user = client.users.get(event.detail.session);
  if (user) {
    refreshUser(user, treeContext());
  }
  renderTalkers();
  renderTalkers($('vsTalkers'));
  if (document.body.dataset.tab === 'voice') {
    room.render();
  }
});

function newChannel(parent = client.myChannel?.channelId ?? 0) {
  const name = prompt('Channel name');
  if (name?.trim()) {
    client.createChannel(parent, name.trim(), true);
  }
}

$('newChannelBtn').onclick = () => newChannel();
$('serverHead').onclick = () => {
  if (ui.inSession) {
    serverMenu($('serverHead'), { showTab, newChannel, leave, toast, address: () => serverLabel(ui.target) });
  }
};

function setChannelHead(title, description, sub) {
  $('chatTitle').textContent = title;
  $('chanDesc').textContent = description;
  $('chanSub').textContent = sub;
}

function renderChannelHead() {
  const tab = document.body.dataset.tab;
  const isChat = tab === 'chat' || tab === 'channels';
  if (tab === 'server') {
    const address = ui.target ? serverLabel(ui.target) : '';
    setChannelHead('Server', address, address);
  } else if (tab === 'voice') {
    const channel = client.myChannel;
    const where = channel ? `#${channel.name} · ${client.usersIn(channel.channelId).length} here` : '';
    setChannelHead('Voice', where, where);
  } else if (tab === 'screen') {
    let who = '';
    if (share.watching) {
      who = `${client.users.get(share.watching.sender)?.name ?? ''}’s screen`;
    } else if (share.sharing) {
      who = 'You are sharing';
    }
    setChannelHead('Screen', who, who);
  } else {
    const channel = client.myChannel;
    setChannelHead(
      channel?.name ?? 'Chat',
      channel?.description ? plainText(channel.description) : '',
      client.isConnected ? `${client.users.size} online` : 'Not connected'
    );
  }
  document.querySelector('.chan-title .hash').style.display = isChat ? '' : 'none';
  document.querySelector('.chan-title .chev').style.display = isChat && client.isConnected ? '' : 'none';
}

$('titleBtn').onclick = () => {
  if (!client.isConnected) {
    return;
  }
  const tab = document.body.dataset.tab;
  if (tab !== 'chat' && tab !== 'channels') {
    showTab('chat');
    return;
  }
  const channel = client.myChannel;
  if (channel) {
    openChannelMenu($('titleBtn'), channel);
  }
};

function sendScope() {
  return ui.scope ?? { channelId: client.myChannel?.channelId ?? 0 };
}

function setScope(scope) {
  ui.scope = scope;
  renderScope();
}

function renderScope() {
  const scope = sendScope();
  const pill = $('scopePill');
  let title = client.channels.get(scope.channelId)?.name ?? 'Chat';
  let kind = '';
  if (scope.sessions) {
    const user = client.users.get(scope.sessions[0]);
    if (!user) {
      ui.scope = null;
      renderScope();
      return;
    }
    title = user.name;
    kind = 'dm';
  } else if (scope.treeId !== undefined) {
    title = `${client.channels.get(scope.treeId)?.name ?? 'Chat'} +`;
    kind = 'tree';
  }
  $('scopeName').textContent = title;
  pill.className = `scope ${kind}`;
  pill.hidden = !kind && scope.channelId === client.myChannel?.channelId;
  $('chatInput').placeholder = kind === 'dm' ? `Message ${title}` : `Message #${title}`;
}

$('scopePill').onclick = () =>
  openPopover($('scopePill'), (popover) => {
    const current = client.myChannel;
    const scope = sendScope();
    const channelName = current?.name ?? 'channel';
    popover.append(el('h3', { className: 'mtitle', textContent: 'Send to' }));
    const actions = el('div', { className: 'actions' });
    actions.append(menuItem('message', `#${channelName}`, () => setScope(null), { on: !ui.scope }));
    actions.append(
      menuItem('channels', `#${channelName} and below`, () => setScope({ treeId: current?.channelId ?? 0 }), {
        on: scope.treeId === current?.channelId,
      })
    );
    if (scope.sessions) {
      const name = client.users.get(scope.sessions[0])?.name ?? '';
      actions.append(menuItem('close', `Stop messaging ${name}`, () => setScope(null)));
    }
    popover.append(actions, el('p', { className: 'hint', textContent: 'To message one person, click their name.' }));
  });

client.addEventListener('text', (event) => {
  if (!ui.inSession) {
    return;
  }
  const message = event.detail;
  if (!message.own && !message.scope?.system && !chatVisible()) {
    messages.markUnreadFromHere();
    ui.unread++;
    $('backBadge').hidden = false;
    $('backBadge').textContent = ui.unread > 99 ? '99+' : String(ui.unread);
    scheduleRender();
  }
  messages.append(message);
});
client.addEventListener('text-failed', (event) => messages.markFailed(event.detail));

const composer = $('chatInput');

function autoGrowComposer() {
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(composer.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
}

function sendComposer() {
  const text = composer.value.trim();
  if (!text) {
    return;
  }
  const html = escapeHtml(text).replace(/\n/g, '<br />');
  if (client.sendText(html, sendScope())) {
    composer.value = '';
    autoGrowComposer();
  }
}

async function sendImage(file) {
  try {
    const html = await imageToHtml(file, client.serverInfo.imageMessageLength || DEFAULT_IMAGE_LIMIT);
    client.sendText(html, sendScope());
  } catch (error) {
    toast(error.message, 'warn');
  }
}

const firstImageFile = (files) => [...files].find((file) => file.type.startsWith('image/'));

composer.addEventListener('input', autoGrowComposer);
composer.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('chatForm').requestSubmit();
  }
});
composer.addEventListener('paste', (event) => {
  const file = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'))?.getAsFile();
  if (file) {
    event.preventDefault();
    sendImage(file);
  }
});
$('chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  sendComposer();
});
$('imageBtn').onclick = () => $('imageInput').click();
$('imageInput').onchange = () => {
  const file = $('imageInput').files[0];
  if (file) {
    sendImage(file);
  }
  $('imageInput').value = '';
};
$('messages').addEventListener('dragover', (event) => event.preventDefault());
$('messages').addEventListener('drop', (event) => {
  event.preventDefault();
  const file = firstImageFile(event.dataTransfer.files);
  if (file) {
    sendImage(file);
  }
});
$('viewer').onclick = () => {
  $('viewer').hidden = true;
};

function voiceSummary() {
  const parts = [client.stats.udp?.up ? `UDP through the bridge · ${client.stats.udp.rtt} ms` : 'TCP tunnel'];
  parts.push(client.wireFormat === 'protobuf' ? 'Mumble 1.5 packets' : 'legacy packets');
  if (client.stats.stalls) {
    parts.push(`${client.stats.stalls} delivery stalls`);
  }
  if (audio.stats.underruns) {
    parts.push(`${audio.stats.underruns} playback underruns`);
  }
  if (audio.stats.captureStalls) {
    parts.push(`${audio.stats.captureStalls} capture stalls`);
  }
  return parts.join(' · ');
}

function serverFacts() {
  const info = client.serverInfo;
  const version = info.version ?? {};
  const imageKb = Math.round((info.imageMessageLength ?? DEFAULT_IMAGE_LIMIT) / 1024);
  return [
    ['Server', `${version.release ?? 'Mumble'}${version.os ? ` on ${version.os}` : ''}`],
    ['People', `${client.users.size}${info.maxUsers ? ` of ${info.maxUsers}` : ''}`],
    ['Channels', String(client.channels.size)],
    ['Voice', voiceSummary()],
    ['Ping', client.stats.tcpPingMs ? `${client.stats.tcpPingMs} ms` : '…'],
    ['You', `${client.myUser?.name ?? ''} · session ${client.me ?? ''}`],
    ['Limits', `${info.messageLength ?? DEFAULT_MESSAGE_LIMIT} chars, images ${imageKb} KB${info.allowHtml === false ? ', no HTML' : ''}`],
  ];
}

function card(title, ...children) {
  return el('div', { className: 'card' }, el('h3', { textContent: title }), ...children);
}

function logText() {
  return client.log.map((entry) => `${entry.date.toISOString()} [${entry.tag}] ${entry.message}`).join('\n');
}

async function copyLog() {
  try {
    await navigator.clipboard.writeText(logText());
    toast('Log copied');
  } catch {
    toast('Could not copy', 'warn');
  }
}

function renderServerPane() {
  if (document.body.dataset.tab !== 'server') {
    return;
  }
  const pane = $('serverPane');
  pane.replaceChildren();

  const welcome = card(ui.target ? serverLabel(ui.target) : '');
  if (client.serverInfo.welcomeText) {
    const text = el('div', { className: 'welcome' });
    text.append(sanitize(client.serverInfo.welcomeText));
    welcome.append(text);
  }
  pane.append(welcome);

  const facts = el('dl', { className: 'kv' });
  for (const [key, value] of serverFacts()) {
    facts.append(el('dt', { textContent: key }), el('dd', { textContent: value }));
  }
  pane.append(card('Connection', facts));

  const recent = client.log
    .slice(-LOG_TAIL)
    .map((entry) => `${entry.date.toLocaleTimeString([], { hour12: false })} [${entry.tag}] ${entry.message}`)
    .join('\n');
  const log = el('pre', { className: 'diag', textContent: recent || 'Nothing yet.' });
  const copy = el('button', { type: 'button', className: 'ghost', textContent: 'Copy log', onclick: copyLog });
  pane.append(card('Log', log, el('div', { className: 'row', style: 'margin-top:8px' }, copy)));
  log.scrollTop = log.scrollHeight;
}

client.addEventListener('log', () => {
  if (document.body.dataset.tab === 'server') {
    scheduleRender();
  }
  renderDiagnostics();
});

const TRANSMIT_STATUS = {
  vad: () => 'Voice activity',
  ptt: () => 'Push to talk',
  continuous: () => 'Always on',
};

function renderMePanel() {
  const me = client.myUser;
  const displayName = me?.name ?? ui.target?.username ?? '?';
  const picture = avatar(displayName, 'l');
  picture.id = 'meAvatar';
  picture.classList.add('presence', me ? presence(me, treeContext())[1] : 'invisible');
  picture.append(el('span', { className: 'sdot' }));
  if (audio.isTransmitting && !audio.muted) {
    picture.classList.add('speaking');
  }
  $('meAvatar').replaceWith(picture);
  $('meName').textContent = me?.name ?? ui.target?.username ?? '—';
  const status = $('meStatus');
  status.className = 'sub';
  if (audio.captureError) {
    status.textContent = audio.captureError;
    status.classList.add('warn');
  } else if (audio.deafened) {
    status.textContent = 'Deafened';
  } else if (audio.muted) {
    status.textContent = 'Muted';
  } else {
    status.textContent = TRANSMIT_STATUS[settings.transmitMode]?.() ?? '';
  }
}

function renderPanels() {
  $('meChannel').textContent = client.myChannel?.name ?? '—';
  renderMePanel();
  for (const button of [$('muteBtn'), $('vsMute')]) {
    button.innerHTML = ICON[audio.muted ? 'micOff' : 'mic'];
    button.classList.toggle('active', audio.muted);
    button.dataset.tip = audio.muted ? 'Unmute' : 'Mute';
  }
  $('voiceStrip').hidden = !client.isConnected;
  $('voiceBtn').hidden = !client.isConnected;
  $('vsChan').textContent = client.myChannel?.name ?? '';
  renderTalkers($('vsTalkers'));
  $('deafBtn').innerHTML = ICON[audio.deafened ? 'headphonesOff' : 'headphones'];
  $('deafBtn').classList.toggle('active', audio.deafened);
  $('deafBtn').dataset.tip = audio.deafened ? 'Undeafen' : 'Deafen';
  $('pttBtn').hidden = settings.transmitMode !== 'ptt';
  $('pttBtn').textContent = `Hold to talk · ${keyLabel(settings.pttKey)}`;
  $('pttBtn').classList.toggle('active', audio.pttPressed);
  $('meter').hidden = settings.transmitMode === 'ptt';
  $('meter').classList.toggle('muted', audio.muted);
  $('micStatus').textContent = audio.captureError ? `${audio.captureError}. Check the site permissions in the address bar.` : '';
  $('shareBtn').classList.toggle('active', !!share.sharing);
  $('shareBtn').innerHTML = `${ICON[share.sharing ? 'screenOff' : 'screen']}<span>${share.sharing ? 'Stop sharing' : 'Share screen'}</span>`;
  const screenLive = !!(share.watching || share.available.size || share.sharing);
  $('screenBtn').hidden = !screenLive;
  $('screenBtn').classList.toggle('live', !!(share.available.size && !share.watching));
  renderTalkers();
}

function renderTalkers(box = $('talkers')) {
  box.replaceChildren();
  const talking = [...client.users.values()].filter(
    (user) => user.talking || (user.session === client.me && audio.isTransmitting && !audio.muted)
  );
  if (!talking.length) {
    return;
  }
  const stack = el('span', { className: 'stack' });
  for (const user of talking.slice(0, 4)) {
    stack.append(avatar(user.name, 'xs'));
  }
  const names = talking.map((user) => (user.session === client.me ? 'you' : user.name)).join(', ');
  box.append(stack, el('span', { textContent: names }));
}

function refreshMe() {
  renderPanels();
  if (client.myUser) {
    refreshUser(client.myUser, treeContext());
  }
  if (document.body.dataset.tab === 'voice') {
    room.render();
  }
}

audio.addEventListener('state', refreshMe);
audio.addEventListener('transmit', refreshMe);

const meterPercent = (db) => Math.max(0, Math.min(100, ((db - METER_FLOOR_DB) / METER_RANGE_DB) * 100));

function thresholdLabel() {
  return `${Math.round(audio.thresholdDb)} dB${settings.autoSensitivity ? ' auto' : ''}`;
}

function floorHint() {
  if (settings.autoSensitivity) {
    return `Room noise is about ${Math.round(audio.noiseFloorDb)} dB; the gate opens 12 dB above it and follows the room.`;
  }
  return 'Fixed threshold. Turn on automatic sensitivity to follow the room.';
}

audio.addEventListener('level', () => {
  const level = meterPercent(audio.inputLevelDb);
  const mark = meterPercent(audio.thresholdDb);
  $('meterFill').style.width = `${level}%`;
  $('meterFill').classList.toggle('open', audio.isTransmitting);
  $('meterMark').style.left = `${mark}%`;
  $('meterMark').hidden = settings.transmitMode !== 'vad';
  if (!$('settings').hidden) {
    $('sMeterFill').style.width = `${level}%`;
    $('sMeterMark').style.left = `${mark}%`;
    $('thresholdLabel').textContent = thresholdLabel();
    $('floorHint').textContent = floorHint();
  }
});

for (const id of ['muteBtn', 'vsMute']) {
  $(id).onclick = () => audio.setMuted(!audio.muted);
}
$('deafBtn').onclick = () => audio.setDeafened(!audio.deafened);
$('vsLeave').onclick = leave;
$('vsGo').onclick = () => showTab('voice');
$('vpGo').onclick = () => showTab('voice');
$('pttBtn').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  audio.setPTT(true);
});
for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('pttBtn').addEventListener(eventName, () => audio.setPTT(false));
}

const TYPING_PATTERN = /^(Key|Digit|Numpad|Space|Backquote|Minus|Equal|Bracket|Semicolon|Quote|Comma|Period|Slash|Backslash|Enter|Backspace)/;

function isTypingIn(event) {
  return /^(input|textarea|select)$/i.test(event.target.tagName) || event.target.isContentEditable;
}

function isPlainKey(code) {
  return TYPING_PATTERN.test(code);
}

function keyLabel(code) {
  if (!code) {
    return '—';
  }
  if (/^Mouse\d$/.test(code)) {
    return `Mouse ${code.slice(5)}`;
  }
  return code
    .replace(/^Key|^Digit/, '')
    .replace(/^Control(Left|Right)$/, '$1 Ctrl')
    .replace(/^Shift(Left|Right)$/, '$1 Shift')
    .replace(/^Alt(Left|Right)$/, '$1 Alt')
    .replace(/^Meta(Left|Right)$/, '$1 Meta')
    .replace(/^Backquote$/, '`')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

function setPttKey(code) {
  settings.pttKey = code;
  saveSettings();
  endKeyRecording();
  renderPanels();
  renderSettings();
}

function endKeyRecording() {
  ui.recordingKey = false;
  $('pttKeyBtn')?.classList.remove('recording');
  renderSettings();
}

window.addEventListener('keydown', (event) => {
  if (ui.recordingKey) {
    event.preventDefault();
    if (event.key === 'Escape') {
      endKeyRecording();
    } else {
      setPttKey(event.code);
    }
    return;
  }
  if (event.key === 'Escape') {
    $('viewer').hidden = true;
    if (!$('settings').hidden) {
      toggleSettings(false);
    }
    return;
  }
  const blockedByTyping = isTypingIn(event) && isPlainKey(event.code);
  if (event.code === settings.pttKey && ui.inSession && !blockedByTyping) {
    event.preventDefault();
    if (!event.repeat) {
      audio.setPTT(true);
    }
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === settings.pttKey && audio.pttPressed) {
    event.preventDefault();
    audio.setPTT(false);
  }
});
window.addEventListener('mousedown', (event) => {
  const code = `Mouse${event.button}`;
  if (ui.recordingKey && event.button >= MOUSE_BUTTON_AS_PTT_FROM) {
    event.preventDefault();
    setPttKey(code);
    return;
  }
  if (code === settings.pttKey && ui.inSession) {
    event.preventDefault();
    audio.setPTT(true);
  }
});
window.addEventListener('mouseup', (event) => {
  if (`Mouse${event.button}` === settings.pttKey && audio.pttPressed) {
    audio.setPTT(false);
  }
});
window.addEventListener('contextmenu', (event) => {
  if (settings.pttKey === 'Mouse2') {
    event.preventDefault();
  }
});
window.addEventListener('blur', () => audio.setPTT(false));

$('shareBtn').hidden = !ScreenShare.supported;
$('shareBtn').onclick = async () => {
  if (share.sharing) {
    share.stop();
    return;
  }
  try {
    await share.start();
    showTab('screen');
  } catch (error) {
    if (error.name !== 'NotAllowedError') {
      toast(`Can't share: ${error.message}`, 'warn');
    }
  }
};
mountStage({ share, client, stage: $('stage'), tabs: [$('screenBtn')], showTab, toast, applySink: (element) => audio.applySink(element) });

function toggleSettings(open = $('settings').hidden) {
  $('settings').hidden = !open;
  if (open) {
    renderSettings();
  } else {
    endKeyRecording();
  }
}

$('settingsBtn').onclick = () => toggleSettings();
$('railSettings').onclick = () => toggleSettings();
$('settingsClose').onclick = () => toggleSettings(false);

function bindSegmented(id, value, onChange) {
  for (const button of $(id).querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.value === String(value));
    button.onclick = () => {
      onChange(button.dataset.value);
      saveSettings();
      renderSettings();
      renderPanels();
    };
  }
}

const TRANSMIT_HINT = {
  vad: () => `Opens the mic when it hears you. ${keyLabel(settings.pttKey)} talks too.`,
  ptt: () => `Hold ${keyLabel(settings.pttKey)} or the button.`,
  continuous: () => 'Always sending while unmuted.',
};

const NOISE_HINT = {
  off: () => 'Only the browser’s own echo cancellation.',
  light: () => 'Spectral suppressor, −10 dB on steady hiss, fans and hum.',
  strong: () => 'Spectral suppressor at −22 dB plus a keyboard-click ducker.',
  neural: () =>
    `RNNoise, the neural denoiser Mumble desktop uses: removes hiss, fans, keyboards and babble and tells the voice gate what is speech.${
      audio.neural === false ? ' Not available here — falling back to Strong.' : ''
    }`,
};

function ensurePttKeyRow() {
  if ($('pttKeyRow')) {
    return;
  }
  const row = el(
    'div',
    { id: 'pttKeyRow', className: 'row between', style: 'margin-top:8px' },
    el('span', { className: 'hint', textContent: 'Push-to-talk key' }),
    el('button', { id: 'pttKeyBtn', type: 'button', className: 'keycap' })
  );
  $('transmitHint').after(row);
  $('pttKeyBtn').onclick = () => {
    ui.recordingKey = !ui.recordingKey;
    $('pttKeyBtn').classList.toggle('recording', ui.recordingKey);
    $('pttKeyBtn').textContent = ui.recordingKey ? 'Press a key…' : keyLabel(settings.pttKey);
  };
}

function renderThemeSwatches() {
  $('themes').replaceChildren(
    ...Object.entries(THEMES).map(([name, theme]) => {
      const swatch = el('button', { type: 'button', className: `swatch${settings.theme === name ? ' on' : ''}` });
      swatch.dataset.tip = theme.title;
      swatch.style.setProperty('--sw-bg', theme.bg);
      swatch.style.setProperty('--sw-accent', theme.accent);
      swatch.onclick = () => {
        settings.theme = name;
        saveSettings();
        applyTheme(name);
        renderSettings();
      };
      return swatch;
    })
  );
}

function renderSettings() {
  bindSegmented('transmitMode', settings.transmitMode, (value) => {
    settings.transmitMode = value;
  });
  $('transmitHint').textContent = TRANSMIT_HINT[settings.transmitMode]();
  ensurePttKeyRow();
  if (!ui.recordingKey) {
    $('pttKeyBtn').textContent = keyLabel(settings.pttKey);
  }
  bindSegmented('bitrate', settings.bitrate, (value) => audio.setBitrate(Number(value)));
  bindSegmented('noiseSuppression', settings.noiseSuppression, (value) => audio.setNoiseSuppression(value));
  $('procEcho').checked = settings.processing.echo !== false;
  $('procNoise').checked = !!settings.processing.noise;
  $('procGain').checked = settings.processing.gain !== false;
  $('noiseHint').textContent = NOISE_HINT[settings.noiseSuppression]?.() ?? '';
  bindSegmented('textSize', settings.textSize, (value) => {
    settings.textSize = Number(value);
    applyTextSize(value);
  });
  $('autoSens').checked = settings.autoSensitivity;
  $('threshold').value = settings.autoSensitivity ? Math.round(audio.thresholdDb) : settings.vadThresholdDb;
  $('threshold').disabled = settings.autoSensitivity;
  $('thresholdLabel').textContent = thresholdLabel();
  renderThemeSwatches();
  $('stunUrl').value = settings.stun ?? '';
  $('turnUrl').value = settings.turn.url;
  $('turnUser').value = settings.turn.username;
  $('turnPass').value = settings.turn.credential;
  $('shareAudio').checked = settings.shareAudio !== false;
  renderDevices();
  renderPanels();
}

function fillDeviceSelect(select, devices, fallbackLabel, chosen) {
  const genericName = fallbackLabel.replace(/^(Default|System) /, '');
  select.replaceChildren(
    el('option', { value: '', textContent: fallbackLabel }),
    ...devices.map((device, index) => el('option', { value: device.deviceId, textContent: device.label || `${genericName} ${index + 1}` }))
  );
  select.value = devices.some((device) => device.deviceId === chosen) ? chosen : '';
}

function outputStatus(outputs) {
  if (!AudioEngine.canPickOutput) {
    return 'This browser always uses the system default. Chrome and Edge can choose.';
  }
  if (outputs.some((device) => device.label)) {
    return 'Voice and a shared screen’s audio both follow this.';
  }
  return 'Allow the microphone once and the device names appear here.';
}

async function renderDevices() {
  fillDeviceSelect($('micSelect'), [], 'Default microphone', '');
  fillDeviceSelect($('outSelect'), [], 'System default', '');
  $('outSelect').disabled = !AudioEngine.canPickOutput;
  const [inputs, outputs] = await Promise.all([audio.inputDevices(), audio.outputDevices()]);
  fillDeviceSelect($('micSelect'), inputs, 'Default microphone', settings.inputDeviceId);
  fillDeviceSelect($('outSelect'), outputs, 'System default', settings.outputDeviceId);
  $('outStatus').textContent = outputStatus(outputs);
}

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (!$('settings').hidden) {
    renderDevices();
  }
});

for (const [id, key] of [
  ['procEcho', 'echo'],
  ['procNoise', 'noise'],
  ['procGain', 'gain'],
]) {
  $(id).onchange = async () => {
    await audio.setProcessing({ [key]: $(id).checked });
    saveSettings();
  };
}
$('autoSens').onchange = () => {
  settings.autoSensitivity = $('autoSens').checked;
  saveSettings();
  renderSettings();
};
$('threshold').oninput = () => {
  settings.vadThresholdDb = Number($('threshold').value);
  saveSettings();
  $('thresholdLabel').textContent = `${settings.vadThresholdDb} dB`;
};
$('micSelect').onchange = async () => {
  await audio.setInputDevice($('micSelect').value);
  saveSettings();
};
$('outSelect').onchange = async () => {
  await audio.setOutputDevice($('outSelect').value);
  saveSettings();
};
for (const [id, key] of [
  ['turnUrl', 'url'],
  ['turnUser', 'username'],
  ['turnPass', 'credential'],
]) {
  $(id).onchange = () => {
    settings.turn[key] = $(id).value.trim();
    saveSettings();
  };
}
$('stunUrl').onchange = () => {
  settings.stun = $('stunUrl').value.trim();
  saveSettings();
};
$('shareAudio').onchange = () => {
  settings.shareAudio = $('shareAudio').checked;
  saveSettings();
};

function iceVerdict(result) {
  const has = (type) => type in result.types;
  if (!has('host')) {
    return 'Something is blocking WebRTC entirely in this browser.';
  }
  if (!has('srflx') && !has('relay')) {
    return 'No public address: UDP to the STUN server is blocked here, so you can only reach people on the same network. A relay on port 443 would get through.';
  }
  if (has('relay')) {
    return 'Fine. Even a network that blocks direct connections has the relay to fall back on.';
  }
  return 'Direct connections should work unless the other end is also behind a strict NAT. Without a relay there is no fallback if they are.';
}

$('iceTest').onclick = async () => {
  const output = $('iceResult');
  output.hidden = false;
  output.textContent = 'Gathering…';
  $('iceTest').disabled = true;
  const result = await probeIce(settings);
  const has = (type) => type in result.types;
  const relayLine = has('relay') ? 'yes' : result.turn ? 'no — the relay did not answer' : 'not configured';
  const lines = [
    `local address        ${has('host') ? 'yes' : 'no'}`,
    `public address       ${has('srflx') ? `yes — ${result.types.srflx}` : 'no'}`,
    `relay                ${relayLine}`,
    `gathering            ${result.how} in ${result.seconds}s`,
  ];
  if (result.error) {
    lines.push(`error                ${result.error}`);
  }
  lines.push('', iceVerdict(result));
  output.textContent = lines.join('\n');
  client.diag('share', `connection test — ${Object.keys(result.types).join(', ') || 'nothing gathered'}`);
  $('iceTest').disabled = false;
};

function renderDiagnostics() {
  const log = $('diag');
  if (log.hidden) {
    return;
  }
  log.textContent = logText() || 'Nothing yet.';
  log.scrollTop = log.scrollHeight;
}

$('diagBtn').onclick = () => {
  const log = $('diag');
  log.hidden = !log.hidden;
  $('diagBtn').textContent = log.hidden ? 'Show log' : 'Hide log';
  renderDiagnostics();
};
$('diagCopy').onclick = copyLog;

const TOAST_ICONS = { join: 'userPlus', leave: 'userMinus', move: 'join', warn: 'warn', info: 'info' };

function toast(text, kind = 'info') {
  const icon = TOAST_ICONS[kind] ?? 'info';
  const element = el('div', { className: `toast ${kind}`, innerHTML: ICON[icon] }, el('span', { textContent: text }));
  $('toasts').append(element);
  setTimeout(
    () => {
      element.classList.add('out');
      setTimeout(() => element.remove(), TOAST_FADE_MS);
    },
    kind === 'warn' ? WARN_TOAST_MS : TOAST_MS
  );
  while ($('toasts').children.length > MAX_TOASTS) {
    $('toasts').firstChild.remove();
  }
}

client.addEventListener('notice', (event) => toast(event.detail.text, event.detail.kind));

applyLayout();
showTab('chat');
showConnect(true);
renderPanels();
if (location.hash === '#auto' && servers[0]) {
  connect(servers[0]);
}
