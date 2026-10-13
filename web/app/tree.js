import { ICON } from './icons.js';
import { el, avatar, activate, clickWithoutBubbling, keyedRows } from './ui.js';
import { compareByName } from './client.js';

const STATUS_CLASSES = ['speaking', 'deaf', 'muted', 'live', 'online'];

export function renderTree(container, ctx) {
  const focusedRow = focusedTreeRow(container);
  const rows = keyedRows(container);
  const root = ctx.client.rootChannel;
  const treeContext = { ...ctx, roster: ctx.client.roster(), rendered: new Set(), rows };
  if (root && ctx.filter) {
    renderFiltered(treeContext);
  } else if (root) {
    renderChannel(root, 0, treeContext);
  }
  rows.commit();
  restoreRovingFocus(container, focusedRow);
}

function treeRows(container) {
  return [...container.querySelectorAll('[role="treeitem"]')];
}

function focusedTreeRow(container) {
  const row = document.activeElement?.closest?.('[role="treeitem"]');
  if (!row || !container.contains(row)) {
    return null;
  }
  return { key: row.rowKey, index: treeRows(container).indexOf(row) };
}

function restoreRovingFocus(container, focusedRow) {
  const rows = treeRows(container);
  if (!rows.length) {
    return;
  }
  const rememberedKey = focusedRow?.key ?? container.activeRowKey;
  const fallbackIndex = Math.min(focusedRow?.index ?? 0, rows.length - 1);
  const target =
    rows.find((row) => row.rowKey === rememberedKey) ?? (focusedRow ? rows[fallbackIndex] : rows.find((row) => row.classList.contains('current'))) ?? rows[0];
  for (const row of rows) {
    row.tabIndex = row === target ? 0 : -1;
  }
  container.activeRowKey = target.rowKey;
  if (focusedRow && document.activeElement !== target) {
    target.focus({ preventScroll: true });
  }
}

function focusTreeRow(container, row) {
  if (!row) {
    return;
  }
  for (const other of treeRows(container)) {
    other.tabIndex = other === row ? 0 : -1;
  }
  container.activeRowKey = row.rowKey;
  row.focus();
}

function parentRow(rows, index) {
  const level = Number(rows[index].getAttribute('aria-level'));
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    if (Number(rows[candidate].getAttribute('aria-level')) < level) {
      return rows[candidate];
    }
  }
  return null;
}

