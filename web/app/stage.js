import { ICON } from './icons.js';
import { el } from './ui.js';

const NO_CONNECTION_HINT =
  'One of you is on a network that blocks direct connections. A relay (TURN) in Settings → Screen share fixes that.';

function formatBitrate(kbps) {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${kbps} kbit/s`;
}

function formatStats({ w, h, fps, kbps, codec }) {
  if (!w) {
    return '';
  }
  return `${w}×${h} · ${fps} fps · ${formatBitrate(kbps)}${codec ? ` · ${codec}` : ''}`;
}

function iconButton(icon, title, onclick) {
  return el('button', { type: 'button', className: 'icon', title, innerHTML: ICON[icon], onclick });
}

function contentHintPicker(value, onChange) {
  const box = el('div', { className: 'segmented mini' });
  for (const [hint, label] of [
    ['detail', 'Text'],
    ['motion', 'Motion'],
  ]) {
    box.append(
      el('button', {
        type: 'button',
        className: hint === value ? 'on' : '',
        textContent: label,
        onclick: () => onChange(hint),
      })
    );
  }
  return box;
}

function titleBlock(strong, sub) {
  return el('span', { className: 'title' }, el('strong', {}, strong), el('span', { className: 'sub', textContent: sub }));
}

export function mountStage({ share, client, stage, tabs, showTab, toast, applySink }) {
  let video = null;
  let wasSharing = false;

  const nameOf = (session) => client.users.get(session)?.name ?? 'Someone';

  function render() {
    const viewer = share.watching;
    const own = share.sharing;
    const offers = [...share.available].filter(([sender]) => sender !== viewer?.sender);
    const showStage = !!(viewer || own || offers.length);
    for (const tab of tabs) {
      tab.hidden = !showStage;
      tab.classList.toggle('live', !!(viewer || offers.length));
    }
    if (!showStage && document.body.dataset.tab === 'screen') {
      showTab('chat');
    }
    if (own && !wasSharing) {
      showTab('screen');
    }
    wasSharing = !!own;
    stage.replaceChildren();
    if (!showStage) {
      video = null;
      return;
    }
    if (viewer) {
      renderViewer(viewer);
    } else {
      video = null;
    }
    if (own) {
      renderOwnShare(own, viewer);
    }
    if (offers.length) {
      renderOffers(offers);
    }
  }

  function renderViewer(viewer) {
    if (!video) {
      video = el('video', { autoplay: true, playsInline: true, className: 'remote' });
      video.srcObject = viewer.stream;
      applySink?.(video);
    }
    const bar = el(
      'div',
      { className: 'stage-bar' },
      titleBlock(nameOf(viewer.sender), share.available.get(viewer.sender)?.title ?? ''),
      el('span', { className: 'stats', id: 'shareStats' }),
      el('span', { className: 'spacer' }),
      iconButton('pip', 'Picture in picture', () => video.requestPictureInPicture?.().catch(() => {})),
      iconButton('fullscreen', 'Full screen', () => video.requestFullscreen?.().catch(() => {})),
      iconButton('close', 'Stop watching', () => share.unwatch())
    );
    const frame = el('div', { className: 'frame' }, video);
    if (viewer.state !== 'connected') {
      frame.append(connectionNote(viewer));
    }
    stage.append(bar, frame);
    renderStats();
  }

  function connectionNote(viewer) {
    const failed = viewer.state === 'failed' || viewer.state === 'disconnected';
    const note = el('div', { className: 'frame-note' }, el('span', { textContent: failed ? 'Couldn’t connect' : 'Connecting…' }));
    if (failed) {
      note.append(
        el('span', { className: 'sub', textContent: NO_CONNECTION_HINT }),
        el('button', { type: 'button', className: 'ghost', textContent: 'Retry', onclick: () => share.watch(viewer.sender) })
      );
    }
    return note;
  }

  function renderOwnShare(own, viewer) {
    const preview = el('video', { autoplay: true, playsInline: true, muted: true, className: viewer ? 'preview small' : 'preview' });
    preview.srcObject = own.stream;
    const watchers = share.viewerCount;
    const bar = el(
      'div',
      { className: 'stage-bar own' },
      titleBlock('You’re sharing', `${own.title} · ${watchers ? `${watchers} watching` : 'nobody watching yet'}`),
      el('span', { className: 'stats', id: 'shareOwnStats' }),
      el('span', { className: 'spacer' }),
      contentHintPicker(own.contentHint, (hint) => share.setContentHint(hint)),
      el('button', { type: 'button', className: 'ghost danger', textContent: 'Stop', onclick: () => share.stop() })
    );
    if (viewer) {
      stage.append(bar);
      stage.querySelector('.frame').append(preview);
    } else {
      stage.append(bar, el('div', { className: 'frame' }, preview));
    }
  }

  function renderOffers(offers) {
    const list = el('div', { className: 'offers' });
    for (const [sender, offer] of offers) {
      const details = `${offer.title}${offer.w ? ` · ${offer.w}×${offer.h}` : ''}${offer.audio ? ' · audio' : ''}`;
      list.append(
        el(
          'div',
          { className: 'offer' },
          el('span', { className: 'offer-icon', innerHTML: ICON.screen }),
          titleBlock(`${nameOf(sender)} is sharing`, details),
          el('button', {
            type: 'button',
            className: 'watch',
            textContent: 'Watch',
            onclick: () => {
              share.watch(sender);
              showTab('screen');
            },
          })
        )
      );
    }
    stage.append(list);
  }

  function renderStats() {
    const viewerStats = document.getElementById('shareStats');
    if (share.watching && viewerStats) {
      viewerStats.textContent = formatStats(share.watching.stats);
    }
    const ownStats = document.getElementById('shareOwnStats');
    const own = share.sharing;
    if (own && ownStats) {
      ownStats.replaceChildren();
      if (own.stats?.w) {
        ownStats.append(formatStats(own.stats));
        if (own.stats.limited) {
          const cause = own.stats.limited === 'cpu' ? 'CPU' : own.stats.limited;
          ownStats.append(el('span', { className: 'limited', textContent: ` · limited by ${cause}` }));
        }
      }
    }
  }

  share.addEventListener('state', render);
  share.addEventListener('stream', () => {
    if (video && share.watching) {
      video.srcObject = share.watching.stream;
    }
    video?.play().catch(() => {});
  });
  share.addEventListener('stats', renderStats);
  share.addEventListener('available', (event) => {
    render();
    if (event.detail?.fresh) {
      toast(`${nameOf(event.detail.sender)} started sharing`, 'join');
    }
  });
  client.addEventListener('users', render);
  render();
}
