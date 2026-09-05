import { sanitize, plainText } from './chat.js';
import { ICON } from './icons.js';
import { el, avatar, clickWithoutBubbling } from './ui.js';

const GROUP_WINDOW_MS = 7 * 60_000;
const MAX_ROWS = 600;
const BOTTOM_THRESHOLD_PX = 40;

export class MessageList {
  constructor(container, ctx) {
    this.box = container;
    this.ctx = ctx;
    this.previous = null;
    this.pendingUnread = false;
    this.atBottom = true;
    this.box.addEventListener(
      'scroll',
      () => {
        const distance = this.box.scrollHeight - this.box.scrollTop - this.box.clientHeight;
        this.atBottom = distance < BOTTOM_THRESHOLD_PX;
      },
      { passive: true }
    );
  }

  reset() {
    this.box.replaceChildren();
    this.previous = null;
    this.pendingUnread = false;
    this.atBottom = true;
  }

  markUnreadFromHere() {
    this.pendingUnread = true;
  }

  clearUnread() {
    this.box.querySelector('.newmsgs')?.remove();
    this.pendingUnread = false;
  }

  append(message) {
    const stick = this.atBottom || message.own;
    const previous = this.previous;
    if (!previous || dayKey(previous.date) !== dayKey(message.date)) {
      this.box.append(divider(dayLabel(message.date), 'day'));
    }
    if (this.pendingUnread && !message.own && !message.scope?.system) {
      this.clearUnread();
      this.box.append(divider('New messages', 'newmsgs'));
    }
    this.box.append(message.scope?.system ? systemRow(message) : this.row(message, previous));
    this.previous = message;
    while (this.box.children.length > MAX_ROWS) {
      this.box.firstChild.remove();
    }
    if (stick) {
      this.box.scrollTop = this.box.scrollHeight;
    }
  }

  row(message, previous) {
    const continues = continuesGroup(message, previous);
    const row = el('div', { className: `row${continues ? ' cont' : ''}${message.own ? ' own' : ''}` });
    row.dataset.id = message.id;
    if (message.senderSession !== undefined) {
      row.dataset.session = message.senderSession;
    }
    const gutter = el('div', { className: 'gutter' });
    const body = el('div', { className: 'body' });
    if (continues) {
      gutter.append(el('time', { className: 'hover-time', textContent: shortTime(message.date) }));
    } else {
      gutter.append(avatar(message.senderName, 'm'));
      body.append(this.meta(message));
    }
    const content = el('div', { className: 'content' });
    content.append(sanitize(message.html));
    for (const image of content.querySelectorAll('img')) {
      image.addEventListener('click', () => this.ctx.onImage?.(image.src));
    }
    body.append(content);
    if (message.failed) {
      body.append(failedNote(message));
    }
    row.append(gutter, body, this.tools(message));
    return row;
  }

  meta(message) {
    const meta = el('div', { className: 'meta' }, el('span', { className: 'author', textContent: message.senderName ?? '…' }));
    const tag = scopeTag(message.scope, this.ctx.client);
    if (tag) {
      meta.append(el('span', { className: `tag${message.scope?.sessions?.length ? ' dm' : ''}`, textContent: tag }));
    }
    meta.append(el('time', { textContent: longTime(message.date), title: message.date.toLocaleString() }));
    return meta;
  }

  tools(message) {
    const bar = el('div', { className: 'tools' });
    const tool = (icon, tip, action) => {
      const button = el('button', { type: 'button', innerHTML: ICON[icon] });
      button.dataset.tip = tip;
      clickWithoutBubbling(button, action);
      return button;
    };
    bar.append(tool('quote', 'Quote', () => this.ctx.onQuote?.(message)));
    bar.append(tool('copy', 'Copy text', () => navigator.clipboard?.writeText(plainText(message.html)).catch(() => {})));
    const senderOnline = message.senderSession !== undefined && this.ctx.client.users.has(message.senderSession);
    if (!message.own && senderOnline) {
      bar.append(tool('message', 'Message them', () => this.ctx.onMessageUser?.(message.senderSession)));
      bar.append(tool('volumeOff', 'Mute for me', () => this.ctx.onMuteFor?.(message.senderSession)));
    }
    return bar;
  }

  markFailed(message) {
    const row = this.box.querySelector(`[data-id="${message.id}"]`);
    if (!row || row.classList.contains('failed')) {
      return;
    }
    row.classList.add('failed');
    row.querySelector('.body')?.append(failedNote(message));
  }
}

function continuesGroup(message, previous) {
  if (!previous || previous.scope?.system) {
    return false;
  }
  return (
    previous.senderSession === message.senderSession &&
    scopeKey(previous.scope) === scopeKey(message.scope) &&
    message.date - previous.date < GROUP_WINDOW_MS &&
    dayKey(previous.date) === dayKey(message.date)
  );
}

function failedNote(message) {
  return el('div', { className: 'failed-note', textContent: `Not delivered · ${message.failed}` });
}

function systemIcon(html) {
  if (/connected|joined/i.test(html) && !/disconnected/i.test(html)) {
    return 'userPlus';
  }
  if (/disconnected|left|kicked|banned/i.test(html)) {
    return 'userMinus';
  }
  if (/moved/i.test(html)) {
    return 'join';
  }
  return 'info';
}

function systemRow(message) {
  const row = el('div', { className: 'row system' });
  row.dataset.id = message.id;
  const gutter = el('div', { className: 'gutter', innerHTML: ICON[systemIcon(message.html)] });
  const content = el('div', { className: 'content' });
  content.append(sanitize(message.html));
  const body = el('div', { className: 'body' }, content);
  row.append(gutter, body, el('time', { textContent: shortTime(message.date) }));
  return row;
}

function divider(text, kind) {
  return el('div', { className: `divider ${kind}` }, el('span', { textContent: text }));
}

function scopeKey(scope) {
  if (scope?.sessions?.length) {
    return `dm:${scope.sessions.join(',')}`;
  }
  if (scope?.treeId !== undefined) {
    return `tree:${scope.treeId}`;
  }
  return `ch:${scope?.channelId ?? 0}`;
}

function scopeTag(scope, client) {
  if (!scope) {
    return null;
  }
  if (scope.sessions?.length) {
    return 'DM';
  }
  if (scope.treeId !== undefined) {
    return `#${client.channels.get(scope.treeId)?.name ?? 'channel'} +`;
  }
  if (scope.channelId !== undefined && scope.channelId !== client.myChannel?.channelId) {
    return `#${client.channels.get(scope.channelId)?.name ?? 'channel'}`;
  }
  return null;
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function relativeDay(date) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) {
    return 'Today';
  }
  if (dayKey(date) === dayKey(yesterday)) {
    return 'Yesterday';
  }
  return null;
}

function dayLabel(date) {
  return relativeDay(date) ?? date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function shortTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function longTime(date) {
  const time = shortTime(date);
  const day = relativeDay(date);
  return day ? `${day} at ${time}` : `${date.toLocaleDateString()} ${time}`;
}
