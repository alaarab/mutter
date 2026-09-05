import { ICON } from './icons.js';
import { el, avatar, colorFor } from './ui.js';
import { presence } from './tree.js';

const STATUS_CLASSES = ['speaking', 'deaf', 'muted', 'live', 'online'];

function statusGlyph(statusClass) {
  switch (statusClass) {
    case 'muted':
      return ICON.micOff;
    case 'deaf':
      return ICON.headphonesOff;
    default:
      return '';
  }
}

function barButton(icon, tip) {
  const button = el('button', { type: 'button', className: 'icon', innerHTML: ICON[icon] });
  button.dataset.tip = tip;
  return button;
}

export function mountRoom({ container, client, audio, share, settings, canShare, canCamera, leave, onShare, onUser, onError }) {
  const context = { client, audio, share };
  const tiles = new Map();
  const grid = el('div', { className: 'room-grid' });
  const hint = el('p', { className: 'room-hint', hidden: true });
  const talk = el('button', { type: 'button', className: 'room-talk', textContent: 'Hold to talk' });
  const mute = barButton('mic', 'Mute');
  const deafen = barButton('headphones', 'Deafen');
  const camera = barButton('video', 'Camera');
  const flip = barButton('flip', 'Switch camera');
  const screen = barButton('screen', 'Share screen');
  const hangup = barButton('leave', 'Disconnect');
  hangup.classList.add('danger');
  const bar = el('div', { className: 'room-bar' }, talk, mute, deafen, camera, flip, screen, hangup);
  container.append(grid, hint, bar);

  mute.onclick = () => audio.setMuted(!audio.muted);
  deafen.onclick = () => audio.setDeafened(!audio.deafened);
  camera.onclick = () => {
    if (share.camera) {
      share.stopCamera();
      return;
    }
    share.startCamera().catch((error) => onError(`Camera: ${error.message}`));
  };
  flip.onclick = () => share.flipCamera().catch((error) => onError(`Camera: ${error.message}`));
  screen.onclick = onShare;
  hangup.onclick = leave;
  talk.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    audio.setPTT(true);
  });
  for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
    talk.addEventListener(eventName, () => audio.setPTT(false));
  }

  function makeTile(user) {
    const picture = avatar(user.name, 'xl');
    const name = el('span', { className: 'room-name' }, el('span', { className: 'glyph' }), el('span', { className: 'text' }));
    const live = el('span', { className: 'room-live', textContent: 'LIVE', hidden: true });
    const tile = el('button', { type: 'button', className: 'room-tile' }, picture, live, name);
    tile.style.setProperty('--tile', colorFor(user.name));
    tile.onclick = () => onUser(tile, user);
    return tile;
  }

  function updateTile(tile, user) {
    const isMe = user.session === client.me;
    const [, statusClass] = presence(user, context);
    tile.classList.remove(...STATUS_CLASSES);
    tile.classList.add(statusClass);
    tile.classList.toggle('me', isMe);
    const picture = tile.querySelector('.avatar');
    picture.classList.remove(...STATUS_CLASSES);
    picture.classList.add('presence', statusClass);
    tile.querySelector('.room-name .glyph').innerHTML = statusGlyph(statusClass);
    tile.querySelector('.room-name .text').textContent = isMe ? `${user.name} (you)` : user.name;
    tile.querySelector('.room-live').hidden = !(share.available.has(user.session) || (isMe && share.sharing));
    showCamera(tile, isMe ? share.camera?.stream : share.feeds.get(user.session)?.stream, isMe);
  }

  function showCamera(tile, stream, mirrored) {
    const playing = !!stream?.getVideoTracks().length;
    let video = tile.querySelector('video');
    if (playing) {
      if (!video) {
        video = el('video', { autoplay: true, playsInline: true, muted: true });
        tile.prepend(video);
      }
      if (video.srcObject !== stream) {
        video.srcObject = stream;
      }
      video.classList.toggle('mirror', mirrored);
    } else {
      video?.remove();
    }
    tile.classList.toggle('video', playing);
  }

  function followCameras(users) {
    const inChannel = new Set(users.map((user) => user.session));
    for (const sender of share.cameras.keys()) {
      if (inChannel.has(sender) && sender !== client.me) {
        share.watchCamera(sender);
      }
    }
    for (const sender of [...share.feeds.keys()]) {
      if (!inChannel.has(sender)) {
        share.unwatchCamera(sender);
      }
    }
  }

  function placeInOrder(ordered) {
    ordered.forEach((tile, index) => {
      if (grid.children[index] !== tile) {
        grid.insertBefore(tile, grid.children[index] ?? null);
      }
    });
  }

  function render() {
    const channel = client.myChannel;
    const users = channel && client.isConnected ? [...client.usersIn(channel.channelId)] : [];
    users.sort((a, b) => {
      if (a.session === client.me) {
        return -1;
      }
      if (b.session === client.me) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
    const seen = new Set();
    const ordered = [];
    for (const user of users) {
      let tile = tiles.get(user.session);
      if (!tile) {
        tile = makeTile(user);
        tiles.set(user.session, tile);
      }
      updateTile(tile, user);
      ordered.push(tile);
      seen.add(user.session);
    }
    for (const [session, tile] of tiles) {
      if (!seen.has(session)) {
        tile.remove();
        tiles.delete(session);
      }
    }
    placeInOrder(ordered);
    followCameras(users);
    grid.dataset.count = String(users.length);
    hint.hidden = users.length !== 1;
    hint.textContent = channel ? `Only you in #${channel.name} so far.` : '';
    talk.hidden = settings.transmitMode !== 'ptt';
    talk.classList.toggle('active', audio.pttPressed);
    mute.innerHTML = ICON[audio.muted ? 'micOff' : 'mic'];
    mute.classList.toggle('active', audio.muted);
    mute.dataset.tip = audio.muted ? 'Unmute' : 'Mute';
    deafen.innerHTML = ICON[audio.deafened ? 'headphonesOff' : 'headphones'];
    deafen.classList.toggle('active', audio.deafened);
    deafen.dataset.tip = audio.deafened ? 'Undeafen' : 'Deafen';
    camera.hidden = !canCamera;
    camera.innerHTML = ICON[share.camera ? 'videoOff' : 'video'];
    camera.classList.toggle('active', !!share.camera);
    camera.dataset.tip = share.camera ? 'Camera off' : 'Camera';
    flip.hidden = !(share.camera && share.canFlip);
    screen.hidden = !canShare;
    screen.innerHTML = ICON[share.sharing ? 'screenOff' : 'screen'];
    screen.classList.toggle('active', !!share.sharing);
    screen.dataset.tip = share.sharing ? 'Stop sharing' : 'Share screen';
  }

  return { render };
}
