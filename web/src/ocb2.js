// Mumble's voice-packet cipher: OCB2-AES128 with its nonce-recovery and replay rules — a port of
// CryptStateOCB2.cpp via the iOS OCB2.swift. Wire layout: [iv byte][tag0][tag1][tag2][ciphertext].
// Node only (the bridge and the fake server); the browser never touches UDP crypto.

import crypto from 'node:crypto';

/// Single-block AES-128. ECB with padding off is exactly "encrypt one 16-byte block".
export function aes128(key) {
  const enc = crypto.createCipheriv('aes-128-ecb', key, null); enc.setAutoPadding(false);
  const dec = crypto.createDecipheriv('aes-128-ecb', key, null); dec.setAutoPadding(false);
  return { encryptBlock: b => new Uint8Array(enc.update(b)), decryptBlock: b => new Uint8Array(dec.update(b)) };
}

const xor = (a, b) => { const o = new Uint8Array(16); for (let i = 0; i < 16; i++) o[i] = a[i] ^ b[i]; return o; };
/// Doubles the block in GF(2^128): shift left by one, reduce with 0x87.
function s2(block) {
  const carry = block[0] >> 7;
  for (let i = 0; i < 15; i++) block[i] = ((block[i] << 1) | (block[i + 1] >> 7)) & 0xff;
  block[15] = ((block[15] << 1) ^ (carry * 0x87)) & 0xff;
}
function s3(block) { const d = Uint8Array.from(block); s2(d); for (let i = 0; i < 16; i++) block[i] ^= d[i]; }

export class CryptState {
  constructor(cipherFactory = aes128) {
    this.makeCipher = cipherFactory;
    this.cipher = null;
    this.encryptIV = new Uint8Array(16); this.decryptIV = new Uint8Array(16);
    this.history = new Uint8Array(256);
    this.good = 0; this.late = 0; this.lost = 0; this.resync = 0;
    this.lastGood = 0;
  }
  get isValid() { return !!this.cipher; }

  /// Client side: `encryptIV` is our nonce (client_nonce), `decryptIV` the server's. Servers swap them.
  setKey(key, encryptIV, decryptIV) {
    if (key.length !== 16 || encryptIV.length !== 16 || decryptIV.length !== 16) return false;
    this.cipher = this.makeCipher(Uint8Array.from(key));
    this.encryptIV = Uint8Array.from(encryptIV); this.decryptIV = Uint8Array.from(decryptIV);
    this.history.fill(0); this.good = this.late = this.lost = this.resync = 0;
    return true;
  }
  setDecryptIV(iv) { if (iv.length !== 16) return false; this.decryptIV = Uint8Array.from(iv); this.resync++; return true; }

  encrypt(plain) {
    if (!this.cipher) return null;
    for (let i = 0; i < 16; i++) { this.encryptIV[i] = (this.encryptIV[i] + 1) & 0xff; if (this.encryptIV[i]) break; }
    const { ct, tag } = this._ocbEncrypt(plain, this.encryptIV);
    const out = new Uint8Array(4 + ct.length);
    out[0] = this.encryptIV[0]; out[1] = tag[0]; out[2] = tag[1]; out[3] = tag[2];
    out.set(ct, 4);
    return out;
  }

  decrypt(crypted) {
    if (!this.cipher || crypted.length < 4) return null;
    const ivByte = crypted[0], saved = Uint8Array.from(this.decryptIV), iv = this.decryptIV;
    let restore = false, lostDelta = 0, lateDelta = 0;
    if (((iv[0] + 1) & 0xff) === ivByte) {
      if (ivByte > iv[0]) iv[0] = ivByte;
      else if (ivByte < iv[0]) { iv[0] = ivByte; for (let i = 1; i < 16; i++) { iv[i] = (iv[i] + 1) & 0xff; if (iv[i]) break; } }
      else return null;
    } else {
      let diff = ivByte - iv[0];
      if (diff > 128) diff -= 256; else if (diff < -128) diff += 256;
      if (ivByte < iv[0] && diff > -30 && diff < 0) { lateDelta = 1; lostDelta = -1; iv[0] = ivByte; restore = true; }
      else if (ivByte > iv[0] && diff > -30 && diff < 0) {
        lateDelta = 1; lostDelta = -1; iv[0] = ivByte; restore = true;
        for (let i = 1; i < 16; i++) { const before = iv[i]; iv[i] = (iv[i] - 1) & 0xff; if (before) break; }
      } else if (ivByte > iv[0] && diff > 0) { lostDelta = ivByte - iv[0] - 1; iv[0] = ivByte; }
      else if (ivByte < iv[0] && diff > 0) { lostDelta = 256 - iv[0] + ivByte - 1; iv[0] = ivByte; for (let i = 1; i < 16; i++) { iv[i] = (iv[i] + 1) & 0xff; if (iv[i]) break; } }
      else return null;
      if (this.history[iv[0]] === iv[1]) { this.decryptIV = saved; return null; }
    }
    const { plain, tag, ok } = this._ocbDecrypt(crypted.subarray(4), iv);
    if (!ok || tag[0] !== crypted[1] || tag[1] !== crypted[2] || tag[2] !== crypted[3]) { this.decryptIV = saved; return null; }
    this.history[iv[0]] = iv[1];
    if (restore) this.decryptIV = saved;
    this.good++;
    if (lateDelta > 0) this.late += lateDelta; else if (this.late > -lateDelta) this.late += lateDelta;
    if (lostDelta > 0) this.lost += lostDelta; else if (this.lost > -lostDelta) this.lost += lostDelta;
    this.lastGood = Date.now();
    return plain;
  }

