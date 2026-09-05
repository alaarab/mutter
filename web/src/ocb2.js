import crypto from 'node:crypto';

const BLOCK = 16;
const TAG_BYTES = 3;
const HEADER = 1 + TAG_BYTES;
const REORDER_WINDOW = 30;

function aes128(key) {
  const encryptor = crypto.createCipheriv('aes-128-ecb', key, null);
  encryptor.setAutoPadding(false);
  const decryptor = crypto.createDecipheriv('aes-128-ecb', key, null);
  decryptor.setAutoPadding(false);
  return {
    encryptBlock: (block) => new Uint8Array(encryptor.update(block)),
    decryptBlock: (block) => new Uint8Array(decryptor.update(block)),
  };
}

function xor(a, b) {
  const out = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

function double(block) {
  const carry = block[0] >> 7;
  for (let i = 0; i < BLOCK - 1; i++) {
    block[i] = ((block[i] << 1) | (block[i + 1] >> 7)) & 0xff;
  }
  block[BLOCK - 1] = ((block[BLOCK - 1] << 1) ^ (carry * 0x87)) & 0xff;
}

function triple(block) {
  const doubled = Uint8Array.from(block);
  double(doubled);
  for (let i = 0; i < BLOCK; i++) {
    block[i] ^= doubled[i];
  }
}

function lengthBlock(byteCount) {
  const block = new Uint8Array(BLOCK);
  const bits = byteCount * 8;
  block[12] = (bits >>> 24) & 0xff;
  block[13] = (bits >>> 16) & 0xff;
  block[14] = (bits >>> 8) & 0xff;
  block[15] = bits & 0xff;
  return block;
}

function incrementFrom(iv, start) {
  for (let i = start; i < BLOCK; i++) {
    iv[i] = (iv[i] + 1) & 0xff;
    if (iv[i]) {
      break;
    }
  }
}

function decrementFrom(iv, start) {
  for (let i = start; i < BLOCK; i++) {
    const before = iv[i];
    iv[i] = (iv[i] - 1) & 0xff;
    if (before) {
      break;
    }
  }
}

export class CryptState {
  constructor(cipherFactory = aes128) {
    this.makeCipher = cipherFactory;
    this.cipher = null;
    this.encryptIV = new Uint8Array(BLOCK);
    this.decryptIV = new Uint8Array(BLOCK);
    this.history = new Uint8Array(256);
    this.good = 0;
    this.late = 0;
    this.lost = 0;
    this.resync = 0;
    this.lastGood = 0;
  }

  get isValid() {
    return !!this.cipher;
  }

  setKey(key, encryptIV, decryptIV) {
    if (key.length !== BLOCK || encryptIV.length !== BLOCK || decryptIV.length !== BLOCK) {
      return false;
    }
    this.cipher = this.makeCipher(Uint8Array.from(key));
    this.encryptIV = Uint8Array.from(encryptIV);
    this.decryptIV = Uint8Array.from(decryptIV);
    this.history.fill(0);
    this.good = 0;
    this.late = 0;
    this.lost = 0;
    this.resync = 0;
    return true;
  }

  setDecryptIV(iv) {
    if (iv.length !== BLOCK) {
      return false;
    }
    this.decryptIV = Uint8Array.from(iv);
    this.resync++;
    return true;
  }

  encrypt(plain) {
    if (!this.cipher) {
      return null;
    }
    incrementFrom(this.encryptIV, 0);
    const { ciphertext, tag } = this.ocbEncrypt(plain, this.encryptIV);
    const out = new Uint8Array(HEADER + ciphertext.length);
    out[0] = this.encryptIV[0];
    out[1] = tag[0];
    out[2] = tag[1];
    out[3] = tag[2];
    out.set(ciphertext, HEADER);
    return out;
  }

  decrypt(crypted) {
    if (!this.cipher || crypted.length < HEADER) {
      return null;
    }
    const ivByte = crypted[0];
    const saved = Uint8Array.from(this.decryptIV);
    const iv = this.decryptIV;
    let restoreAfter = false;
    let lostDelta = 0;
    let lateDelta = 0;

    if (((iv[0] + 1) & 0xff) === ivByte) {
      if (ivByte > iv[0]) {
        iv[0] = ivByte;
      } else if (ivByte < iv[0]) {
        iv[0] = ivByte;
        incrementFrom(iv, 1);
      } else {
        return null;
      }
    } else {
      let diff = ivByte - iv[0];
      if (diff > 128) {
        diff -= 256;
      } else if (diff < -128) {
        diff += 256;
      }
      const isLate = diff > -REORDER_WINDOW && diff < 0;
      if (ivByte < iv[0] && isLate) {
        lateDelta = 1;
        lostDelta = -1;
        iv[0] = ivByte;
        restoreAfter = true;
      } else if (ivByte > iv[0] && isLate) {
        lateDelta = 1;
        lostDelta = -1;
        iv[0] = ivByte;
        restoreAfter = true;
        decrementFrom(iv, 1);
      } else if (ivByte > iv[0] && diff > 0) {
        lostDelta = ivByte - iv[0] - 1;
        iv[0] = ivByte;
      } else if (ivByte < iv[0] && diff > 0) {
        lostDelta = 256 - iv[0] + ivByte - 1;
        iv[0] = ivByte;
        incrementFrom(iv, 1);
      } else {
        return null;
      }
      if (this.history[iv[0]] === iv[1]) {
        this.decryptIV = saved;
        return null;
      }
    }

    const { plain, tag, ok } = this.ocbDecrypt(crypted.subarray(HEADER), iv);
    const tagMatches = tag[0] === crypted[1] && tag[1] === crypted[2] && tag[2] === crypted[3];
    if (!ok || !tagMatches) {
      this.decryptIV = saved;
      return null;
    }
    this.history[iv[0]] = iv[1];
    if (restoreAfter) {
      this.decryptIV = saved;
    }
    this.good++;
    this.late = adjustCounter(this.late, lateDelta);
    this.lost = adjustCounter(this.lost, lostDelta);
    this.lastGood = Date.now();
    return plain;
  }

  ocbEncrypt(plain, nonce) {
    const cipher = this.cipher;
    const delta = cipher.encryptBlock(nonce);
    let checksum = new Uint8Array(BLOCK);
    const out = new Uint8Array(plain.length);
    let remaining = plain.length;
    let offset = 0;
    while (remaining > BLOCK) {
      const block = plain.subarray(offset, offset + BLOCK);
      const flipBit = remaining - BLOCK <= BLOCK && isZeroExceptLastByte(block);
      double(delta);
      let masked = xor(delta, block);
      if (flipBit) {
        masked[0] ^= 1;
      }
      masked = cipher.encryptBlock(masked);
      out.set(xor(delta, masked), offset);
      checksum = xor(checksum, block);
      if (flipBit) {
        checksum[0] ^= 1;
      }
      remaining -= BLOCK;
      offset += BLOCK;
    }
    double(delta);
    const pad = cipher.encryptBlock(xor(lengthBlock(remaining), delta));
    const tail = new Uint8Array(BLOCK);
    for (let i = 0; i < remaining; i++) {
      tail[i] = plain[offset + i];
    }
    for (let i = remaining; i < BLOCK; i++) {
      tail[i] = pad[i];
    }
    checksum = xor(checksum, tail);
    const encryptedTail = xor(pad, tail);
    for (let i = 0; i < remaining; i++) {
      out[offset + i] = encryptedTail[i];
    }
    triple(delta);
    return { ciphertext: out, tag: cipher.encryptBlock(xor(delta, checksum)) };
  }

  ocbDecrypt(encrypted, nonce) {
    const cipher = this.cipher;
    const delta = cipher.encryptBlock(nonce);
    let checksum = new Uint8Array(BLOCK);
    const out = new Uint8Array(encrypted.length);
    let remaining = encrypted.length;
    let offset = 0;
    while (remaining > BLOCK) {
      double(delta);
      const block = encrypted.subarray(offset, offset + BLOCK);
      const plain = xor(delta, cipher.decryptBlock(xor(delta, block)));
      out.set(plain, offset);
      checksum = xor(checksum, plain);
      remaining -= BLOCK;
      offset += BLOCK;
    }
    double(delta);
    const pad = cipher.encryptBlock(xor(lengthBlock(remaining), delta));
    let tail = new Uint8Array(BLOCK);
    for (let i = 0; i < remaining; i++) {
      tail[i] = encrypted[offset + i];
    }
    tail = xor(tail, pad);
    checksum = xor(checksum, tail);
    for (let i = 0; i < remaining; i++) {
      out[offset + i] = tail[i];
    }
    const ok = !prefixMatches(tail, delta);
    triple(delta);
    return { plain: out, tag: cipher.encryptBlock(xor(delta, checksum)), ok };
  }
}

function isZeroExceptLastByte(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK - 1; i++) {
    sum |= block[i];
  }
  return sum === 0;
}

function prefixMatches(a, b) {
  for (let i = 0; i < BLOCK - 1; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function adjustCounter(counter, delta) {
  if (delta > 0) {
    return counter + delta;
  }
  if (counter > -delta) {
    return counter + delta;
  }
  return counter;
}
