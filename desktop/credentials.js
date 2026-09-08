import fs from 'node:fs';
import path from 'node:path';

export class CredentialVault {
  constructor(file, encryption) {
    this.file = file;
    this.encryption = encryption;
    this.loaded = false;
  }

  read() {
    this.loaded = false;
    if (!this.encryption.available()) return { available: false };
    const value = fs.existsSync(this.file)
      ? JSON.parse(this.encryption.decrypt(fs.readFileSync(this.file)))
      : { servers: {}, turn: '' };
    validateCredentials(value);
    this.loaded = true;
    return { available: true, value };
  }

  write(value) {
    if (!this.loaded || !this.encryption.available()) throw new Error('Secure storage is unavailable');
    validateCredentials(value);
    const bytes = this.encryption.encrypt(JSON.stringify(value));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

function validateCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['servers', 'turn'].includes(key)) ||
      typeof value.turn !== 'string' || value.turn.length > 65_536 ||
      !value.servers || typeof value.servers !== 'object' || Array.isArray(value.servers) ||
      Object.keys(value.servers).length > 12 ||
      Object.entries(value.servers).some(([key, password]) => key.length > 4096 || typeof password !== 'string' || password.length > 65_536)) {
    throw new Error('Invalid credentials');
  }
}
