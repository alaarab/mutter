// The member list on the right, grouped the way Revolt groups by role: your channel first,
// then every other channel with people in it. Rows carry the status-dot avatar.

import { el } from './ui.js';
import { presence, statusAvatar } from './tree.js';

/// `ctx`: { client, audio, share, onUser }
export function renderMembers(container, countEl, ctx) {
  const { client } = ctx;
  const frag = document.createDocumentFragment();
  const mine = client.myChannel?.channelId ?? 0;
  const groups = [];
  const channels = [...client.channels.values()].sort((a, b) => (a.channelId === mine ? -1 : b.channelId === mine ? 1 : (a.position ?? 0) - (b.position ?? 0) || (a.name ?? '').localeCompare(b.name ?? '')));
  for (const c of channels) {
    const users = client.usersIn(c.channelId);
    if (users.length) groups.push({ channel: c, users });
  }
  for (const g of groups) {
    frag.append(el('div', { className: 'mcat' }, el('span', { textContent: g.channel.channelId === mine ? `In #${g.channel.name}` : `#${g.channel.name}` }), el('span', { className: 'n', textContent: String(g.users.length) })));
    for (const u of g.users) frag.append(memberRow(u, ctx));
  }
  container.replaceChildren(frag);
  if (countEl) countEl.textContent = String(client.users.size);
}

function memberRow(u, ctx) {
  const me = u.session === ctx.client.me;
  const [text, cls] = presence(u, ctx);
  const row = el('div', { className: `member${me ? ' me' : ''}${cls === 'speaking' ? ' talking' : ''}` });
  row.dataset.session = u.session;
  const name = el('span', { className: 'name', textContent: u.name ?? '…' });
  const col = el('span', { className: 'col' }, name);
  if (text) col.append(el('span', { className: `status ${cls}`, textContent: text }));
  row.append(statusAvatar(u, ctx, 'm'), col);
  row.onclick = () => ctx.onUser(row, u);
  row.oncontextmenu = e => { e.preventDefault(); ctx.onUser(row, u); };
  return row;
}
