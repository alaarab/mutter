import { el, activate, keyedRows } from './ui.js';
import { presence, presenceAvatar } from './tree.js';
import { compareChannels } from './client.js';

export function renderMembers(container, countElement, ctx) {
  const { client } = ctx;
  const roster = client.roster();
  const rows = keyedRows(container);
  const myChannelId = client.myChannel?.channelId ?? 0;
  const channels = [...client.channels.values()].sort((a, b) => {
    if (a.channelId === myChannelId) {
      return -1;
    }
    if (b.channelId === myChannelId) {
      return 1;
    }
    return compareChannels(a, b);
  });
  for (const channel of channels) {
    const users = roster.users(channel.channelId);
    if (!users.length) {
      continue;
    }
    const heading = channel.channelId === myChannelId ? `In #${channel.name}` : `#${channel.name}`;
    const count = String(users.length);
    rows.add(`heading:${channel.channelId}`, JSON.stringify([heading, count]), () =>
      el('div', { className: 'mcat' }, el('span', { textContent: heading }), el('span', { className: 'n', textContent: count }))
    );
    for (const user of users) {
      addMemberRow(user, ctx, rows);
    }
  }
  rows.commit();
  if (countElement) {
    countElement.textContent = String(client.users.size);
  }
}

function addMemberRow(user, ctx, rows) {
  const [statusText, statusClass] = presence(user, ctx);
  const state = {
    session: user.session,
    name: user.name ?? '…',
    isMe: user.session === ctx.client.me,
    statusText,
    statusClass,
  };
  rows.add(`member:${user.session}`, JSON.stringify(state), () => memberRow(state, ctx));
}

function memberRow(state, ctx) {
  const { isMe, statusText, statusClass } = state;
  const row = el('div', { className: `member${isMe ? ' me' : ''}${statusClass === 'speaking' ? ' talking' : ''}` });
  row.dataset.session = state.session;
  const column = el('span', { className: 'col' }, el('span', { className: 'name', textContent: state.name }));
  if (statusText) {
    column.append(el('span', { className: `status ${statusClass}`, textContent: statusText }));
  }
  row.append(presenceAvatar(state.name, statusClass, 'm'), column);
  activate(row, () => ctx.onUser(row, ctx.client.users.get(state.session) ?? { session: state.session, name: state.name }));
  return row;
}
