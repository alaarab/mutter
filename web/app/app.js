// Browser-side Mumble client. Speaks the protocol itself and uses the bridge purely as a
// byte pipe, so this shares src/mumble.js with the bridge and mirrors Mutter on iOS.

import {
  FrameParser, MessageType, decode, frame, versionMessage, authenticateMessage,
  pingMessage, REJECT_REASONS,
} from '../src/mumble.js';
import { Writer } from '../src/protobuf.js';

const $ = id => document.getElementById(id);
const state = { ws: null, parser: null, users: new Map(), channels: new Map(), me: null, ping: null };

const PALETTE = ['#3D9BFF', '#3DDC84', '#FF6B35', '#C084FC', '#2DD4A7', '#FFC53D', '#FF7AA2', '#A8E831'];
const colorFor = name => {
  let h = 5381;
  for (const ch of name) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

function setState(text, cls = '') {
  $('stateText').textContent = text;
  $('dot').className = `dot ${cls}`;
}

$('connectForm').addEventListener('submit', e => {
  e.preventDefault();
  $('error').hidden = true;
  connect({
    host: $('host').value.trim(),
    port: Number($('port').value) || 64738,
    username: $('username').value.trim() || 'MutterWeb',
    password: $('password').value || undefined,
  });
});

function connect(target) {
  $('connectBtn').disabled = true;
  setState('Connecting…');
  const ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  state.parser = new FrameParser();
  state.users.clear(); state.channels.clear(); state.me = null;

  ws.onopen = () => ws.send(JSON.stringify({ host: target.host, port: target.port }));

  ws.onmessage = ev => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data);
      if (msg.event === 'open') {
        setState('Authenticating…');
        send(versionMessage({ v1: (1 << 16) | (5 << 8), v2: (1n << 48n) | (5n << 32n), release: 'Mutter Web', os: 'Web', osVersion: '1' }));
        send(authenticateMessage({ username: target.username, password: target.password }));
      } else if (msg.event === 'error') fail(msg.message);
      return;
    }
    for (const f of state.parser.push(new Uint8Array(ev.data))) handleFrame(f);
  };

  ws.onclose = () => {
    clearInterval(state.ping);
    $('connectBtn').disabled = false;
    if (state.me) setState('Disconnected');
  };
  ws.onerror = () => fail('Could not reach the bridge. Is it running?');
}

const send = bytes => state.ws?.readyState === 1 && state.ws.send(bytes);

function fail(message) {
  $('error').textContent = message;
  $('error').hidden = false;
  setState('Not connected', 'bad');
  $('connectBtn').disabled = false;
}

function handleFrame({ type, payload }) {
  if (type === MessageType.udpTunnel) return;              // voice comes later
  const m = decode(type, payload);
  switch (type) {
    case MessageType.reject:
      fail(`${REJECT_REASONS[m.type] ?? 'Rejected'}${m.reason ? ` — ${m.reason}` : ''}`);
      state.ws.close(); break;
    case MessageType.channelState:
      state.channels.set(m.channelId, { ...state.channels.get(m.channelId), ...m }); break;
    case MessageType.userState: {
      const existing = state.users.get(m.session);
      state.users.set(m.session, { ...existing, ...m });
      if (state.me && !existing) systemMessage(`${m.name} connected`);
      renderUsers(); break;
    }
    case MessageType.userRemove: {
      const gone = state.users.get(m.session);
      state.users.delete(m.session);
      if (gone && state.me) systemMessage(`${gone.name} disconnected`);
      renderUsers(); break;
    }
    case MessageType.serverSync:
      state.me = m.session;
      $('connectForm').hidden = true;
      $('session').hidden = false;
      setState(`Connected · ${state.channels.get(state.users.get(m.session)?.channelId ?? 0)?.name ?? 'Root'}`, 'on');
      if (m.welcomeText) systemMessage(stripHtml(m.welcomeText));
      renderUsers();
      state.ping = setInterval(() => send(pingMessage(Date.now() * 1000)), 5000);
      break;
    case MessageType.textMessage: {
      const from = state.users.get(m.actor)?.name ?? 'Server';
      addMessage(from, stripHtml(m.message ?? ''), m.actor === state.me);
      break;
    }
    case MessageType.permissionDenied:
      systemMessage(m.reason ?? 'Permission denied'); break;
  }
}

// ---- chat ----

$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  const channelId = state.users.get(state.me)?.channelId ?? 0;
  // TextMessage: field 3 = channel_id (repeated), field 5 = message
  send(frame(MessageType.textMessage, new Writer().uint(3, channelId).string(5, escapeHtml(text)).finish()));
  addMessage(state.users.get(state.me)?.name ?? 'Me', text, true);
  $('chatInput').value = '';
});

const stripHtml = html => { const d = document.createElement('div'); d.innerHTML = html; return (d.textContent ?? '').trim(); };
const escapeHtml = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function addMessage(who, text, own) {
  if (!text) return;
  const el = document.createElement('div');
  el.className = `msg${own ? ' own' : ''}`;
  el.innerHTML = `<span class="who"></span><span class="text"></span>`;
  el.querySelector('.who').textContent = who;
  el.querySelector('.text').textContent = text;
  $('messages').append(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function systemMessage(text) {
  if (!text) return;
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  $('messages').append(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function renderUsers() {
  const list = $('users');
  list.replaceChildren();
  const sorted = [...state.users.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  for (const u of sorted) {
    const li = document.createElement('li');
    if (u.session === state.me) li.className = 'me';
    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.background = colorFor(u.name ?? '?');
    av.textContent = (u.name ?? '?')[0].toUpperCase();
    const name = document.createElement('span');
    name.textContent = u.name ?? '…';
    li.append(av, name);
    list.append(li);
  }
}
