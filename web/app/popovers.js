// Popovers, the profile card, menus and tooltips. One popover at a time, anchored to an element
// and kept on screen; tooltips come from `data-tip` and appear after a short delay.

import { sanitize } from './chat.js';
import { ICON } from './icons.js';
import { $, el, avatar, colorFor } from './ui.js';

let current = null;

export function openPopover(anchor, build, { align = 'below' } = {}) {
  closePopover();
  const pop = $('popover');
  pop.replaceChildren();
  build(pop);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight, W = window.innerWidth, H = window.innerHeight;
  let left, top;
  if (align === 'right') { left = r.right + 8; top = r.top; if (left + pw > W - 8) left = r.left - pw - 8; }
  else { left = r.left; top = r.bottom + 6; if (top + ph > H - 8) top = Math.max(8, r.top - ph - 6); }
  pop.style.left = `${Math.max(8, Math.min(left, W - pw - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(top, H - ph - 8))}px`;
  current = { anchor };
  return pop;
}
export function closePopover() { $('popover').hidden = true; current = null; }
document.addEventListener('pointerdown', e => { const pop = $('popover'); if (!pop.hidden && !pop.contains(e.target) && !current?.anchor.contains(e.target)) closePopover(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape') closePopover(); });

export const menuItem = (icon, label, fn, { on = false, danger = false } = {}) => {
  const b = el('button', { type: 'button', className: `action${on ? ' on' : ''}${danger ? ' danger' : ''}`, innerHTML: `${ICON[icon] ?? ''}<span>${label}</span>` });
  b.onclick = () => fn();
  return b;
};
export const menuSep = () => el('hr', { className: 'msep' });

/// Discord-style profile card: banner in the person's colour, avatar, name, channel, status,
/// stats, then actions.
export function profileCard(anchor, u, ctx) {
  const { client, audio, share, statsFor } = ctx;
  const me = u.session === client.me;
  const [status, cls] = ctx.presence(u);
  return openPopover(anchor, pop => {
    pop.classList.add('profile');
    pop.append(el('div', { className: 'banner', style: `background:${colorFor(u.name)}` }));
    const av = avatar(u.name, 'xl'); av.classList.add('presence', cls); av.append(el('span', { className: 'sdot' }));
    pop.append(av);
    const head = el('div', { className: 'phead' },
      el('div', { className: 'pname' }, el('strong', { textContent: u.name ?? '…' }), ...(me ? [el('span', { className: 'you', textContent: 'you' })] : [])),
      el('div', { className: 'psub', textContent: `#${client.channels.get(u.channelId)?.name ?? ''}${status ? ` · ${status}` : ''}` }));
    pop.append(head);
    const badges = el('div', { className: 'badges' });
    if (u.prioritySpeaker) badges.append(badge('star', 'Priority speaker', 'warn'));
    if (u.userId !== undefined) badges.append(badge('check', 'Registered'));
    if (share.available.has(u.session) || (me && share.sharing)) badges.append(badge('screen', 'Sharing screen', 'live'));
    if (u.localMute) badges.append(badge('volumeOff', 'Muted for you', 'warn'));
    if (badges.childNodes.length) pop.append(badges);
    if (u.comment) { const d = el('div', { className: 'desc' }); d.append(sanitize(u.comment)); pop.append(el('h4', { textContent: 'About' }), d); }
    const stats = el('div', { className: 'pstats', textContent: '…' });
    pop.append(el('h4', { textContent: 'Connection' }), stats);
    statsFor(u.session, stats);
    if (!me) {
      pop.append(el('hr', { className: 'msep' }));
      const actions = el('div', { className: 'actions' });
      actions.append(menuItem('message', 'Message', () => { ctx.onMessage(u); closePopover(); }));
      actions.append(menuItem(u.localMute ? 'volume' : 'volumeOff', u.localMute ? 'Unmute for me' : 'Mute for me', () => { audio.setUserLocalMute(u.session, !u.localMute); closePopover(); ctx.rerender(); }));
      if (share.available.has(u.session)) actions.append(menuItem('screen', 'Watch their screen', () => { ctx.onWatch(u); closePopover(); }));
      if (u.channelId !== client.myChannel?.channelId) actions.append(menuItem('join', `Join them in #${client.channels.get(u.channelId)?.name ?? ''}`, () => { client.joinChannel(u.channelId); closePopover(); }));
      pop.append(actions);
      const vol = el('input', { type: 'range', min: 0, max: 200, value: Math.round((u.localVolume ?? 1) * 100) });
      const label = el('span', { className: 'hint', textContent: `${vol.value}%` });
      vol.oninput = () => { audio.setUserVolume(u.session, vol.value / 100); label.textContent = `${vol.value}%`; };
      pop.append(el('div', { className: 'row between vol' }, el('span', { className: 'hint', textContent: 'Volume' }), label), vol);
    }
  }, { align: 'right' });
}
const badge = (icon, text, cls = '') => el('span', { className: `pbadge ${cls}`, innerHTML: `${ICON[icon]}<span>${text}</span>` });

export function channelMenu(anchor, c, ctx) {
  const { client } = ctx;
  return openPopover(anchor, pop => {
    pop.append(el('h3', { className: 'mtitle' }, el('span', { className: 'hash', textContent: '# ' }), c.name ?? ''));
    if (c.description) { const d = el('div', { className: 'desc' }); d.append(sanitize(c.description)); pop.append(d); }
    const meta = [];
    if (c.temporary) meta.push('temporary');
    if (c.maxUsers) meta.push(`up to ${c.maxUsers} people`);
    if (meta.length) pop.append(el('p', { className: 'hint', textContent: meta.join(' · ') }));
    const actions = el('div', { className: 'actions' });
    if (!ctx.isCurrent(c)) actions.append(menuItem('join', 'Join', () => { client.joinChannel(c.channelId); closePopover(); }));
    actions.append(menuItem('message', 'Message here', () => { ctx.setScope({ channelId: c.channelId }); closePopover(); }));
    actions.append(menuItem('channels', 'Message here and below', () => { ctx.setScope({ treeId: c.channelId }); closePopover(); }));
    actions.append(menuSep(), menuItem('plus', 'New channel inside', () => { closePopover(); ctx.newChannel(c.channelId); }));
    pop.append(actions);
  });
}

export function serverMenu(anchor, ctx) {
  return openPopover(anchor, pop => {
    const actions = el('div', { className: 'actions' });
    actions.append(menuItem('info', 'Server info', () => { ctx.showTab('server'); closePopover(); }));
    actions.append(menuItem('plus', 'New channel', () => { closePopover(); ctx.newChannel(); }));
    actions.append(menuItem('copy', 'Copy address', () => { navigator.clipboard?.writeText(ctx.address()).catch(() => {}); closePopover(); ctx.toast('Address copied'); }));
    actions.append(menuSep(), menuItem('leave', 'Disconnect', () => { closePopover(); ctx.leave(); }, { danger: true }));
    pop.append(actions);
  });
}

// ---- tooltips ----

let tipTimer = null, tipFor = null;
function showTip(target) {
  const tip = $('tooltip');
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const r = target.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  const side = target.closest('#rail') ? 'right' : 'top';
  let left, top;
  if (side === 'right') { left = r.right + 10; top = r.top + r.height / 2 - th / 2; }
  else { left = r.left + r.width / 2 - tw / 2; top = r.top - th - 8; if (top < 4) top = r.bottom + 8; }
  tip.dataset.side = side;
  tip.style.left = `${Math.max(4, Math.min(left, window.innerWidth - tw - 4))}px`;
  tip.style.top = `${Math.max(4, top)}px`;
  tipFor = target;
}
function hideTip() { clearTimeout(tipTimer); tipTimer = null; $('tooltip').hidden = true; tipFor = null; }
document.addEventListener('pointerover', e => {
  const t = e.target.closest?.('[data-tip]');
  if (!t || t === tipFor) return;
  hideTip();
  tipTimer = setTimeout(() => showTip(t), 120);
});
document.addEventListener('pointerout', e => { const t = e.target.closest?.('[data-tip]'); if (t && (!e.relatedTarget || !t.contains(e.relatedTarget))) hideTip(); });
document.addEventListener('pointerdown', hideTip);
window.addEventListener('scroll', hideTip, true);
