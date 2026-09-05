import { sanitize } from './chat.js';
import { ICON } from './icons.js';
import { $, el, avatar, colorFor } from './ui.js';

const EDGE_MARGIN = 8;
const TOOLTIP_MARGIN = 4;
const TOOLTIP_DELAY_MS = 120;

let openAnchor = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

export function openPopover(anchor, build, { align = 'below' } = {}) {
  closePopover();
  const popover = $('popover');
  popover.replaceChildren();
  build(popover);
  popover.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let left;
  let top;
  if (align === 'right') {
    left = rect.right + EDGE_MARGIN;
    top = rect.top;
    if (left + width > viewportWidth - EDGE_MARGIN) {
      left = rect.left - width - EDGE_MARGIN;
    }
  } else {
    left = rect.left;
    top = rect.bottom + 6;
    if (top + height > viewportHeight - EDGE_MARGIN) {
      top = Math.max(EDGE_MARGIN, rect.top - height - 6);
    }
  }
  popover.style.left = `${clamp(left, EDGE_MARGIN, viewportWidth - width - EDGE_MARGIN)}px`;
  popover.style.top = `${clamp(top, EDGE_MARGIN, viewportHeight - height - EDGE_MARGIN)}px`;
  openAnchor = anchor;
  return popover;
}

export function closePopover() {
  $('popover').hidden = true;
  openAnchor = null;
}

document.addEventListener('pointerdown', (event) => {
  const popover = $('popover');
  if (!popover.hidden && !popover.contains(event.target) && !openAnchor?.contains(event.target)) {
    closePopover();
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closePopover();
  }
});

export function menuItem(icon, label, action, { on = false, danger = false } = {}) {
  const button = el(
    'button',
    { type: 'button', className: `action${on ? ' on' : ''}${danger ? ' danger' : ''}`, innerHTML: ICON[icon] ?? '' },
    el('span', { textContent: label })
  );
  button.onclick = () => {
    closePopover();
    action();
  };
  return button;
}

function menuSeparator() {
  return el('hr', { className: 'msep' });
}

function badge(icon, text, kind = '') {
  return el('span', { className: `pbadge ${kind}`, innerHTML: ICON[icon] }, el('span', { textContent: text }));
}

function descriptionBlock(html) {
  const block = el('div', { className: 'desc' });
  block.append(sanitize(html));
  return block;
}

export function profileCard(anchor, user, ctx) {
  const { client, audio, share, statsFor } = ctx;
  const isMe = user.session === client.me;
  const [status, statusClass] = ctx.presence(user);
  const channelName = client.channels.get(user.channelId)?.name ?? '';
  return openPopover(
    anchor,
    (popover) => {
      popover.classList.add('profile');
      popover.append(el('div', { className: 'banner', style: `background:${colorFor(user.name)}` }));
      const picture = avatar(user.name, 'xl');
      picture.classList.add('presence', statusClass);
      picture.append(el('span', { className: 'sdot' }));
      popover.append(picture);

      const nameLine = el('div', { className: 'pname' }, el('strong', { textContent: user.name ?? '…' }));
      if (isMe) {
        nameLine.append(el('span', { className: 'you', textContent: 'you' }));
      }
      popover.append(
        el(
          'div',
          { className: 'phead' },
          nameLine,
          el('div', { className: 'psub', textContent: `#${channelName}${status ? ` · ${status}` : ''}` })
        )
      );

      const badges = el('div', { className: 'badges' });
      if (user.prioritySpeaker) {
        badges.append(badge('star', 'Priority speaker', 'warn'));
      }
      if (user.userId !== undefined) {
        badges.append(badge('check', 'Registered'));
      }
      if (share.available.has(user.session) || (isMe && share.sharing)) {
        badges.append(badge('screen', 'Sharing screen', 'live'));
      }
      if (user.localMute) {
        badges.append(badge('volumeOff', 'Muted for you', 'warn'));
      }
      if (badges.childNodes.length) {
        popover.append(badges);
      }
      if (user.comment) {
        popover.append(el('h4', { textContent: 'About' }), descriptionBlock(user.comment));
      }
      const stats = el('div', { className: 'pstats', textContent: '…' });
      popover.append(el('h4', { textContent: 'Connection' }), stats);
      statsFor(user.session, stats);
      if (!isMe) {
        popover.append(menuSeparator(), profileActions(user, ctx), volumeControl(user, audio));
      }
    },
    { align: 'right' }
  );
}

