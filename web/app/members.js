import { el, activate } from './ui.js';
import { presence, statusAvatar } from './tree.js';
import { compareChannels } from './client.js';

export function renderMembers(container, countElement, ctx) {
  const { client } = ctx;
  const fragment = document.createDocumentFragment();
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
    const users = client.usersIn(channel.channelId);
    if (!users.length) {
      continue;
    }
    const heading = channel.channelId === myChannelId ? `In #${channel.name}` : `#${channel.name}`;
    fragment.append(
      el(
        'div',
        { className: 'mcat' },
        el('span', { textContent: heading }),
        el('span', { className: 'n', textContent: String(users.length) })
      )
    );
    for (const user of users) {
      fragment.append(memberRow(user, ctx));
    }
  }
  container.replaceChildren(fragment);
  if (countElement) {
    countElement.textContent = String(client.users.size);
  }
}

function memberRow(user, ctx) {
  const isMe = user.session === ctx.client.me;
  const [statusText, statusClass] = presence(user, ctx);
  const row = el('div', { className: `member${isMe ? ' me' : ''}${statusClass === 'speaking' ? ' talking' : ''}` });
  row.dataset.session = user.session;
  const column = el('span', { className: 'col' }, el('span', { className: 'name', textContent: user.name ?? '…' }));
  if (statusText) {
    column.append(el('span', { className: `status ${statusClass}`, textContent: statusText }));
  }
  row.append(statusAvatar(user, ctx, 'm'), column);
  activate(row, () => ctx.onUser(row, user));
  return row;
}