export function bindTreeKeyboard(container) {
  container.addEventListener('focusin', (event) => {
    const row = event.target.closest?.('[role="treeitem"]');
    if (row && container.contains(row)) {
      for (const other of treeRows(container)) {
        other.tabIndex = other === row ? 0 : -1;
      }
      container.activeRowKey = row.rowKey;
    }
  });
  container.addEventListener('keydown', (event) => {
    const row = event.target;
    if (row.getAttribute?.('role') !== 'treeitem' || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const rows = treeRows(container);
    const index = rows.indexOf(row);
    const expanded = row.getAttribute('aria-expanded');
    switch (event.key) {
      case 'ArrowDown':
        focusTreeRow(container, rows[index + 1]);
        break;
      case 'ArrowUp':
        focusTreeRow(container, rows[index - 1]);
        break;
      case 'Home':
        focusTreeRow(container, rows[0]);
        break;
      case 'End':
        focusTreeRow(container, rows.at(-1));
        break;
      case 'ArrowRight':
        if (expanded === 'false') {
          row.toggleExpansion();
        } else if (expanded === 'true') {
          focusTreeRow(container, rows[index + 1]);
        }
        break;
      case 'ArrowLeft':
        if (expanded === 'true') {
          row.toggleExpansion();
        } else {
          focusTreeRow(container, parentRow(rows, index));
        }
        break;
      case 'Enter':
      case ' ':
        row.click();
        break;
      default:
        return;
    }
    event.preventDefault();
  });
}

function renderFiltered(ctx) {
  const { client, filter, rows } = ctx;
  const matches = (item) => (item.name ?? '').toLowerCase().includes(filter);
  for (const channel of [...client.channels.values()].sort(compareByName)) {
    if (matches(channel)) {
      addChannelRow(channel, 0, ctx, { flat: true });
    }
  }
  for (const user of [...client.users.values()].sort(compareByName)) {
    if (matches(user)) {
      addUserRow(user, 0, ctx, client.channels.get(user.channelId)?.name);
    }
  }
  if (!rows.size) {
    rows.add('empty', 'empty', () => el('p', { className: 'empty', textContent: 'Nothing matches.' }));
  }
}

function renderChannel(channel, depth, ctx) {
  if (ctx.rendered.has(channel.channelId)) {
    return;
  }
  ctx.rendered.add(channel.channelId);
  const users = ctx.roster.users(channel.channelId);
  const children = ctx.roster.children(channel.channelId);
  const collapsed = ctx.collapsed.has(channel.channelId) && !ctx.isCurrent(channel);
  addChannelRow(channel, depth, ctx, { collapsed, hasChildren: users.length + children.length > 0 });
  if (collapsed) {
    return;
  }
  for (const user of users) {
    addUserRow(user, depth + 1, ctx);
  }
  for (const child of children) {
    renderChannel(child, depth + 1, ctx);
  }
}

function channelCount(channel, count, ctx) {
  if (ctx.isCurrent(channel) && ctx.unread) {
    return { className: 'count unread', text: ctx.unread > 99 ? '99+' : String(ctx.unread) };
  }
  if (count) {
    return { className: 'count', text: channel.maxUsers ? `${count}/${channel.maxUsers}` : String(count) };
  }
  return null;
}

function addChannelRow(channel, depth, ctx, { flat = false, collapsed = false, hasChildren = true } = {}) {
  const state = {
    channelId: channel.channelId,
    name: channel.name ?? '…',
    depth,
    flat,
    collapsed,
    hasChildren,
    current: ctx.isCurrent(channel),
    temporary: !!channel.temporary,
    count: channelCount(channel, ctx.roster.subtreeCount(channel.channelId), ctx),
  };
  ctx.rows.add(`channel:${channel.channelId}`, JSON.stringify(state), () => channelRow(state, ctx));
}

function channelRow(state, ctx) {
  const { current, collapsed, flat, hasChildren } = state;
  const freshChannel = () => ctx.client.channels.get(state.channelId) ?? { channelId: state.channelId, name: state.name };
  const row = el('div', { className: `ch${current ? ' current' : ''}${collapsed ? ' collapsed' : ''}`, role: 'treeitem', tabIndex: -1 });
  row.style.setProperty('--depth', state.depth);
  row.setAttribute('aria-level', String(state.depth + 1));
  if (hasChildren && !flat) {
    row.setAttribute('aria-expanded', String(!collapsed));
    row.toggleExpansion = () => ctx.onToggle(freshChannel());
  }

  const disclosure = el('button', {
    type: 'button',
    className: `disc${hasChildren && !flat ? '' : ' empty'}`,
    innerHTML: ICON.chevron,
    tabIndex: -1,
  });
  clickWithoutBubbling(disclosure, () => ctx.onToggle(freshChannel()));
  row.append(disclosure, el('span', { className: 'hash', textContent: '#' }), el('span', { className: 'name', textContent: state.name }));

  if (state.temporary) {
    row.append(el('span', { className: 'flag', textContent: 'temp', title: 'Temporary channel' }));
  }
  if (state.count) {
    row.append(el('span', { className: state.count.className, textContent: state.count.text }));
  }
  if (!current) {
    const join = el('button', { type: 'button', className: 'join', innerHTML: ICON.join, tabIndex: -1 });
    join.dataset.tip = 'Join';
    clickWithoutBubbling(join, () => ctx.onJoin(freshChannel()));
    row.append(join);
  }
  activate(row, () => ctx.onChannel(row, freshChannel()));
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

export function presenceAvatar(name, statusClass, size = 's') {
  const element = avatar(name, size);
  element.classList.add('presence', statusClass);
  element.append(el('span', { className: 'sdot', innerHTML: statusGlyph(statusClass) }));
  return element;
}

function addUserRow(user, depth, ctx, channelName) {
  const [statusText, statusClass] = presence(user, ctx);
  const state = {
    session: user.session,
    name: user.name ?? '…',
    depth,
    isMe: user.session === ctx.client.me,
    prioritySpeaker: !!user.prioritySpeaker,
    statusText,
    statusClass,
    channelName: channelName ?? null,
    live: ctx.share.available.has(user.session),
  };
  ctx.rows.add(`user:${user.session}`, JSON.stringify(state), () => userRow(state, ctx));
}

function userRow(state, ctx) {
  const { isMe, statusText, statusClass, channelName } = state;
  const freshUser = () => ctx.client.users.get(state.session) ?? { session: state.session, name: state.name };
  const row = el('div', { className: `user${isMe ? ' me' : ''}${statusClass === 'speaking' ? ' talking' : ''}`, role: 'treeitem', tabIndex: -1 });
  row.dataset.session = state.session;
  row.style.setProperty('--depth', state.depth);
  row.setAttribute('aria-level', String(state.depth + 1));

  const name = el('span', { className: 'name' }, el('span', { textContent: state.name }));
  if (isMe) {
    name.append(el('span', { className: 'you', textContent: 'you' }));
  }
  if (state.prioritySpeaker) {
    name.append(el('span', { className: 'star', title: 'Priority speaker', innerHTML: ICON.star }));
  }
  const column = el('span', { className: 'col' }, name);
  if (channelName) {
    const where = `#${channelName}${statusText ? ` · ${statusText}` : ''}`;
    column.append(el('span', { className: `status ${statusClass}`, textContent: where }));
  }
  row.append(presenceAvatar(state.name, statusClass, 's'), column);

  if (state.live) {
    const watch = el('button', { type: 'button', className: 'live-badge', innerHTML: ICON.screen, tabIndex: -1 });
    watch.dataset.tip = 'Watch their screen';
    clickWithoutBubbling(watch, () => ctx.onWatch(freshUser()));
    row.append(watch);
  }
  activate(row, () => ctx.onUser(row, freshUser()));
  return row;
}

export function refreshUser(user, ctx) {
  const [statusText, statusClass] = presence(user, ctx);
  const rows = document.querySelectorAll(`.user[data-session="${user.session}"], .member[data-session="${user.session}"]`);
  for (const row of rows) {
    row.rowSignature = null;
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