function profileActions(user, ctx) {
  const { client, audio, share } = ctx;
  const actions = el('div', { className: 'actions' });
  actions.append(menuItem('message', 'Message', () => ctx.onMessage(user)));
  actions.append(
    menuItem(user.localMute ? 'volume' : 'volumeOff', user.localMute ? 'Unmute for me' : 'Mute for me', () => {
      audio.setUserLocalMute(user.session, !user.localMute);
      ctx.rerender();
    })
  );
  if (share.available.has(user.session)) {
    actions.append(menuItem('screen', 'Watch their screen', () => ctx.onWatch(user)));
  }
  if (user.channelId !== client.myChannel?.channelId) {
    const channelName = client.channels.get(user.channelId)?.name ?? '';
    actions.append(menuItem('join', `Join them in #${channelName}`, () => client.joinChannel(user.channelId)));
  }
  return actions;
}

function volumeControl(user, audio) {
  const slider = el('input', { type: 'range', min: 0, max: 200, value: Math.round((user.localVolume ?? 1) * 100) });
  const label = el('span', { className: 'hint', textContent: `${slider.value}%` });
  slider.oninput = () => {
    audio.setUserVolume(user.session, slider.value / 100);
    label.textContent = `${slider.value}%`;
  };
  const wrapper = document.createDocumentFragment();
  wrapper.append(el('div', { className: 'row between vol' }, el('span', { className: 'hint', textContent: 'Volume' }), label), slider);
  return wrapper;
}

export function channelMenu(anchor, channel, ctx) {
  const { client } = ctx;
  return openPopover(anchor, (popover) => {
    popover.append(el('h3', { className: 'mtitle' }, el('span', { className: 'hash', textContent: '# ' }), channel.name ?? ''));
    if (channel.description) {
      popover.append(descriptionBlock(channel.description));
    }
    const facts = [];
    if (channel.temporary) {
      facts.push('temporary');
    }
    if (channel.maxUsers) {
      facts.push(`up to ${channel.maxUsers} people`);
    }
    if (facts.length) {
      popover.append(el('p', { className: 'hint', textContent: facts.join(' · ') }));
    }
    const actions = el('div', { className: 'actions' });
    if (!ctx.isCurrent(channel)) {
      actions.append(menuItem('join', 'Join', () => client.joinChannel(channel.channelId)));
    }
    actions.append(menuItem('message', 'Message here', () => ctx.setScope({ channelId: channel.channelId })));
    actions.append(menuItem('channels', 'Message here and below', () => ctx.setScope({ treeId: channel.channelId })));
    actions.append(menuSeparator(), menuItem('plus', 'New channel inside', () => ctx.newChannel(channel.channelId)));
    popover.append(actions);
  });
}

export function serverMenu(anchor, ctx) {
  return openPopover(anchor, (popover) => {
    const actions = el('div', { className: 'actions' });
    actions.append(menuItem('info', 'Server info', () => ctx.showTab('server')));
    actions.append(menuItem('plus', 'New channel', () => ctx.newChannel()));
    actions.append(
      menuItem('copy', 'Copy address', () => {
        navigator.clipboard?.writeText(ctx.address()).catch(() => {});
        ctx.toast('Address copied');
      })
    );
    actions.append(menuSeparator(), menuItem('leave', 'Disconnect', () => ctx.leave(), { danger: true }));
    popover.append(actions);
  });
}

let tooltipTimer = null;
let tooltipTarget = null;

function showTooltip(target) {
  const tooltip = $('tooltip');
  tooltip.textContent = target.dataset.tip;
  tooltip.hidden = false;
  const rect = target.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const side = target.closest('#rail') ? 'right' : 'top';
  let left;
  let top;
  if (side === 'right') {
    left = rect.right + 10;
    top = rect.top + rect.height / 2 - height / 2;
  } else {
    left = rect.left + rect.width / 2 - width / 2;
    top = rect.top - height - 8;
    if (top < TOOLTIP_MARGIN) {
      top = rect.bottom + 8;
    }
  }
  tooltip.dataset.side = side;
  tooltip.style.left = `${clamp(left, TOOLTIP_MARGIN, window.innerWidth - width - TOOLTIP_MARGIN)}px`;
  tooltip.style.top = `${Math.max(TOOLTIP_MARGIN, top)}px`;
  tooltipTarget = target;
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  $('tooltip').hidden = true;
  tooltipTarget = null;
}

document.addEventListener('pointerover', (event) => {
  const target = event.target.closest?.('[data-tip]');
  if (!target || target === tooltipTarget) {
    return;
  }
  hideTooltip();
  tooltipTimer = setTimeout(() => showTooltip(target), TOOLTIP_DELAY_MS);
});
document.addEventListener('pointerout', (event) => {
  const target = event.target.closest?.('[data-tip]');
  if (target && (!event.relatedTarget || !target.contains(event.relatedTarget))) {
    hideTooltip();
  }
});
document.addEventListener('pointerdown', hideTooltip);
window.addEventListener('scroll', hideTooltip, true);
