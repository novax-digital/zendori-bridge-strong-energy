import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Secrets at rest (CLAUDE.md §10.2/§12): mailbox credentials are stored
 * AES-256-GCM-encrypted. Key comes from ENCRYPTION_KEY (32 bytes, hex).
 *
 * Wire format: "v1.<iv b64>.<authTag b64>.<ciphertext b64>" — versioned so a
 * future key/algorithm rotation can coexist with old rows.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('Encryption key must be 32 bytes, hex-encoded (64 hex chars)');
  }
  return Buffer.from(keyHex, 'hex');
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decryptSecret(payload: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unknown encrypted payload format');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64!, 'base64');
  const authTag = Buffer.from(tagB64!, 'base64');
  // Reject truncated IVs/tags — GCM would otherwise accept short auth tags,
  // weakening tamper resistance of the stored credentials.
  if (iv.length !== IV_BYTES || authTag.length !== 16) {
    throw new Error('Unknown encrypted payload format');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64!, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
