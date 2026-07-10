import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { redactPiiForAi } from './pii-redaction.js';

test('masks e-mail addresses', () => {
  const out = redactPiiForAi('Bitte an s.beck@beispiel-gmbh.de antworten.');
  assert.equal(out.includes('s.beck@'), false);
  assert.equal(out.includes('[E-MAIL ENTFERNT]'), true);
});

test('masks German phone numbers (0..., +49, grouped)', () => {
  for (const phone of ['0171 2345678', '+49 30 123 45 67', '030/1234567', '(0171) 234-5678']) {
    const out = redactPiiForAi(`Rückruf unter ${phone} bitte.`);
    assert.equal(out.includes('[TELEFONNUMMER ENTFERNT]'), true, phone);
    assert.equal(/\d{5,}/.test(out.replace(/\D/g, '')), false, `digits left for ${phone}`);
  }
});

test('keeps short numbers and ticket refs untouched', () => {
  const out = redactPiiForAi('Modell EnergyBox 22, Referenz ZV1-0042, seit 3 Tagen defekt.');
  assert.equal(out, 'Modell EnergyBox 22, Referenz ZV1-0042, seit 3 Tagen defekt.');
});

test('masks known sender values incl. name in the signature', () => {
  const out = redactPiiForAi('Viele Grüße\nSandra Beck\nBeispiel GmbH', {
    name: 'Sandra Beck',
  });
  assert.equal(out.includes('Sandra Beck'), false);
  assert.equal(out.includes('[NAME ENTFERNT]'), true);
});

test('does not mask order-number-like values without phone shape', () => {
  const out = redactPiiForAi('Bestellnummer 4711-AB-2024 fehlt.');
  assert.equal(out.includes('4711-AB-2024'), true);
});
