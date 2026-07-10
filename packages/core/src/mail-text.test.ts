import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { detectAutoSubmitted, extractTicketRef, stripReplyText } from './mail-text.js';

test('strips a German Apple-Mail reply chain', () => {
  const text = [
    'Hallo Team,',
    '',
    'die Rechnung Nr. 4711 ist leider immer noch falsch, bitte korrigieren Sie den Betrag.',
    '',
    'Viele Grüße',
    'Max',
    '',
    'Am 09.07.2026 um 14:22 schrieb Max Mustermann:',
    '> Sehr geehrte Damen und Herren,',
    '> anbei erhalten Sie die Rechnung Nr. 4711 zu Ihrer Bestellung.',
    '> Mit freundlichen Grüßen',
  ].join('\n');
  const result = stripReplyText(text);
  assert.ok(result.includes('Rechnung Nr. 4711 ist leider immer noch falsch'));
  assert.ok(!result.includes('Am 09.07.2026 um 14:22 schrieb'));
  assert.ok(!result.includes('anbei erhalten Sie die Rechnung'));
});

test('strips a German Outlook quoted-header block', () => {
  const text = [
    'Hallo,',
    '',
    'anbei die gewünschten Unterlagen zur Reklamation der Bestellung 88123.',
    '',
    'Mit freundlichen Grüßen',
    'Erika Musterfrau',
    '',
    'Von: Support Team <support@example.de>',
    'Gesendet: Mittwoch, 9. Juli 2026 10:15',
    'An: erika@example.com',
    'Betreff: AW: Ihre Bestellung 88123',
    '',
    'Sehr geehrte Frau Musterfrau, vielen Dank für Ihre Nachricht.',
  ].join('\n');
  const result = stripReplyText(text);
  assert.ok(result.includes('Unterlagen zur Reklamation der Bestellung 88123'));
  assert.ok(!result.includes('Von: Support Team'));
  assert.ok(!result.includes('Sehr geehrte Frau Musterfrau'));
});

test('strips a signature after the "-- " delimiter', () => {
  const text = [
    'Bitte senden Sie mir ein neues Angebot für 500 Stück.',
    '',
    '-- ',
    'Max Mustermann',
    'Beispiel GmbH, Musterstraße 1, 12345 Musterstadt',
  ].join('\n');
  const result = stripReplyText(text);
  assert.equal(result, 'Bitte senden Sie mir ein neues Angebot für 500 Stück.');
});

test('removes interleaved quoted lines while keeping own text', () => {
  const text = [
    '> Können Sie mir sagen, wann die Lieferung ankommt?',
    'Die Lieferung sollte laut Ankündigung schon am Montag da sein.',
    '> Benötigen Sie sonst noch etwas?',
    'Ja, bitte senden Sie mir die Rechnung Nr. 4711 erneut zu.',
  ].join('\n');
  const result = stripReplyText(text);
  assert.equal(
    result,
    [
      'Die Lieferung sollte laut Ankündigung schon am Montag da sein.',
      'Ja, bitte senden Sie mir die Rechnung Nr. 4711 erneut zu.',
    ].join('\n'),
  );
});

test('returns a short message without markers unchanged', () => {
  const text = 'Bitte rufen Sie mich morgen zurück.';
  assert.equal(stripReplyText(text), text);
});

test('falls back to the trimmed original when stripping leaves almost nothing', () => {
  const text = [
    'Ok, danke!',
    '',
    'Am 09.07.2026 um 14:22 schrieb Support Team:',
    '> Ihre Anfrage wurde bearbeitet und das Ticket geschlossen.',
  ].join('\n');
  assert.equal(stripReplyText(text), text.trim());
});

test('falls back to the trimmed original for fully quoted text', () => {
  const text = '> Erste zitierte Zeile\n> Zweite zitierte Zeile\n';
  assert.equal(stripReplyText(text), text.trim());
});

test('extractTicketRef finds a bracketed ref', () => {
  assert.equal(extractTicketRef('[ZV1-0042] Ihre Anfrage bei uns'), 'ZV1-0042');
});

test('extractTicketRef finds a lowercase ref without brackets', () => {
  assert.equal(extractTicketRef('AW: zv1-0042 Rückfrage'), 'ZV1-0042');
});

test('extractTicketRef returns null without a ref', () => {
  assert.equal(extractTicketRef('AW: Ihre Bestellung 88123'), null);
  assert.equal(extractTicketRef(null), null);
});

test('detectAutoSubmitted flags Auto-Submitted: auto-replied', () => {
  const result = detectAutoSubmitted({ 'Auto-Submitted': 'auto-replied' });
  assert.equal(result.isAutoSubmitted, true);
  assert.equal(result.reason, 'Auto-Submitted: auto-replied');
});

test('detectAutoSubmitted ignores Auto-Submitted: no', () => {
  const result = detectAutoSubmitted({ 'AUTO-SUBMITTED': 'No' });
  assert.equal(result.isAutoSubmitted, false);
  assert.equal(result.reason, null);
});

test('detectAutoSubmitted flags X-Auto-Response-Suppress: All', () => {
  const result = detectAutoSubmitted({ 'X-Auto-Response-Suppress': 'All' });
  assert.equal(result.isAutoSubmitted, true);
  assert.equal(result.reason, 'X-Auto-Response-Suppress: All');
});

test('detectAutoSubmitted ignores X-Auto-Response-Suppress: None (means suppress nothing)', () => {
  const result = detectAutoSubmitted({ 'X-Auto-Response-Suppress': 'None' });
  assert.equal(result.isAutoSubmitted, false);
  assert.equal(result.reason, null);
});

test('detectAutoSubmitted flags Precedence: bulk', () => {
  const result = detectAutoSubmitted({ Precedence: 'bulk' });
  assert.equal(result.isAutoSubmitted, true);
  assert.equal(result.reason, 'Precedence: bulk');
});

test('detectAutoSubmitted handles array header values', () => {
  const result = detectAutoSubmitted({ precedence: ['first-class', 'Bulk'] });
  assert.equal(result.isAutoSubmitted, true);
  assert.equal(result.reason, 'precedence: Bulk');
});

test('detectAutoSubmitted flags X-Autoreply presence', () => {
  const result = detectAutoSubmitted({ 'x-autoreply': 'yes' });
  assert.equal(result.isAutoSubmitted, true);
  assert.equal(result.reason, 'x-autoreply: yes');
});

test('detectAutoSubmitted returns false for a normal mail', () => {
  const result = detectAutoSubmitted({
    from: 'Max Mustermann <max@example.com>',
    to: 'support@example.de',
    subject: 'Frage zur Rechnung Nr. 4711',
    'message-id': '<abc@example.com>',
  });
  assert.equal(result.isAutoSubmitted, false);
  assert.equal(result.reason, null);
});
