import crypto from 'node:crypto';
import tls from 'node:tls';

export function isFingerprint(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

// TLS encryption is established first; no application data may flow until this
// check succeeds or the user explicitly accepts this exact certificate.
export function inspectPeer(socket, host, expectedFingerprint) {
  const certificate = socket.getPeerCertificate();
  if (!certificate.raw) {
    throw new Error('The server did not provide a certificate.');
  }
  const fingerprint = crypto.createHash('sha256').update(certificate.raw).digest('hex');
  const authorized = socket.authorized && !tls.checkServerIdentity(host, certificate);
  return {
    fingerprint,
    expectedFingerprint: expectedFingerprint ?? null,
    subject: certificate.subject?.CN ?? host,
    validTo: certificate.valid_to,
    trusted: expectedFingerprint ? fingerprint === expectedFingerprint : authorized,
  };
}
