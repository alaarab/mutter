import {
  DEFAULT_PORT,
  CLIENT_VERSION,
  FrameParser,
  MessageType,
  decode,
  versionMessage,
  authenticateMessage,
  pingMessage,
  userStateMessage,
  textMessage,
  udpTunnel,
  pluginDataMessage,
  createChannelMessage,
  userStatsRequest,
  REJECT_REASONS,
} from '../src/mumble.js';
import { encodeAudio, decodeVoice, wireFormatFor } from '../src/voice.js';
import { escapeHtml } from './chat.js';

const REJECT_USERNAME_IN_USE = 5;
const USERNAME_RETRIES_BEFORE_RENAME = 2;
const PING_INTERVAL_MS = 5000;
const WATCHDOG_MS = 20_000;
const TALK_SWEEP_MS = 100;
const TALK_HOLD_MS = 250;
const MAX_RECONNECTS = 6;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_MESSAGES = 2000;
const MAX_LOG_ENTRIES = 400;
const PING_SAMPLE_COUNT = 10;
const MAX_PING_MS = 60_000;
const STALL_GAP_MS = 250;
const STALL_FRAMES = 20;

const DenyType = {
  text: 0,
  permission: 1,
  superUser: 2,
  channelName: 3,
  textTooLong: 4,
  h9k: 5,
  temporaryChannel: 6,
  missingCertificate: 7,
  userName: 8,
  channelFull: 9,
  nestingLimit: 10,
  channelCountLimit: 11,
  channelListenerLimit: 12,
  userListenerLimit: 13,
};

const DENY_TEXT = {
  [DenyType.permission]: 'You don’t have permission for that',
  [DenyType.superUser]: 'Only the SuperUser can do that',
  [DenyType.channelName]: 'That channel name isn’t allowed',
  [DenyType.textTooLong]: 'Message too long for this server',
  [DenyType.temporaryChannel]: 'Not allowed in a temporary channel',
  [DenyType.missingCertificate]: 'A certificate is required',
  [DenyType.userName]: 'That username isn’t allowed',
  [DenyType.channelFull]: 'Channel is full',
  [DenyType.nestingLimit]: 'Channels are nested too deep',
  [DenyType.channelCountLimit]: 'Too many channels',
  [DenyType.channelListenerLimit]: 'Channel listener limit reached',
  [DenyType.userListenerLimit]: 'You’re listening to too many channels',
};

export function compareByName(a, b) {
  return (a.name ?? '').localeCompare(b.name ?? '');
}

export function compareChannels(a, b) {
  return (a.position ?? 0) - (b.position ?? 0) || compareByName(a, b);
}

export class MumbleClient extends EventTarget {
  state = 'disconnected';
  channels = new Map();
  users = new Map();
  messages = [];
  me = null;
  serverInfo = {};
  wireFormat = 'protobuf';
  stats = { tcpPingMs: 0, samples: [], udp: null, stalls: 0 };
  log = [];

  #socket = null;
  #parser = null;
  #target = null;
  #intentional = false;
  #reconnectAttempt = 0;
  #usernameInUseRetries = 0;
  #usernameOverride = null;
  #frameNumber = 0;
  #talkers = new Map();
  #lastPacket = new Map();
  #lastReceivedAt = 0;
  #lastOwnMessage = null;
  #timers = {};

  connect(target) {
    this.#target = { port: DEFAULT_PORT, ...target };
    this.#intentional = false;
    this.#reconnectAttempt = 0;
    this.#usernameInUseRetries = 0;
    this.#usernameOverride = null;
    this.messages = [];
    this.#resetRoster();
    this.#open();
  }

  disconnect() {
    this.#intentional = true;
    this.#teardown();
    this.#setState('disconnected');
  }

  get isConnected() {
    return this.state === 'connected';
  }

  get myUser() {
    return this.users.get(this.me);
  }

  get myChannel() {
    return this.channels.get(this.myUser?.channelId ?? 0);
  }

  get rootChannel() {
    return this.channels.get(0);
  }

  children(channelId) {
    return [...this.channels.values()]
      .filter((channel) => channel.parent === channelId && channel.channelId !== channelId)
      .sort(compareChannels);
  }

  usersIn(channelId) {
    return [...this.users.values()].filter((user) => (user.channelId ?? 0) === channelId).sort(compareByName);
  }

