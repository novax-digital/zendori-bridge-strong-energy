import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Form API keys (§10.1): the clear-text key is shown exactly once on creation;
 * only its SHA-256 hex hash is stored (form_api_keys.key_hash).
 */

export function generateFormApiKey(): { key: string; keyHash: string } {
  const key = `zfk_${randomBytes(24).toString('base64url')}`;
  return { key, keyHash: hashFormApiKey(key) };
}

export function hashFormApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex hashes. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
