import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createHubSpotSink, provisionTicketProperties, type HubSpotConfig } from './hubspot.js';
import type { SinkContext } from './sink.js';

const BASE = 'https://hub.test';
const CTX: SinkContext = { correlationId: 'test-correlation' };

interface MockCall {
  method: string;
  url: string;
  /** Deep-equal expectation for the parsed JSON request body; omit to assert no body. */
  body?: unknown;
  status: number;
  response?: unknown;
  responseText?: string;
}

function mockFetch(calls: MockCall[]): { fetchImpl: typeof fetch; assertDone: () => void } {
  let index = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const expected = calls[index];
    assert.ok(
      expected,
      `unexpected request #${index + 1}: ${init?.method ?? 'GET'} ${String(input)}`,
    );
    index += 1;
    assert.equal(init?.method ?? 'GET', expected.method, 'method');
    assert.equal(String(input), expected.url, 'url');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer test-token', 'auth header');
    if (expected.body === undefined) {
      assert.equal(init?.body, undefined, 'request body');
    } else {
      assert.deepEqual(JSON.parse(String(init?.body)), expected.body, 'request body');
    }
    const text =
      expected.responseText ??
      (expected.response === undefined ? '' : JSON.stringify(expected.response));
    return new Response(text, { status: expected.status });
  }) as typeof fetch;
  return {
    fetchImpl,
    assertDone: () => assert.equal(index, calls.length, 'all expected requests made'),
  };
}

function sinkConfig(fetchImpl: typeof fetch): HubSpotConfig {
  return {
    token: 'test-token',
    pipelineId: 'pipe-1',
    stageId: 'stage-1',
    baseUrl: BASE,
    fetchImpl,
    retryDelaysMs: [1, 1],
  };
}

const CONTACT_BY_EMAIL_URL = `${BASE}/crm/v3/objects/contacts/max%40example.com?idProperty=email`;

test('upsertContact returns the existing contact when the email lookup hits', async () => {
  const mock = mockFetch([
    { method: 'GET', url: CONTACT_BY_EMAIL_URL, status: 200, response: { id: '301' } },
  ]);
  const sink = createHubSpotSink(sinkConfig(mock.fetchImpl));
  const result = await sink.upsertContact(
    { name: 'Max Mustermann', email: 'max@example.com', phone: null, company: null },
    CTX,
  );
  assert.deepEqual(result, { sinkContactId: '301' });
  mock.assertDone();
});

test('upsertContact creates the contact when the email lookup 404s', async () => {
  const mock = mockFetch([
    {
      method: 'GET',
      url: CONTACT_BY_EMAIL_URL,
      status: 404,
      responseText: '{"status":"error","category":"OBJECT_NOT_FOUND"}',
    },
    {
      method: 'POST',
      url: `${BASE}/crm/v3/objects/contacts`,
      body: {
        properties: {
          email: 'max@example.com',
          firstname: 'Max',
          lastname: 'von Mustermann',
          company: 'ACME GmbH',
        },
      },
      status: 201,
      response: { id: '302' },
    },
  ]);
  const sink = createHubSpotSink(sinkConfig(mock.fetchImpl));
  const result = await sink.upsertContact(
    { name: 'Max von Mustermann', email: 'max@example.com', phone: null, company: 'ACME GmbH' },
    CTX,
  );
  assert.deepEqual(result, { sinkContactId: '302' });
  mock.assertDone();
});

test('upsertContact falls back to a country-code-stripped phone search', async () => {
  const searchUrl = `${BASE}/crm/v3/objects/contacts/search`;
  const filterFor = (value: string) => ({
    filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value }] }],
  });
  const mock = mockFetch([
    {
      method: 'POST',
      url: searchUrl,
      body: filterFor('+49171234'),
      status: 200,
      response: { total: 0, results: [] },
    },
    {
      method: 'POST',
      url: searchUrl,
      body: filterFor('0171234'),
      status: 200,
      response: { total: 1, results: [{ id: '303' }] },
    },
  ]);
  const sink = createHubSpotSink(sinkConfig(mock.fetchImpl));
  const result = await sink.upsertContact(
    { name: null, email: null, phone: '+49171234', company: null },
    CTX,
  );
  assert.deepEqual(result, { sinkContactId: '303' });
  mock.assertDone();
});

test('requests retry on 429 and succeed on the next attempt', async () => {
  const mock = mockFetch([
    {
      method: 'GET',
      url: CONTACT_BY_EMAIL_URL,
      status: 429,
      responseText: '{"status":"error","policyName":"TEN_SECONDLY_ROLLING"}',
    },
    { method: 'GET', url: CONTACT_BY_EMAIL_URL, status: 200, response: { id: '304' } },
  ]);
  const sink = createHubSpotSink(sinkConfig(mock.fetchImpl));
  const result = await sink.upsertContact(
    { name: null, email: 'max@example.com', phone: null, company: null },
    CTX,
  );
  assert.deepEqual(result, { sinkContactId: '304' });
  mock.assertDone();
});

