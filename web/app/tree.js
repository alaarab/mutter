import { ICON } from './icons.js';
import { el, avatar, activate, clickWithoutBubbling } from './ui.js';
import { compareByName } from './client.js';

const STATUS_CLASSES = ['speaking', 'deaf', 'muted', 'live', 'online'];

export function renderTree(container, ctx) {
  const fragment = document.createDocumentFragment();
  const root = ctx.client.rootChannel;
  if (root && ctx.filter) {
    renderFiltered(fragment, ctx);
  } else if (root) {
    renderChannel(root, 0, fragment, ctx);
  }
  container.replaceChildren(fragment);
}

function renderFiltered(into, ctx) {
  const { client, filter } = ctx;
  const matches = (item) => (item.name ?? '').toLowerCase().includes(filter);
  for (const channel of [...client.channels.values()].sort(compareByName)) {
    if (matches(channel)) {
      into.append(channelRow(channel, 0, ctx, { flat: true }));
    }
  }
  for (const user of [...client.users.values()].sort(compareByName)) {
    if (matches(user)) {
      into.append(userRow(user, 0, ctx, client.channels.get(user.channelId)?.name));
    }
  }
  if (!into.childNodes.length) {
    into.append(el('p', { className: 'empty', textContent: 'Nothing matches.' }));
  }
}

function subtreeCount(client, channel) {
  let count = client.usersIn(channel.channelId).length;
  for (const child of client.children(channel.channelId)) {
    count += subtreeCount(client, child);
  }
  return count;
}

function renderChannel(channel, depth, into, ctx) {
  const { client } = ctx;
  const users = client.usersIn(channel.channelId);
  const children = client.children(channel.channelId);
  const collapsed = ctx.collapsed.has(channel.channelId) && !ctx.isCurrent(channel);
  into.append(channelRow(channel, depth, ctx, { collapsed, hasChildren: users.length + children.length > 0 }));
  if (collapsed) {
    return;
  }
  for (const user of users) {
    into.append(userRow(user, depth + 1, ctx));
  }
  for (const child of children) {
    renderChannel(child, depth + 1, into, ctx);
  }
}

function channelCount(channel, count, ctx) {
  if (ctx.isCurrent(channel) && ctx.unread) {
    return el('span', { className: 'count unread', textContent: ctx.unread > 99 ? '99+' : String(ctx.unread) });
  }
  if (count) {
    return el('span', { className: 'count', textContent: channel.maxUsers ? `${count}/${channel.maxUsers}` : String(count) });
  }
  return null;
}

function channelRow(channel, depth, ctx, { flat = false, collapsed = false, hasChildren = true } = {}) {
  const current = ctx.isCurrent(channel);
  const row = el('div', { className: `ch${current ? ' current' : ''}${collapsed ? ' collapsed' : ''}`, role: 'treeitem' });
  row.style.setProperty('--depth', depth);

  const disclosure = el('button', {
    type: 'button',
    className: `disc${hasChildren && !flat ? '' : ' empty'}`,
    innerHTML: ICON.chevron,
    tabIndex: -1,
  });
  clickWithoutBubbling(disclosure, () => ctx.onToggle(channel));
  row.append(disclosure, el('span', { className: 'hash', textContent: '#' }), el('span', { className: 'name', textContent: channel.name ?? '…' }));

  if (channel.temporary) {
    row.append(el('span', { className: 'flag', textContent: 'temp', title: 'Temporary channel' }));
  }
  const count = channelCount(channel, subtreeCount(ctx.client, channel), ctx);
  if (count) {
    row.append(count);
  }
  if (!current) {
    const join = el('button', { type: 'button', className: 'join', innerHTML: ICON.join });
    join.dataset.tip = 'Join';
    clickWithoutBubbling(join, () => ctx.onJoin(channel));
    row.append(join);
  }
  activate(row, () => ctx.onChannel(row, channel));
  return row;
}

export function presence(user, ctx) {
  const isMe = user.session === ctx.client.me;
  if (user.talking || (isMe && ctx.audio.isTransmitting)) {
    return ['Speaking', 'speaking'];
  }
  if (user.selfDeaf || user.deaf) {
    return [user.deaf ? 'Deafened by server' : 'Deafened', 'deaf'];
  }
  if (user.selfMute || user.mute || user.suppress) {
    const label = user.mute ? 'Muted by server' : user.suppress ? 'Suppressed' : 'Muted';
    return [label, 'muted'];
  }
  if (ctx.share.available.has(user.session) || (isMe && ctx.share.sharing)) {
    return ['Sharing screen', 'live'];
  }
  if (user.localMute) {
    return ['Muted for you', 'muted'];
  }
  return ['', 'online'];
}

function statusGlyph(statusClass) {
  switch (statusClass) {
    case 'muted':
      return ICON.micOff;
    case 'deaf':
      return ICON.headphonesOff;
    case 'live':
      return ICON.screen;
    default:
      return '';
  }
}

export function statusAvatar(user, ctx, size = 's') {
  const [, statusClass] = presence(user, ctx);
  const element = avatar(user.name, size);
  element.classList.add('presence', statusClass);
  element.append(el('span', { className: 'sdot', innerHTML: statusGlyph(statusClass) }));
  return element;
}

function userRow(user, depth, ctx, channelName) {
  const isMe = user.session === ctx.client.me;
  const [statusText, statusClass] = presence(user, ctx);
  const row = el('div', { className: `user${isMe ? ' me' : ''}${statusClass === 'speaking' ? ' talking' : ''}`, role: 'treeitem' });
  row.dataset.session = user.session;
  row.style.setProperty('--depth', depth);

  const name = el('span', { className: 'name' }, el('span', { textContent: user.name ?? '…' }));
  if (isMe) {
    name.append(el('span', { className: 'you', textContent: 'you' }));
  }
  if (user.prioritySpeaker) {
    name.append(el('span', { className: 'star', title: 'Priority speaker', innerHTML: ICON.star }));
  }
  const column = el('span', { className: 'col' }, name);
  if (channelName) {
    const where = `#${channelName}${statusText ? ` · ${statusText}` : ''}`;
    column.append(el('span', { className: `status ${statusClass}`, textContent: where }));
  }
  row.append(statusAvatar(user, ctx, 's'), column);

  if (ctx.share.available.has(user.session)) {
    const watch = el('button', { type: 'button', className: 'live-badge', innerHTML: ICON.screen });
    watch.dataset.tip = 'Watch their screen';
    clickWithoutBubbling(watch, () => ctx.onWatch(user));
    row.append(watch);
  }
  activate(row, () => ctx.onUser(row, user));
  return row;
}

export function refreshUser(user, ctx) {
  const [statusText, statusClass] = presence(user, ctx);
  const rows = document.querySelectorAll(`.user[data-session="${user.session}"], .member[data-session="${user.session}"]`);
  for (const row of rows) {
    row.classList.toggle('talking', statusClass === 'speaking');
    const avatarElement = row.querySelector('.avatar.presence');
    if (avatarElement) {
      avatarElement.classList.remove(...STATUS_CLASSES);
      avatarElement.classList.add(statusClass);
      const dot = avatarElement.querySelector('.sdot');
      if (dot) {
        dot.innerHTML = statusGlyph(statusClass);
      }
    }
    const status = row.querySelector('.status:not(.avatar)');
    if (status && !status.textContent.startsWith('#')) {
      status.textContent = statusText;
      status.className = `status ${statusClass}`;
    }
  }
}