  sendText(html, scope = { channelId: this.myUser?.channelId ?? 0 }) {
    if (!this.isConnected) {
      this.#note('Not connected — message not sent.');
      return false;
    }
    this.#send(
      textMessage({
        html,
        channelIds: scope.channelId !== undefined ? [scope.channelId] : [],
        treeIds: scope.treeId !== undefined ? [scope.treeId] : [],
        sessions: scope.sessions ?? [],
      })
    );
    this.#pushMessage({
      senderSession: this.me,
      senderName: this.myUser?.name ?? 'Me',
      html,
      scope,
      own: true,
    });
    return true;
  }

  joinChannel(channelId) {
    this.#send(userStateMessage({ session: this.me, channelId }));
  }

  setSelfMute(on) {
    const change = on ? { selfMute: true } : { selfMute: false, selfDeaf: false };
    this.#send(userStateMessage({ session: this.me, ...change }));
  }

  setSelfDeaf(on) {
    const change = on ? { selfDeaf: true, selfMute: true } : { selfDeaf: false };
    this.#send(userStateMessage({ session: this.me, ...change }));
  }

  createChannel(parent, name, temporary = true) {
    this.#send(createChannelMessage({ parent, name, temporary }));
  }

  requestStats(session) {
    this.#send(userStatsRequest(session));
  }

  sendAudio(opus, frameCount = 1, isTerminator = false, target = 0) {
    if (!this.isConnected) {
      return;
    }
    const packet = encodeAudio({ target, frameNumber: this.#frameNumber, opus, isTerminator }, this.wireFormat);
    this.#frameNumber += Math.max(1, frameCount);
    this.#send(udpTunnel(packet));
  }

  sendPlugin(receivers, dataId, data) {
    if (!this.isConnected || !receivers.length) {
      return false;
    }
    this.#send(pluginDataMessage({ receivers, dataId, data }));
    return true;
  }

  diag(tag, message) {
    this.log.push({ date: new Date(), tag, message });
    if (this.log.length > MAX_LOG_ENTRIES) {
      this.log.shift();
    }
    this.#emit('log');
  }

  #open() {
    this.#setState(this.#reconnectAttempt ? 'reconnecting' : 'connecting');
    const socket = new WebSocket(`ws://${location.host}`);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    this.#parser = new FrameParser();
    socket.onopen = () => {
      socket.send(JSON.stringify({ host: this.#target.host, port: this.#target.port }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.#onBridgeEvent(JSON.parse(event.data));
        return;
      }
      this.#onBytes(new Uint8Array(event.data));
    };
    socket.onclose = () => {
      if (this.#socket === socket) {
        this.#fail(this.#intentional ? null : 'Connection closed');
      }
    };
    socket.onerror = () => {};
  }

  #onBridgeEvent(message) {
    if (message.event === 'open') {
      this.#handshake();
    } else if (message.event === 'error') {
      this.#fail(message.message);
    } else if (message.event === 'udp') {
      this.stats.udp = { up: message.up, rtt: message.rtt };
      const lane = message.up ? `voice over UDP through the bridge (${message.rtt} ms)` : 'voice over the TCP tunnel';
      this.diag('voice', lane);
      this.#emit('stats');
    }
  }

  #onBytes(bytes) {
    this.#lastReceivedAt = Date.now();
    let frames;
    try {
      frames = this.#parser.push(bytes);
    } catch (error) {
      this.#fail(error.message);
      return;
    }
    for (const { type, payload } of frames) {
      if (type === MessageType.udpTunnel) {
        this.#onVoice(payload);
      } else {
        this.#onMessage(type, decode(type, payload));
      }
    }
  }

  #handshake() {
    this.#setState('authenticating');
    this.#send(
      versionMessage({
        ...CLIENT_VERSION,
        release: 'Mutter Web',
        os: 'Web',
        osVersion: navigator.platform || '1',
      })
    );
    this.#send(
      authenticateMessage({
        username: this.#usernameOverride ?? this.#target.username,
        password: this.#target.password,
        tokens: this.#target.tokens ?? [],
      })
    );
  }

  #send(bytes) {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(bytes);
    }
  }

  #teardown() {
    for (const timer of Object.values(this.#timers)) {
      clearInterval(timer);
    }
    this.#timers = {};
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.close();
    } catch {}
    this.#talkers.clear();
    this.#lastPacket.clear();
    this.#frameNumber = 0;
    this.stats.udp = null;
  }

  #fail(message) {
    const wasSynced = this.state === 'connected';
    const wasReconnecting = this.#reconnectAttempt > 0;
    this.#teardown();
    if (this.#intentional) {
      this.#setState('disconnected');
      return;
    }
    if (message) {
      this.#note(message);
    }
    const canRetry = (wasSynced || wasReconnecting) && this.#reconnectAttempt < MAX_RECONNECTS;
    if (!canRetry) {
      this.#setState('disconnected');
      this.#emit('error', message ?? 'Disconnected');
      return;
    }
    this.#reconnectAttempt++;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 2 ** this.#reconnectAttempt * 1000);
    this.#resetRoster();
    this.#setState('reconnecting');
    this.diag('connection', `reconnecting in ${delay / 1000}s (attempt ${this.#reconnectAttempt})`);
    setTimeout(() => {
      if (!this.#intentional && !this.#socket) {
        this.#open();
      }
    }, delay);
  }

  #resetRoster() {
    this.channels.clear();
    this.users.clear();
    this.me = null;
    this.#emit('channels');
    this.#emit('users');
  }

  #startTimers() {
    this.#lastReceivedAt = Date.now();
    this.#timers.ping = setInterval(() => {
      this.#send(pingMessage(Date.now() * 1000));
      if (Date.now() - this.#lastReceivedAt > WATCHDOG_MS) {
        this.diag('connection', 'server went silent — dropping');
        this.#fail('The server stopped responding.');
      }
    }, PING_INTERVAL_MS);
    this.#timers.talk = setInterval(() => {
      const now = Date.now();
      for (const [session, lastHeard] of this.#talkers) {
        if (now - lastHeard > TALK_HOLD_MS) {
          this.#setTalking(session, false);
        }
      }
    }, TALK_SWEEP_MS);
  }

  #onMessage(type, message) {
    switch (type) {
      case MessageType.version:
        this.#onVersion(message);
        break;
      case MessageType.reject:
        this.#onReject(message);
        break;
      case MessageType.channelState:
        this.#onChannelState(message);
        break;
      case MessageType.channelRemove:
        this.channels.delete(message.channelId);
        this.#emit('channels');
        break;
      case MessageType.userState:
        this.#onUserState(message);
        break;
      case MessageType.userRemove:
        this.#onUserRemove(message);
        break;
      case MessageType.serverSync:
        this.#onServerSync(message);
        break;
      case MessageType.serverConfig:
        Object.assign(this.serverInfo, message);
        this.#emit('server');
        break;
      case MessageType.codecVersion:
        this.serverInfo.opus = message.opus;
        break;
      case MessageType.permissionQuery:
        this.#onPermissionQuery(message);
        break;
      case MessageType.textMessage:
        this.#onTextMessage(message);
        break;
      case MessageType.permissionDenied:
        this.#onPermissionDenied(message);
        break;
      case MessageType.ping:
        this.#onPing(message);
        break;
      case MessageType.userStats:
        this.#emit('user-stats', message);
        break;
      case MessageType.pluginDataTransmission:
        if (message.data) {
          this.#emit('plugin', { sender: message.senderSession, dataId: message.dataId, data: message.data });
        }
        break;
      default:
        break;
    }
  }

  #onVersion(message) {
    this.serverInfo.version = message;
    this.wireFormat = wireFormatFor(message);
    this.diag('connection', `server ${message.release ?? ''} (${this.wireFormat} voice)`);
  }

  #onReject(message) {
    const reason = message.reason || REJECT_REASONS[message.type] || 'Rejected';
    if (message.type === REJECT_USERNAME_IN_USE && this.#reconnectAttempt > 0) {
      this.#usernameInUseRetries++;
      if (this.#usernameInUseRetries >= USERNAME_RETRIES_BEFORE_RENAME) {
        this.#usernameOverride = `${this.#target.username}${this.#usernameInUseRetries}`;
      }
      this.#fail(reason);
      return;
    }
    this.#intentional = true;
    this.#teardown();
    this.#setState('disconnected');
    this.#emit('error', reason);
  }

  #onChannelState(message) {
    const previous = this.channels.get(message.channelId) ?? {};
    const defaultParent = message.channelId === 0 ? undefined : 0;
    this.channels.set(message.channelId, {
      ...previous,
      ...message,
      parent: message.parent ?? previous.parent ?? defaultParent,
    });
    this.#emit('channels');
  }

  #onUserState(message) {
    const previous = this.users.get(message.session);
    const user = { ...previous, ...message, channelId: message.channelId ?? previous?.channelId ?? 0 };
    this.users.set(message.session, user);
    if (this.isConnected) {
      if (!previous) {
        this.#notice(`${user.name} connected`, 'join');
      } else if (message.channelId !== undefined && previous.channelId !== message.channelId) {
        const channelName = this.channels.get(message.channelId)?.name ?? 'a channel';
        this.#notice(`${user.name} moved to ${channelName}`, 'move');
      }
    }
    this.#emit('users');
  }

  #onUserRemove(message) {
    const gone = this.users.get(message.session);
    this.users.delete(message.session);
    this.#talkers.delete(message.session);
    if (gone && this.isConnected) {
      const how = message.ban ? 'was banned' : message.actor !== undefined ? 'was kicked' : 'disconnected';
      this.#notice(`${gone.name} ${how}`, 'leave');
    }
    this.#emit('users');
  }

  #onServerSync(message) {
    this.me = message.session;
    this.#reconnectAttempt = 0;
    this.#usernameInUseRetries = 0;
    this.#usernameOverride = null;
    Object.assign(this.serverInfo, {
      welcomeText: message.welcomeText,
      maxBandwidth: message.maxBandwidth,
      permissions: message.permissions,
    });
    this.#setState('connected');
    this.#startTimers();
    if (message.welcomeText) {
      this.#pushMessage({ senderName: 'Server', html: message.welcomeText, scope: { system: true } });
    }
    this.#emit('users');
    this.#emit('channels');
  }

  #onPermissionQuery(message) {
    const channel = this.channels.get(message.channelId);
    if (channel) {
      channel.permissions = message.permissions;
      this.#emit('channels');
    }
  }

  #onTextMessage(message) {
    const sender = this.users.get(message.actor);
    let scope;
    if (message.sessions?.length) {
      scope = { sessions: message.sessions };
    } else if (message.treeIds?.length) {
      scope = { treeId: message.treeIds[0] };
    } else {
      scope = { channelId: message.channelIds?.[0] ?? 0 };
    }
    this.#pushMessage({
      senderSession: message.actor,
      senderName: sender?.name ?? 'Server',
      html: message.message ?? '',
      scope,
      own: false,
    });
  }

  #onPermissionDenied(message) {
    let text;
    if (message.type === DenyType.text) {
      text = message.reason || 'Not allowed';
    } else {
      text = DENY_TEXT[message.type] ?? 'Not allowed';
      if (message.reason) {
        text += ` — ${message.reason}`;
      }
    }
    this.#note(text);
    if (message.type === DenyType.textTooLong && this.#lastOwnMessage) {
      this.#lastOwnMessage.failed = text;
      this.#emit('text-failed', this.#lastOwnMessage);
    }
  }

  #onPing(message) {
    if (!message.timestamp) {
      return;
    }
    const roundTrip = Date.now() - Number(BigInt(message.timestamp) / 1000n);
    if (roundTrip < 0 || roundTrip >= MAX_PING_MS) {
      return;
    }
    const { samples } = this.stats;
    samples.push(roundTrip);
    if (samples.length > PING_SAMPLE_COUNT) {
      samples.shift();
    }
    this.stats.tcpPingMs = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
    this.#emit('stats');
  }

  #onVoice(payload) {
    const packet = decodeVoice(payload, this.wireFormat);
    if (!packet || packet.kind !== 'audio') {
      return;
    }
    const user = this.users.get(packet.session);
    if (!user || user.localMute) {
      return;
    }
    this.#noteDeliveryStall(user, packet);
    this.#talkers.set(packet.session, Date.now());
    if (!user.talking) {
      this.#setTalking(packet.session, true);
    }
    this.#emit('voice', packet);
    if (packet.isTerminator) {
      this.#setTalking(packet.session, false);
    }
  }

  #noteDeliveryStall(user, packet) {
    const now = Date.now();
    const frame = Number(packet.frameNumber);
    const last = this.#lastPacket.get(packet.session);
    if (last && now - last.at > STALL_GAP_MS && frame - last.frame >= STALL_FRAMES) {
      this.stats.stalls++;
      this.diag('voice', `${user.name}: ${now - last.at} ms delivery stall (${frame - last.frame} frames arrived late)`);
    }
    this.#lastPacket.set(packet.session, { at: now, frame });
  }

  #setTalking(session, talking) {
    const user = this.users.get(session);
    if (!talking) {
      this.#talkers.delete(session);
    }
    if (!user || !!user.talking === talking) {
      return;
    }
    user.talking = talking;
    this.#emit('talking', { session, talking });
  }

  #setState(state) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.diag('connection', `state → ${state}`);
    this.#emit('state');
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  #pushMessage(fields) {
    const message = { id: crypto.randomUUID(), date: new Date(), ...fields };
    if (message.own) {
      this.#lastOwnMessage = message;
    }
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
    }
    this.#emit('text', message);
  }

  #notice(text, kind) {
    this.#emit('notice', { text, kind });
    if (kind === 'join' || kind === 'leave' || kind === 'move') {
      this.diag('presence', text);
      this.#pushMessage({ senderName: 'Server', html: escapeHtml(text), scope: { system: true } });
    }
  }

  #note(text) {
    this.#notice(text, 'info');
    this.diag('connection', text);
  }
}