  _ocbEncrypt(plain, nonce) {
    const c = this.cipher;
    let delta = c.encryptBlock(nonce), checksum = new Uint8Array(16);
    const out = new Uint8Array(plain.length);
    let len = plain.length, off = 0;
    while (len > 16) {
      const block = plain.subarray(off, off + 16);
      // Counter-cryptanalysis (eprint 2019/311 §9): a second-to-last block that is zero apart from
      // its last byte gets a bit flipped so the packet can't be exploited.
      let flip = false;
      if (len - 16 <= 16) { let sum = 0; for (let i = 0; i < 15; i++) sum |= block[i]; flip = sum === 0; }
      s2(delta);
      let tmp = xor(delta, block);
      if (flip) tmp[0] ^= 1;
      tmp = c.encryptBlock(tmp);
      out.set(xor(delta, tmp), off);
      checksum = xor(checksum, block);
      if (flip) checksum[0] ^= 1;
      len -= 16; off += 16;
    }
    s2(delta);
    const lenBlock = new Uint8Array(16); const bits = len * 8;
    lenBlock[12] = (bits >>> 24) & 0xff; lenBlock[13] = (bits >>> 16) & 0xff; lenBlock[14] = (bits >>> 8) & 0xff; lenBlock[15] = bits & 0xff;
    const pad = c.encryptBlock(xor(lenBlock, delta));
    const tail = new Uint8Array(16);
    for (let i = 0; i < len; i++) tail[i] = plain[off + i];
    for (let i = len; i < 16; i++) tail[i] = pad[i];
    checksum = xor(checksum, tail);
    const enc = xor(pad, tail);
    for (let i = 0; i < len; i++) out[off + i] = enc[i];
    s3(delta);
    return { ct: out, tag: c.encryptBlock(xor(delta, checksum)) };
  }

  _ocbDecrypt(encrypted, nonce) {
    const c = this.cipher;
    let delta = c.encryptBlock(nonce), checksum = new Uint8Array(16);
    const out = new Uint8Array(encrypted.length);
    let len = encrypted.length, off = 0;
    while (len > 16) {
      s2(delta);
      const plain = xor(delta, c.decryptBlock(xor(delta, encrypted.subarray(off, off + 16))));
      out.set(plain, off);
      checksum = xor(checksum, plain);
      len -= 16; off += 16;
    }
    s2(delta);
    const lenBlock = new Uint8Array(16); const bits = len * 8;
    lenBlock[12] = (bits >>> 24) & 0xff; lenBlock[13] = (bits >>> 16) & 0xff; lenBlock[14] = (bits >>> 8) & 0xff; lenBlock[15] = bits & 0xff;
    const pad = c.encryptBlock(xor(lenBlock, delta));
    let tail = new Uint8Array(16);
    for (let i = 0; i < len; i++) tail[i] = encrypted[off + i];
    tail = xor(tail, pad);
    checksum = xor(checksum, tail);
    for (let i = 0; i < len; i++) out[off + i] = tail[i];
    let ok = false;                                   // the decrypted last block equal to delta is the attack shape
    for (let i = 0; i < 15; i++) if (tail[i] !== delta[i]) { ok = true; break; }
    s3(delta);
    return { plain: out, tag: c.encryptBlock(xor(delta, checksum)), ok };
  }
}
