import { Reader, Writer } from './protobuf.js';

export const MessageType = {
  version: 0,
  udpTunnel: 1,
  authenticate: 2,
  ping: 3,
  reject: 4,
  serverSync: 5,
  channelRemove: 6,
  channelState: 7,
  userRemove: 8,
  userState: 9,
  banList: 10,
  textMessage: 11,
  permissionDenied: 12,
  acl: 13,
  queryUsers: 14,
  cryptSetup: 15,
  contextActionModify: 16,
  contextAction: 17,
  userList: 18,
  voiceTarget: 19,
  permissionQuery: 20,
  codecVersion: 21,
  userStats: 22,
  requestBlob: 23,
  serverConfig: 24,
  suggestConfig: 25,
  pluginDataTransmission: 26,
};

export const REJECT_REASONS = {
  0: 'None',
  1: 'Wrong version',
  2: 'Invalid username',
  3: 'Wrong user password',
  4: 'Wrong server password',
  5: 'Username already in use',
  6: 'Server is full',
  7: 'No certificate',
  8: 'Authentication failed',
  9: 'No new connections',
};

export const DEFAULT_PORT = 64738;
const HEADER_SIZE = 6;
const MAX_PAYLOAD = 8 * 1024 * 1024;
const MAX_PLUGIN_DATA = 1000;

export function versionFields(major, minor, patch) {
  return {
    v1: (major << 16) | (minor << 8) | Math.min(patch, 255),
    v2: (BigInt(major) << 48n) | (BigInt(minor) << 32n) | (BigInt(patch) << 16n),
  };
}

export const CLIENT_VERSION = versionFields(1, 5, 0);

const uint = (name) => [name, 'uint'];
const string = (name) => [name, 'string'];
const bool = (name) => [name, 'bool'];
const bytes = (name) => [name, 'bytes'];
const repeated = ([name, kind]) => [name, kind, true];

const FIELDS = {
  [MessageType.version]: {
    1: uint('v1'),
    2: string('release'),
    3: string('os'),
    4: string('osVersion'),
    5: uint('v2'),
  },
  [MessageType.authenticate]: {
    1: string('username'),
    2: string('password'),
    3: repeated(string('tokens')),
    5: bool('opus'),
    6: uint('clientType'),
  },
  [MessageType.ping]: {
    1: uint('timestamp'),
    2: uint('good'),
    3: uint('late'),
    4: uint('lost'),
    5: uint('resync'),
    6: uint('udpPackets'),
    7: uint('tcpPackets'),
    8: bytes('udpPingAvg'),
    9: bytes('udpPingVar'),
    10: bytes('tcpPingAvg'),
    11: bytes('tcpPingVar'),
  },
  [MessageType.reject]: {
    1: uint('type'),
    2: string('reason'),
  },
  [MessageType.serverSync]: {
    1: uint('session'),
    2: uint('maxBandwidth'),
    3: string('welcomeText'),
    4: uint('permissions'),
  },
  [MessageType.channelRemove]: {
    1: uint('channelId'),
  },
  [MessageType.channelState]: {
    1: uint('channelId'),
    2: uint('parent'),
    3: string('name'),
    5: string('description'),
    8: bool('temporary'),
    9: uint('position'),
    11: uint('maxUsers'),
  },
  [MessageType.userRemove]: {
    1: uint('session'),
    2: uint('actor'),
    3: string('reason'),
    4: bool('ban'),
  },
  [MessageType.userState]: {
    1: uint('session'),
    2: uint('actor'),
    3: string('name'),
    4: uint('userId'),
    5: uint('channelId'),
    6: bool('mute'),
    7: bool('deaf'),
    8: bool('suppress'),
    9: bool('selfMute'),
    10: bool('selfDeaf'),
    12: bytes('pluginContext'),
    13: string('pluginIdentity'),
    14: string('comment'),
    15: string('hash'),
    18: bool('prioritySpeaker'),
    19: bool('recording'),
  },
  [MessageType.textMessage]: {
    1: uint('actor'),
    2: repeated(uint('sessions')),
    3: repeated(uint('channelIds')),
    4: repeated(uint('treeIds')),
    5: string('message'),
  },
  [MessageType.permissionDenied]: {
    1: uint('permission'),
    2: uint('channelId'),
    3: uint('session'),
    4: string('reason'),
    5: uint('type'),
    6: string('name'),
  },
  [MessageType.cryptSetup]: {
    1: bytes('key'),
    2: bytes('clientNonce'),
    3: bytes('serverNonce'),
  },
  [MessageType.permissionQuery]: {
    1: uint('channelId'),
    2: uint('permissions'),
    3: bool('flush'),
  },
  [MessageType.codecVersion]: {
    1: uint('alpha'),
    2: uint('beta'),
    3: bool('preferAlpha'),
    4: bool('opus'),
  },
  [MessageType.userStats]: {
    1: uint('session'),
    6: uint('udpPackets'),
    7: uint('tcpPackets'),
    8: bytes('udpPingAvg'),
    10: bytes('tcpPingAvg'),
    14: bytes('address'),
    15: uint('bandwidth'),
    16: uint('onlineSecs'),
    17: uint('idleSecs'),
    19: bool('opus'),
  },
  [MessageType.serverConfig]: {
    2: string('welcomeText'),
    3: bool('allowHtml'),
    4: uint('messageLength'),
    5: uint('imageMessageLength'),
    6: uint('maxUsers'),
  },
  [MessageType.suggestConfig]: {
    1: uint('version'),
    2: bool('positional'),
    3: bool('pushToTalk'),
  },
  [MessageType.pluginDataTransmission]: {
    1: uint('senderSession'),
    2: repeated(uint('receiverSessions')),
    3: bytes('data'),
    4: string('dataId'),
  },
};

