// Mumble control-channel protocol: framing, message types, and the subset of messages the
// web client needs. Field numbers mirror MumbleProtocol on iOS so both clients speak
// identically — including our PluginDataTransmission extension.

import { Reader, Writer } from './protobuf.js';

export const MessageType = {
  version: 0, udpTunnel: 1, authenticate: 2, ping: 3, reject: 4, serverSync: 5,
  channelRemove: 6, channelState: 7, userRemove: 8, userState: 9, banList: 10,
  textMessage: 11, permissionDenied: 12, acl: 13, queryUsers: 14, cryptSetup: 15,
  contextActionModify: 16, contextAction: 17, userList: 18, voiceTarget: 19,
  permissionQuery: 20, codecVersion: 21, userStats: 22, requestBlob: 23,
  serverConfig: 24, suggestConfig: 25, pluginDataTransmission: 26,
};
export const TypeName = Object.fromEntries(Object.entries(MessageType).map(([k, v]) => [v, k]));

export const HEADER_SIZE = 6;
export const MAX_PAYLOAD = 8 * 1024 * 1024;

/// 2-byte big-endian type, 4-byte big-endian length, then payload.
export function frame(type, payload) {
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, type, false);
  view.setUint32(2, payload.length, false);
  out.set(payload, HEADER_SIZE);
  return out;
}

/// Accumulates bytes and yields whole frames; the TCP stream splits them arbitrarily.
export class FrameParser {
  constructor() { this.buf = new Uint8Array(0); }
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    this.buf = merged;
    const frames = [];
    while (this.buf.length >= HEADER_SIZE) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset);
      const type = view.getUint16(0, false);
      const len = view.getUint32(2, false);
      if (len > MAX_PAYLOAD) throw new Error(`payload too large: ${len}`);
      if (this.buf.length < HEADER_SIZE + len) break;
      frames.push({ type, payload: this.buf.subarray(HEADER_SIZE, HEADER_SIZE + len) });
      this.buf = this.buf.subarray(HEADER_SIZE + len);
    }
    return frames;
  }
}

// ---- encode ----

export function versionMessage({ v1, v2, release, os, osVersion }) {
  return frame(MessageType.version, new Writer()
    .uint(1, v1).string(2, release).string(3, os).string(4, osVersion).uint(5, v2).finish());
}

export function authenticateMessage({ username, password, tokens = [], opus = true }) {
  const w = new Writer().string(1, username);
  if (password) w.string(2, password);
  for (const t of tokens) w.string(3, t);
  return frame(MessageType.authenticate, w.bool(5, opus).uint(6, 0).finish());
}

export function pingMessage(timestampMicros) {
  return frame(MessageType.ping, new Writer().uint(1, timestampMicros).finish());
}

// ---- decode ----

export function decode(type, payload) {
  const r = new Reader(payload);
  const out = { _type: TypeName[type] ?? type };
  const map = FIELDS[type];
  if (!map) return out;
  r.forEachField(f => {
    const spec = map[f.number];
    if (!spec) return;
    const [name, kind, repeated] = spec;
    const value = kind === 'string' ? f.string : kind === 'bool' ? f.bool
      : kind === 'bytes' ? f.payload : f.uint;
    if (repeated) (out[name] ??= []).push(value);
    else out[name] = value;
  });
  return out;
}

const FIELDS = {
  [MessageType.version]: { 1: ['v1', 'uint'], 2: ['release', 'string'], 3: ['os', 'string'], 4: ['osVersion', 'string'], 5: ['v2', 'uint'] },
  [MessageType.reject]: { 1: ['type', 'uint'], 2: ['reason', 'string'] },
  [MessageType.serverSync]: { 1: ['session', 'uint'], 2: ['maxBandwidth', 'uint'], 3: ['welcomeText', 'string'], 4: ['permissions', 'uint'] },
  [MessageType.channelState]: { 1: ['channelId', 'uint'], 2: ['parent', 'uint'], 3: ['name', 'string'], 5: ['description', 'string'], 8: ['temporary', 'bool'], 9: ['position', 'uint'], 11: ['maxUsers', 'uint'] },
  [MessageType.channelRemove]: { 1: ['channelId', 'uint'] },
  [MessageType.userState]: { 1: ['session', 'uint'], 2: ['actor', 'uint'], 3: ['name', 'string'], 4: ['userId', 'uint'], 5: ['channelId', 'uint'], 6: ['mute', 'bool'], 7: ['deaf', 'bool'], 8: ['suppress', 'bool'], 9: ['selfMute', 'bool'], 10: ['selfDeaf', 'bool'], 14: ['comment', 'string'], 18: ['prioritySpeaker', 'bool'] },
  [MessageType.userRemove]: { 1: ['session', 'uint'], 2: ['actor', 'uint'], 3: ['reason', 'string'], 4: ['ban', 'bool'] },
  [MessageType.textMessage]: { 1: ['actor', 'uint'], 2: ['session', 'uint', true], 3: ['channelId', 'uint', true], 5: ['message', 'string'] },
  [MessageType.permissionDenied]: { 2: ['permission', 'uint'], 3: ['channelId', 'uint'], 4: ['session', 'uint'], 5: ['reason', 'string'], 6: ['type', 'uint'], 7: ['name', 'string'] },
  [MessageType.serverConfig]: { 2: ['welcomeText', 'string'], 3: ['allowHtml', 'bool'], 4: ['messageLength', 'uint'], 5: ['imageMessageLength', 'uint'], 6: ['maxUsers', 'uint'] },
  [MessageType.pluginDataTransmission]: { 1: ['senderSession', 'uint'], 2: ['receiverSessions', 'uint', true], 3: ['data', 'bytes'], 4: ['dataId', 'string'] },
};

export const REJECT_REASONS = {
  0: 'None', 1: 'Wrong version', 2: 'Invalid username', 3: 'Wrong user password',
  4: 'Wrong server password', 5: 'Username already in use', 6: 'Server is full',
  7: 'No certificate', 8: 'Authentication failed', 9: 'No new connections',
};
