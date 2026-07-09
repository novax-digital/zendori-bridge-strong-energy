import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { decryptSecret, encryptSecret } from './crypto.js';

const key = randomBytes(32).toString('hex');

test('roundtrip preserves the plaintext', () => {
  const secret = 'imap-pässwörd-with-umlauts-🔐';
  const encrypted = encryptSecret(secret, key);
  assert.equal(decryptSecret(encrypted, key), secret);
});

test('ciphertexts are salted (same input, different output)', () => {
  assert.notEqual(encryptSecret('same', key), encryptSecret('same', key));
});

test('tampered ciphertext is rejected', () => {
  const encrypted = encryptSecret('secret', key);
  const parts = encrypted.split('.');
  const body = Buffer.from(parts[3]!, 'base64');
  body[0] = body[0]! ^ 0xff;
  const tampered = [parts[0], parts[1], parts[2], body.toString('base64')].join('.');
  assert.throws(() => decryptSecret(tampered, key));
});

test('wrong key is rejected', () => {
  const encrypted = encryptSecret('secret', key);
  const otherKey = randomBytes(32).toString('hex');
  assert.throws(() => decryptSecret(encrypted, otherKey));
});

test('malformed key is rejected early', () => {
  assert.throws(() => encryptSecret('secret', 'not-a-key'));
});
