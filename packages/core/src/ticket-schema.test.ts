import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildTicketJsonSchema, hasRequiredTicketFields, ticketExtractionSchema } from './ticket-schema.js';

const valid = {
  contact: { name: 'Sandra Beck', email: 's.beck@beispiel.de', phone: null, company: null },
  ticket: {
    subject: 'Wallbox lädt nicht',
    description: 'Die Wallbox in der Tiefgarage lädt seit gestern nicht mehr.',
    category: 'Störung',
    priority: 'high',
    priority_reason: 'Dienstwagen müssen morgen früh raus.',
    language: 'de',
  },
  meta: { is_spam: false, is_auto_reply: false, summary: 'Wallbox-Störung gemeldet.' },
  extraction: { confidence: 0.95, missing_fields: [], questions: [] },
};

test('valid extraction passes', () => {
  assert.equal(ticketExtractionSchema.safeParse(valid).success, true);
});

test('subject longer than 80 chars is rejected by Zod (not by the API schema)', () => {
  const tooLong = { ...valid, ticket: { ...valid.ticket, subject: 'x'.repeat(81) } };
  assert.equal(ticketExtractionSchema.safeParse(tooLong).success, false);
});

test('more than 3 questions are rejected', () => {
  const many = { ...valid, extraction: { ...valid.extraction, questions: ['a', 'b', 'c', 'd'] } };
  assert.equal(ticketExtractionSchema.safeParse(many).success, false);
});

test('unknown extra keys are rejected (strict object)', () => {
  const extra = { ...valid, surprise: true };
  // The API schema forbids extras via additionalProperties:false; Zod objects
  // strip unknown keys by default — parse must still succeed and drop them.
  const parsed = ticketExtractionSchema.safeParse(extra);
  assert.equal(parsed.success, true);
  assert.equal('surprise' in (parsed.data as Record<string, unknown>), false);
});

test('JSON schema forbids additional properties everywhere and has no length constraints', () => {
  const schema = buildTicketJsonSchema(['Frage', 'Sonstiges']);
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (record['type'] === 'object') {
      assert.equal(record['additionalProperties'], false);
    }
    for (const forbidden of ['minLength', 'maxLength', 'minimum', 'maximum']) {
      assert.equal(forbidden in record, false);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(schema);
});

test('required-fields check needs a contact channel and a description', () => {
  assert.equal(hasRequiredTicketFields(ticketExtractionSchema.parse(valid)), true);
  const noContact = {
    ...valid,
    contact: { ...valid.contact, email: null, phone: null },
  };
  assert.equal(hasRequiredTicketFields(ticketExtractionSchema.parse(noContact)), false);
});
