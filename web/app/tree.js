// The channel tree: Revolt/Discord-style compact rows — a '#' icon, the name, a count, and the
// people in each channel listed underneath with their avatar and status.

import { ICON } from './icons.js';
import { el, avatar } from './ui.js';

/// `ctx`: { client, audio, share, collapsed, filter, isCurrent, onChannel, onUser, onJoin, onWatch }
export function renderTree(container, ctx) {
  const { client } = ctx;
  const frag = document.createDocumentFragment();
  const root = client.rootChannel;
  if (root && ctx.filter) renderFiltered(frag, ctx);
  else if (root) renderChannel(root, 0, frag, ctx);
  container.replaceChildren(frag);
}

function renderFiltered(into, ctx) {
  const { client, filter: q } = ctx;
  for (const c of [...client.channels.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) if ((c.name ?? '').toLowerCase().includes(q)) into.append(channelRow(c, 0, ctx, { flat: true }));
  for (const u of [...client.users.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) if ((u.name ?? '').toLowerCase().includes(q)) into.append(userRow(u, 0, ctx, client.channels.get(u.channelId)?.name));
  if (!into.childNodes.length) into.append(el('p', { className: 'empty', textContent: 'Nothing matches.' }));
}

function subtreeCount(client, c) { let n = client.usersIn(c.channelId).length; for (const k of client.children(c.channelId)) n += subtreeCount(client, k); return n; }

function renderChannel(c, depth, into, ctx) {
  const { client } = ctx;
  const users = client.usersIn(c.channelId), kids = client.children(c.channelId);
  const collapsed = ctx.collapsed.has(c.channelId) && !ctx.isCurrent(c);
  into.append(channelRow(c, depth, ctx, { collapsed, hasChildren: users.length + kids.length > 0 }));
  if (collapsed) return;
  for (const u of users) into.append(userRow(u, depth + 1, ctx));
  for (const k of kids) renderChannel(k, depth + 1, into, ctx);
}

function channelRow(c, depth, ctx, { flat = false, collapsed = false, hasChildren = true } = {}) {
  const { client } = ctx;
  const current = ctx.isCurrent(c);
  const row = el('div', { className: `ch${current ? ' current' : ''}${collapsed ? ' collapsed' : ''}`, role: 'treeitem' });
  row.style.setProperty('--depth', depth);
  const disc = el('button', { type: 'button', className: `disc${hasChildren && !flat ? '' : ' empty'}`, innerHTML: ICON.chevron, tabIndex: -1 });
  disc.onclick = e => { e.stopPropagation(); ctx.onToggle(c); };
  const n = subtreeCount(client, c);
  row.append(disc, el('span', { className: 'hash', textContent: '#' }), el('span', { className: 'name', textContent: c.name ?? '…' }));
  if (c.temporary) row.append(el('span', { className: 'flag', textContent: 'temp', title: 'Temporary channel' }));
  if (n) row.append(el('span', { className: 'count', textContent: c.maxUsers ? `${n}/${c.maxUsers}` : String(n) }));
  if (!current) {
    const join = el('button', { type: 'button', className: 'join', 'data-tip': 'Join', innerHTML: ICON.join });
    join.dataset.tip = 'Join';
    join.onclick = e => { e.stopPropagation(); ctx.onJoin(c); };
    row.append(join);
  }
  row.onclick = () => ctx.onChannel(row, c);
  row.oncontextmenu = e => { e.preventDefault(); ctx.onChannel(row, c); };
  return row;
}

/// Presence for one user, shared with the member list: [label, css class].
export function presence(u, ctx) {
  const me = u.session === ctx.client.me;
  if (u.talking || (me && ctx.audio.isTransmitting)) return ['Speaking', 'speaking'];
  if (u.selfDeaf || u.deaf) return [u.deaf ? 'Deafened by server' : 'Deafened', 'deaf'];
  if (u.selfMute || u.mute || u.suppress) return [u.mute ? 'Muted by server' : u.suppress ? 'Suppressed' : 'Muted', 'muted'];
  if (ctx.share.available.has(u.session) || (me && ctx.share.sharing)) return ['Sharing screen', 'live'];
  if (u.localMute) return ['Muted for you', 'muted'];
  return ['', 'online'];
}

/// Avatar with the status dot (and a mute/deaf glyph on it), as UserIcon does in Revolt.
export function statusAvatar(u, ctx, size = 's') {
  const [, cls] = presence(u, ctx);
  const av = avatar(u.name, size);
  av.classList.add('presence', cls);
  const dot = el('span', { className: 'sdot' });
  if (cls === 'muted') dot.innerHTML = ICON.micOff;
  else if (cls === 'deaf') dot.innerHTML = ICON.headphonesOff;
  else if (cls === 'live') dot.innerHTML = ICON.screen;
  av.append(dot);
  return av;
}

export function userRow(u, depth, ctx, where) {
  const { client } = ctx;
  const me = u.session === client.me;
  const [text, cls] = presence(u, ctx);
  const row = el('div', { className: `user${me ? ' me' : ''}${cls === 'speaking' ? ' talking' : ''}`, role: 'treeitem' });
  row.dataset.session = u.session;
  row.style.setProperty('--depth', depth);
  const name = el('span', { className: 'name' }, el('span', { textContent: u.name ?? '…' }));
  if (me) name.append(el('span', { className: 'you', textContent: 'you' }));
  if (u.prioritySpeaker) name.append(el('span', { className: 'star', title: 'Priority speaker', innerHTML: ICON.star }));
  // One line in the tree (the status dot says the rest); a second line only in search results.
  const col = el('span', { className: 'col' }, name);
  if (where) col.append(el('span', { className: `status ${cls}`, textContent: `#${where}${text ? ` · ${text}` : ''}` }));
  row.append(statusAvatar(u, ctx, 's'), col);
  if (ctx.share.available.has(u.session)) {
    const b = el('button', { type: 'button', className: 'live-badge', innerHTML: ICON.screen });
    b.dataset.tip = 'Watch their screen';
    b.onclick = e => { e.stopPropagation(); ctx.onWatch(u); };
    row.append(b);
  }
  row.onclick = () => ctx.onUser(row, u);
  row.oncontextmenu = e => { e.preventDefault(); ctx.onUser(row, u); };
  return row;
}

/// Cheap in-place refresh of one user's presence in every rendered row.
export function refreshUser(u, ctx) {
  const [text, cls] = presence(u, ctx);
  for (const row of document.querySelectorAll(`.user[data-session="${u.session}"], .member[data-session="${u.session}"]`)) {
    row.classList.toggle('talking', cls === 'speaking');
    const av = row.querySelector('.avatar.presence');
    if (av) { av.className = av.className.replace(/\b(speaking|deaf|muted|live|online)\b/g, '').trim() + ` ${cls}`; const d = av.querySelector('.sdot'); if (d) d.innerHTML = cls === 'muted' ? ICON.micOff : cls === 'deaf' ? ICON.headphonesOff : cls === 'live' ? ICON.screen : ''; }
    const s = row.querySelector('.status:not(.avatar)');
    if (s && !s.textContent.startsWith('#')) { s.textContent = text; s.className = `status ${cls}`; }
  }
}
