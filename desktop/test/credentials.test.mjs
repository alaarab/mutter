import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { CredentialVault } from '../credentials.js';

test('vault encrypts credentials and preserves them when encryption or decryption fails', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credentials.enc');
  const key = crypto.randomBytes(32);
  const encryption = {
    available: () => true,
    encrypt(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
    },
    decrypt(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
    },
  };
  const value = { servers: { example: 'private-server-password' }, turn: 'private-turn-password' };
  const vault = new CredentialVault(file, encryption);
  assert.throws(() => vault.write(value), /unavailable/);
  vault.read();
  vault.write(value);
  const encrypted = fs.readFileSync(file);
  assert.ok(!encrypted.includes('private-server-password'));
  assert.ok(!encrypted.includes('private-turn-password'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new CredentialVault(file, encryption).read().value, value);
  encryption.encrypt = () => { throw new Error('locked'); };
  assert.throws(() => vault.write({ servers: {}, turn: '' }), /locked/);
  assert.deepEqual(fs.readFileSync(file), encrypted);
  encryption.available = () => false;
  assert.deepEqual(vault.read(), { available: false });
  assert.throws(() => vault.write(value), /unavailable/);
  encryption.available = () => true;
  const corrupt = Buffer.from(encrypted);
  corrupt[corrupt.length - 1] ^= 1;
  fs.writeFileSync(file, corrupt);
  assert.throws(() => vault.read());
  assert.throws(() => vault.write(value), /unavailable/);
  assert.deepEqual(fs.readFileSync(file), corrupt);
});
