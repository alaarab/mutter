// The message list, laid out the way Revolt and Discord do it: a 62 px gutter with the avatar,
// author and time on the first line of a group, plain text lines underneath, later messages
// from the same person within seven minutes folded into the group with the time on hover.
// Day dividers, a "New messages" divider, system lines, and a hover toolbar per message.

import { sanitize, plainText } from './chat.js';
import { ICON } from './icons.js';
import { el, avatar, colorFor } from './ui.js';

const GROUP_MS = 7 * 60_000;

export class MessageList {
  /// `ctx`: { client, onImage, onQuote, onMessageUser, onMuteFor }
  constructor(container, ctx) {
    this.box = container;
    this.ctx = ctx;
    this.prev = null;
    this.pendingUnread = false;
    this.box.addEventListener('scroll', () => { this.atBottom = this.box.scrollHeight - this.box.scrollTop - this.box.clientHeight < 40; }, { passive: true });
    this.atBottom = true;
  }

  reset() { this.box.replaceChildren(); this.prev = null; this.pendingUnread = false; this.atBottom = true; }

  /// Call before appending messages that arrived while the chat wasn't visible.
  markUnreadFromHere() { this.pendingUnread = true; }
  clearUnread() { this.box.querySelector('.newmsgs')?.remove(); this.pendingUnread = false; }

  append(m) {
    const stick = this.atBottom || m.own;
    const p = this.prev;
    if (!p || dayKey(p.date) !== dayKey(m.date)) this.box.append(divider(dayLabel(m.date), 'day'));
    if (this.pendingUnread && !m.own && !m.scope?.system) { this.clearUnread(); this.box.append(divider('New messages', 'newmsgs')); this.pendingUnread = false; }
    this.box.append(m.scope?.system ? systemRow(m) : this.row(m, p));
    this.prev = m;
    while (this.box.children.length > 600) this.box.firstChild.remove();
    if (stick) this.box.scrollTop = this.box.scrollHeight;
  }

  row(m, p) {
    const { client } = this.ctx;
    const cont = p && !p.scope?.system && p.senderSession === m.senderSession && scopeKey(p.scope) === scopeKey(m.scope) && m.date - p.date < GROUP_MS && dayKey(p.date) === dayKey(m.date);
    const row = el('div', { className: `row${cont ? ' cont' : ''}${m.own ? ' own' : ''}` });
    row.dataset.id = m.id;
    if (m.senderSession !== undefined) row.dataset.session = m.senderSession;
    const gutter = el('div', { className: 'gutter' });
    const body = el('div', { className: 'body' });
    if (cont) gutter.append(el('time', { className: 'hover-time', textContent: shortTime(m.date) }));
    else {
      gutter.append(avatar(m.senderName, 'm'));
      const meta = el('div', { className: 'meta' }, el('span', { className: 'author', textContent: m.senderName ?? '…', style: `color:${colorFor(m.senderName)}` }));
      const tag = scopeTag(m.scope, client);
      if (tag) meta.append(el('span', { className: `tag${m.scope?.sessions?.length ? ' dm' : ''}`, textContent: tag }));
      meta.append(el('time', { textContent: longTime(m.date), title: m.date.toLocaleString() }));
      body.append(meta);
    }
    const content = el('div', { className: 'content' });
    content.append(sanitize(m.html));
    for (const img of content.querySelectorAll('img')) img.addEventListener('click', () => this.ctx.onImage?.(img.src));
    body.append(content);
    if (m.failed) body.append(el('div', { className: 'failed-note', textContent: `Not delivered · ${m.failed}` }));
    row.append(gutter, body, this.tools(m));
    return row;
  }

  tools(m) {
    const bar = el('div', { className: 'tools' });
    const tool = (icon, tip, fn) => { const b = el('button', { type: 'button', innerHTML: ICON[icon] }); b.dataset.tip = tip; b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
    bar.append(tool('quote', 'Quote', () => this.ctx.onQuote?.(m)));
    bar.append(tool('copy', 'Copy text', () => navigator.clipboard?.writeText(plainText(m.html)).catch(() => {})));
    if (!m.own && m.senderSession !== undefined && this.ctx.client.users.has(m.senderSession)) {
      bar.append(tool('message', 'Message them', () => this.ctx.onMessageUser?.(m.senderSession)));
      bar.append(tool('volumeOff', 'Mute for me', () => this.ctx.onMuteFor?.(m.senderSession)));
    }
    return bar;
  }

  markFailed(m) {
    const row = this.box.querySelector(`[data-id="${m.id}"]`);
    if (!row || row.classList.contains('failed')) return;
    row.classList.add('failed');
    row.querySelector('.body')?.append(el('div', { className: 'failed-note', textContent: `Not delivered · ${m.failed}` }));
  }
}

function systemRow(m) {
  const row = el('div', { className: 'row system' });
  row.dataset.id = m.id;
  const icon = /connected|joined/i.test(m.html) && !/disconnected/i.test(m.html) ? 'userPlus' : /disconnected|left|kicked|banned/i.test(m.html) ? 'userMinus' : /moved/i.test(m.html) ? 'join' : 'info';
  const gutter = el('div', { className: 'gutter', innerHTML: ICON[icon] });
  const body = el('div', { className: 'body' });
  const content = el('div', { className: 'content' });
  content.append(sanitize(m.html));
  body.append(content);
  row.append(gutter, body, el('time', { textContent: shortTime(m.date) }));
  return row;
}

const divider = (text, cls) => el('div', { className: `divider ${cls}` }, el('span', { textContent: text }));
const scopeKey = s => s?.sessions?.length ? `dm:${s.sessions.join(',')}` : s?.treeId !== undefined ? `tree:${s.treeId}` : `ch:${s?.channelId ?? 0}`;
function scopeTag(scope, client) {
  if (!scope) return null;
  if (scope.sessions?.length) return 'DM';
  if (scope.treeId !== undefined) return `#${client.channels.get(scope.treeId)?.name ?? 'channel'} +`;
  if (scope.channelId !== undefined && scope.channelId !== client.myChannel?.channelId) return `#${client.channels.get(scope.channelId)?.name ?? 'channel'}`;
  return null;
}
const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
function dayLabel(d) {
  const today = new Date(), yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (dayKey(d) === dayKey(today)) return 'Today';
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
const shortTime = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function longTime(d) {
  const today = new Date(), yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const t = shortTime(d);
  if (dayKey(d) === dayKey(today)) return `Today at ${t}`;
  if (dayKey(d) === dayKey(yesterday)) return `Yesterday at ${t}`;
  return `${d.toLocaleDateString()} ${t}`;
}

/// "Alpha is typing…" / "Alpha and Bravo are typing…" / "Several people are typing…"
export function typingText(names) {
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
  return 'Several people are typing…';
}