export function frame(type, payload) {
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, type, false);
  view.setUint32(2, payload.length, false);
  out.set(payload, HEADER_SIZE);
  return out;
}

export class FrameParser {
  constructor() {
    this.buffer = new Uint8Array(0);
  }

  push(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    const frames = [];
    while (this.buffer.length >= HEADER_SIZE) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
      const type = view.getUint16(0, false);
      const length = view.getUint32(2, false);
      if (length > MAX_PAYLOAD) {
        throw new Error(`payload too large: ${length}`);
      }
      if (this.buffer.length < HEADER_SIZE + length) {
        break;
      }
      frames.push({ type, payload: this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + length) });
      this.buffer = this.buffer.subarray(HEADER_SIZE + length);
    }
    return frames;
  }
}

function fieldValue(field, kind) {
  switch (kind) {
    case 'string':
      return field.string;
    case 'bool':
      return field.bool;
    case 'bytes':
      return field.payload;
    default:
      return field.uint;
  }
}

export function decode(type, payload) {
  const message = {};
  const fields = FIELDS[type];
  if (!fields) {
    return message;
  }
  new Reader(payload).forEachField((field) => {
    const spec = fields[field.number];
    if (!spec) {
      return;
    }
    const [name, kind, isRepeated] = spec;
    const value = fieldValue(field, kind);
    if (isRepeated) {
      (message[name] ??= []).push(value);
    } else {
      message[name] = value;
    }
  });
  return message;
}

export function versionMessage({ v1, v2, release, os, osVersion }) {
  const payload = new Writer().uint(1, v1).string(2, release).string(3, os).string(4, osVersion).uint(5, v2).finish();
  return frame(MessageType.version, payload);
}

export function authenticateMessage({ username, password, tokens = [], opus = true }) {
  const writer = new Writer().string(1, username);
  if (password) {
    writer.string(2, password);
  }
  for (const token of tokens) {
    writer.string(3, token);
  }
  return frame(MessageType.authenticate, writer.bool(5, opus).uint(6, 0).finish());
}

export function pingMessage(timestampMicros) {
  return frame(MessageType.ping, new Writer().uint(1, timestampMicros).finish());
}

export function userStateMessage({ session, channelId, selfMute, selfDeaf, comment, pluginContext, pluginIdentity }) {
  const writer = new Writer();
  if (session !== undefined) {
    writer.uint(1, session);
  }
  if (channelId !== undefined) {
    writer.uint(5, channelId);
  }
  if (selfMute !== undefined) {
    writer.bool(9, selfMute);
  }
  if (selfDeaf !== undefined) {
    writer.bool(10, selfDeaf);
  }
  if (comment !== undefined) {
    writer.string(14, comment);
  }
  if (pluginContext !== undefined) {
    writer.bytes(12, pluginContext);
  }
  if (pluginIdentity !== undefined) {
    writer.string(13, pluginIdentity);
  }
  return frame(MessageType.userState, writer.finish());
}

export function textMessage({ actor, html, channelIds = [], treeIds = [], sessions = [] }) {
  const writer = new Writer().uint(1, actor);
  for (const session of sessions) {
    writer.uint(2, session);
  }
  for (const channelId of channelIds) {
    writer.uint(3, channelId);
  }
  for (const treeId of treeIds) {
    writer.uint(4, treeId);
  }
  return frame(MessageType.textMessage, writer.string(5, html).finish());
}

export function udpTunnel(packet) {
  return frame(MessageType.udpTunnel, packet);
}

export function pluginDataMessage({ sender, receivers, dataId, data }) {
  if (data.length > MAX_PLUGIN_DATA) {
    throw new Error(`plugin data too large: ${data.length} > ${MAX_PLUGIN_DATA}`);
  }
  const writer = new Writer().uint(1, sender);
  for (const receiver of receivers) {
    writer.uint(2, receiver);
  }
  return frame(MessageType.pluginDataTransmission, writer.bytes(3, data).string(4, dataId).finish());
}

export function createChannelMessage({ parent, name, temporary = true, description }) {
  const writer = new Writer().uint(2, parent).string(3, name).bool(8, temporary);
  if (description) {
    writer.string(5, description);
  }
  return frame(MessageType.channelState, writer.finish());
}

export function permissionQueryMessage(channelId, permissions) {
  return frame(MessageType.permissionQuery, new Writer().uint(1, channelId).uint(2, permissions).finish());
}

export function channelRemoveMessage(channelId) {
  return frame(MessageType.channelRemove, new Writer().uint(1, channelId).finish());
}

export function userStatsRequest(session) {
  return frame(MessageType.userStats, new Writer().uint(1, session).bool(2, false).finish());
}