test('createTicket sends zendori properties and the ticket-to-contact association', async () => {
  const mock = mockFetch([
    {
      method: 'POST',
      url: `${BASE}/crm/v3/objects/tickets`,
      body: {
        properties: {
          subject: 'Heizung ausgefallen',
          content: 'Die Heizung in Gebäude A ist seit heute Morgen ausgefallen.',
          hs_pipeline: 'pipe-1',
          hs_pipeline_stage: 'stage-1',
          hs_ticket_priority: 'MEDIUM',
          zendori_source: 'email',
          zendori_ref: 'ZV1-0042',
        },
        associations: [
          {
            to: { id: '301' },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }],
          },
        ],
      },
      status: 201,
      response: { id: '901' },
    },
  ]);
  const sink = createHubSpotSink(sinkConfig(mock.fetchImpl));
  const result = await sink.createTicket(
    {
      ticketRef: 'ZV1-0042',
      subject: 'Heizung ausgefallen',
      description: 'Die Heizung in Gebäude A ist seit heute Morgen ausgefallen.',
      category: 'Störung',
      priority: 'normal',
      sourceChannel: 'email',
    },
    { sinkContactId: '301' },
    CTX,
  );
  assert.deepEqual(result, { sinkTicketId: '901' });
  mock.assertDone();
});

test('createTicket degrades URGENT to HIGH when the portal rejects the option', async () => {
  const ticketsUrl = `${BASE}/crm/v3/objects/tickets`;
  const payloadFor = (priority: string) => ({
    properties: {
      subject: 'Wasserschaden',
      content: 'Wasser tritt aus.',
      hs_pipeline: 'pipe-1',
      hs_pipeline_stage: 'stage-1',
      hs_ticket_priority: priority,
      zendori_source: 'phone',
      zendori_ref: 'ZV1-0043',
    },
    associations: [
      {
        to: { id: '301' },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }],
      },
    ],
  });
  const mock = mockFetch([
    {
      method: 'POST',
      url: ticketsUrl,
      body: payloadFor('URGENT'),
      status: 400,
      responseText:
        '{"status":"error","message":"URGENT was not one of the allowed options for property hs_ticket_priority"}',
    },
    {
      method: 'POST',
      url: ticketsUrl,
      body: payloadFor('HIGH'),
      status: 201,
      response: { id: '902' },
    },
  ]);
  const sink = createHubSpotSink(sinkConfig(mock.fetchImpl));
  const result = await sink.createTicket(
    {
      ticketRef: 'ZV1-0043',
      subject: 'Wasserschaden',
      description: 'Wasser tritt aus.',
      category: 'Störung',
      priority: 'urgent',
      sourceChannel: 'phone',
    },
    { sinkContactId: '301' },
    CTX,
  );
  assert.deepEqual(result, { sinkTicketId: '902' });
  mock.assertDone();
});

test('findTicketByRef returns null on 404', async () => {
  const mock = mockFetch([
    {
      method: 'GET',
      url: `${BASE}/crm/v3/objects/tickets/ZV1-0099?idProperty=zendori_ref`,
      status: 404,
      responseText: '{"status":"error","category":"OBJECT_NOT_FOUND"}',
    },
  ]);
  const sink = createHubSpotSink(sinkConfig(mock.fetchImpl));
  assert.equal(await sink.findTicketByRef('ZV1-0099', CTX), null);
  mock.assertDone();
});

test('attachNote truncates the note body to 65536 chars', async () => {
  const longBody = 'x'.repeat(70000);
  const expectedNoteBody = `${longBody}\n\n— Quelle: Kanal whatsapp`.slice(0, 65536);
  assert.equal(expectedNoteBody.length, 65536);
  const mock = mockFetch([
    {
      method: 'POST',
      url: `${BASE}/crm/v3/objects/notes`,
      body: {
        properties: {
          hs_timestamp: '2026-07-09T10:00:00.000Z',
          hs_note_body: expectedNoteBody,
        },
        associations: [
          {
            to: { id: '901' },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 228 }],
          },
        ],
      },
      status: 201,
      response: { id: 'note-1' },
    },
  ]);
  const sink = createHubSpotSink(sinkConfig(mock.fetchImpl));
  await sink.attachNote(
    { sinkTicketId: '901' },
    { body: longBody, sourceChannel: 'whatsapp', occurredAt: '2026-07-09T10:00:00.000Z' },
    CTX,
  );
  mock.assertDone();
});

test('provisionTicketProperties creates only the missing property', async () => {
  const mock = mockFetch([
    {
      method: 'GET',
      url: `${BASE}/crm/v3/properties/tickets/zendori_ref`,
      status: 404,
      responseText: '{"status":"error","category":"OBJECT_NOT_FOUND"}',
    },
    {
      method: 'POST',
      url: `${BASE}/crm/v3/properties/tickets`,
      body: {
        name: 'zendori_ref',
        label: 'Zendori Referenz',
        type: 'string',
        fieldType: 'text',
        groupName: 'ticketinformation',
        hasUniqueValue: true,
      },
      status: 201,
      response: { name: 'zendori_ref' },
    },
    {
      method: 'GET',
      url: `${BASE}/crm/v3/properties/tickets/zendori_source`,
      status: 200,
      response: { name: 'zendori_source' },
    },
  ]);
  const result = await provisionTicketProperties({
    token: 'test-token',
    baseUrl: BASE,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { created: ['zendori_ref'], existing: ['zendori_source'] });
  mock.assertDone();
});
