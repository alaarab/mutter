// The Screen tab: someone's shared screen with live stats, your own preview while you share, or
// cards offering to watch. The tab only exists while there is something to show.

import { ICON } from './icons.js';
import { el } from './ui.js';

export function mountStage({ share, client, stage, tab, showTab, toast }) {
  let video = null, wasSharing = false;

  function render() {
    const w = share.watching, s = share.sharing, offers = [...share.available].filter(([sender]) => sender !== w?.sender);
    const show = !!(w || s || offers.length);
    tab.hidden = !show;
    tab.classList.toggle('live', !!(w || offers.length));
    if (!show && document.body.dataset.tab === 'screen') showTab('chat');
    if (s && !wasSharing) showTab('screen');          // your own share just started: show the preview
    wasSharing = !!s;
    stage.replaceChildren();
    if (!show) { video = null; return; }

    if (w) {
      const name = client.users.get(w.sender)?.name ?? 'Someone';
      if (!video) { video = el('video', { autoplay: true, playsInline: true, className: 'remote' }); video.srcObject = w.stream; }
      const bar = el('div', { className: 'stage-bar' },
        el('span', { className: 'title' }, el('strong', {}, name), el('span', { className: 'sub', textContent: share.available.get(w.sender)?.title ?? '' })),
        el('span', { className: 'stats', id: 'shareStats' }),
        el('span', { className: 'spacer' }),
        iconBtn('pip', 'Picture in picture', () => video.requestPictureInPicture?.().catch(() => {})),
        iconBtn('fullscreen', 'Full screen', () => video.requestFullscreen?.().catch(() => {})),
        iconBtn('close', 'Stop watching', () => share.unwatch()));
      const frame = el('div', { className: 'frame' }, video);
      if (w.state !== 'connected') {
        const failed = w.state === 'failed' || w.state === 'disconnected';
        frame.append(el('div', { className: 'frame-note' },
          el('span', { textContent: failed ? 'Connection failed' : 'Connecting…' }),
          ...(failed ? [el('button', { type: 'button', className: 'ghost', textContent: 'Retry', onclick: () => share.watch(w.sender) })] : [])));
      }
      stage.append(bar, frame);
      renderStats();
    } else video = null;

    if (s) {
      const preview = el('video', { autoplay: true, playsInline: true, muted: true, className: w ? 'preview small' : 'preview' });
      preview.srcObject = s.stream;
      const n = share.viewerCount;
      const bar = el('div', { className: 'stage-bar own' },
        el('span', { className: 'title' }, el('strong', {}, 'You’re sharing'), el('span', { className: 'sub', textContent: `${s.title} · ${n ? `${n} watching` : 'nobody watching yet'}` })),
        el('span', { className: 'spacer' }),
        segmented(s.contentHint, v => share.setContentHint(v)),
        el('button', { type: 'button', className: 'ghost danger', textContent: 'Stop', onclick: () => share.stop() }));
      if (w) { stage.append(bar); stage.querySelector('.frame').append(preview); }
      else stage.append(bar, el('div', { className: 'frame' }, preview));
    }

    if (offers.length) {
      const list = el('div', { className: 'offers' });
      for (const [sender, a] of offers) {
        const name = client.users.get(sender)?.name ?? 'Someone';
        list.append(el('div', { className: 'offer' },
          el('span', { className: 'offer-icon', innerHTML: ICON.screen }),
          el('span', { className: 'title' }, el('strong', {}, `${name} is sharing`), el('span', { className: 'sub', textContent: `${a.title}${a.w ? ` · ${a.w}×${a.h}` : ''}${a.audio ? ' · audio' : ''}` })),
          el('button', { type: 'button', className: 'watch', textContent: 'Watch', onclick: () => { share.watch(sender); showTab('screen'); } })));
      }
      stage.append(list);
    }
  }

  function renderStats() {
    const w = share.watching, out = document.getElementById('shareStats');
    if (!w || !out) return;
    const { fps, kbps, w: vw, h: vh, codec } = w.stats;
    out.textContent = vw ? `${vw}×${vh} · ${fps} fps · ${fmtKbps(kbps)}${codec ? ` · ${codec}` : ''}` : '';
  }

  share.addEventListener('state', render);
  share.addEventListener('stream', () => { if (video && share.watching) video.srcObject = share.watching.stream; video?.play().catch(() => {}); });
  share.addEventListener('stats', renderStats);
  share.addEventListener('available', e => {
    render();
    if (e.detail?.fresh) toast(`${client.users.get(e.detail.sender)?.name ?? 'Someone'} started sharing`, 'join');
  });
  client.addEventListener('users', render);
  render();
}

const fmtKbps = k => k >= 1000 ? `${(k / 1000).toFixed(1)} Mbit/s` : `${k} kbit/s`;
function iconBtn(icon, title, onclick) { return el('button', { type: 'button', className: 'icon', title, innerHTML: ICON[icon], onclick }); }
function segmented(value, onChange) {
  const box = el('div', { className: 'segmented mini' });
  for (const [v, label] of [['detail', 'Text'], ['motion', 'Motion']]) box.append(el('button', { type: 'button', className: v === value ? 'on' : '', textContent: label, onclick: () => onChange(v) }));
  return box;
}
