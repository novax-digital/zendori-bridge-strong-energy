import type {
  ContactInput,
  NoteInput,
  SinkContactRef,
  SinkHealth,
  SinkTicketRef,
  TicketDraft,
  TicketSink,
} from './sink.js';

/**
 * HubSpot TicketSink (CLAUDE.md §9) on plain fetch — no SDK dependency.
 * Endpoint/scope/typeId facts verified in docs/stack-verifikation-2026-07-09.md.
 */

export interface HubSpotConfig {
  token: string;
  pipelineId: string;
  stageId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string }>;
}

interface ConnectionConfig {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
}

const DEFAULT_BASE_URL = 'https://api.hubapi.com';
const DEFAULT_RETRY_DELAYS_MS = [2000, 8000];
/** hs_note_body hard limit documented by HubSpot. */
const NOTE_BODY_MAX_CHARS = 65536;

/** Associations v4 HUBSPOT_DEFINED type IDs (verified constants). */
const TICKET_TO_CONTACT_TYPE_ID = 16;
const NOTE_TO_TICKET_TYPE_ID = 228;

const ACCOUNT_INFO_PATH = '/account-info/v3/details';
const TICKET_PIPELINES_PATH = '/crm/v3/pipelines/tickets';
const CONTACTS_PATH = '/crm/v3/objects/contacts';
const CONTACT_SEARCH_PATH = '/crm/v3/objects/contacts/search';
const TICKETS_PATH = '/crm/v3/objects/tickets';
const TICKET_SEARCH_PATH = '/crm/v3/objects/tickets/search';
const TICKET_PROPERTIES_PATH = '/crm/v3/properties/tickets';
const NOTES_PATH = '/crm/v3/objects/notes';

const PRIORITY_MAP: Record<TicketDraft['priority'], 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'> = {
  low: 'LOW',
  normal: 'MEDIUM',
  high: 'HIGH',
  urgent: 'URGENT',
};

interface HubSpotResponse {
  status: number;
  bodyText: string;
  json: unknown;
}

interface ObjectResponse {
  id: string;
}

interface SearchResponse {
  total: number;
  results: Array<{ id: string }>;
}

function bodySnippet(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function requestFailed(method: string, path: string, response: HubSpotResponse): Error {
  return new Error(
    `HubSpot ${method} ${path} failed with status ${response.status}: ${bodySnippet(response.bodyText)}`,
  );
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Central request helper: Bearer auth, JSON, retry on 429/5xx with fixed backoff
 * (HubSpot sends no Retry-After header). The token never appears in errors or logs.
 */
async function request(
  config: ConnectionConfig,
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
): Promise<HubSpotResponse> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const retryDelaysMs = config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const bodyText = await response.text();
    if (response.status === 429 || response.status >= 500) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined) {
        throw new Error(
          `HubSpot ${method} ${path} failed after ${attempt + 1} attempts with status ${response.status}: ${bodySnippet(bodyText)}`,
        );
      }
      await sleep(delayMs);
      continue;
    }
    let json: unknown = null;
    if (bodyText !== '') {
      try {
        json = JSON.parse(bodyText);
      } catch {
        json = null;
      }
    }
    return { status: response.status, bodyText, json };
  }
}

/**
 * HubSpot indexes phone numbers without the country code (+49171234 matches as 0171234),
 * so a search miss on the raw number retries with the country code replaced by a leading 0.
 * Boundary heuristic: +1/+7 are one-digit codes, everything else is treated as two digits —
 * sufficient for the European numbers this bridge handles.
 */
function stripCountryCode(phone: string): string {
  return phone.replace(/^\+(1|7|\d\d)/, '0');
}

function contactProperties(contact: ContactInput): Record<string, string> {
  const properties: Record<string, string> = {};
  if (contact.email) {
    properties.email = contact.email;
  }
  const name = contact.name?.trim();
  if (name) {
    const [firstname, ...rest] = name.split(/\s+/);
    if (firstname) {
      properties.firstname = firstname;
    }
    if (rest.length > 0) {
      properties.lastname = rest.join(' ');
    }
  }
  if (contact.phone) {
    properties.phone = contact.phone;
  }
  if (contact.company) {
    properties.company = contact.company;
  }
  return properties;
}

function contactByEmailPath(email: string): string {
  return `${CONTACTS_PATH}/${encodeURIComponent(email)}?idProperty=email`;
}

async function getContactByEmail(
  config: ConnectionConfig,
  email: string,
): Promise<SinkContactRef | null> {
  const path = contactByEmailPath(email);
  const response = await request(config, 'GET', path);
  if (response.status === 200) {
    return { sinkContactId: (response.json as ObjectResponse).id };
  }
  if (response.status === 404) {
    return null;
  }
  throw requestFailed('GET', path, response);
}

async function searchContactByPhone(
  config: ConnectionConfig,
  phone: string,
): Promise<SinkContactRef | null> {
  const response = await request(config, 'POST', CONTACT_SEARCH_PATH, {
    filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
  });
  if (response.status !== 200) {
    throw requestFailed('POST', CONTACT_SEARCH_PATH, response);
  }
  const body = response.json as SearchResponse;
  const first = body.results[0];
  return body.total > 0 && first ? { sinkContactId: first.id } : null;
}

async function createContact(
  config: ConnectionConfig,
  contact: ContactInput,
): Promise<HubSpotResponse> {
  return request(config, 'POST', CONTACTS_PATH, { properties: contactProperties(contact) });
}

async function upsertHubSpotContact(
  config: ConnectionConfig,
  contact: ContactInput,
): Promise<SinkContactRef> {
  if (contact.email) {
    const existing = await getContactByEmail(config, contact.email);
    if (existing) {
      return existing;
    }
    const created = await createContact(config, contact);
    if (created.status === 409) {
      // Create race: another writer inserted the contact between our GET and POST.
      const conflicting = await getContactByEmail(config, contact.email);
      if (conflicting) {
        return conflicting;
      }
      throw requestFailed('POST', CONTACTS_PATH, created);
    }
    if (!isSuccess(created.status)) {
      throw requestFailed('POST', CONTACTS_PATH, created);
    }
    return { sinkContactId: (created.json as ObjectResponse).id };
  }
  if (contact.phone) {
    const found = await searchContactByPhone(config, contact.phone);
    if (found) {
      return found;
    }
    const normalized = stripCountryCode(contact.phone);
    if (normalized !== contact.phone) {
      const fallback = await searchContactByPhone(config, normalized);
      if (fallback) {
        return fallback;
      }
    }
    const created = await createContact(config, contact);
    if (!isSuccess(created.status)) {
      throw requestFailed('POST', CONTACTS_PATH, created);
    }
    return { sinkContactId: (created.json as ObjectResponse).id };
  }
  throw new Error('Contact has neither email nor phone — cannot upsert into HubSpot');
}

async function createHubSpotTicket(
  config: HubSpotConfig,
  draft: TicketDraft,
  contact: SinkContactRef,
): Promise<SinkTicketRef> {
  const buildPayload = (priority: string) => ({
    properties: {
      subject: draft.subject,
      content: draft.description,
      hs_pipeline: config.pipelineId,
      hs_pipeline_stage: config.stageId,
      hs_ticket_priority: priority,
      zendori_source: draft.sourceChannel,
      zendori_ref: draft.ticketRef,
    },
    associations: [
      {
        to: { id: contact.sinkContactId },
        types: [
          { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TICKET_TO_CONTACT_TYPE_ID },
        ],
      },
    ],
  });
  const priority = PRIORITY_MAP[draft.priority];
  let response = await request(config, 'POST', TICKETS_PATH, buildPayload(priority));
  if (response.status === 400 && priority !== 'HIGH' && /priority/i.test(response.bodyText)) {
    // Some portals lack the URGENT option on hs_ticket_priority — degrade once to HIGH.
    response = await request(config, 'POST', TICKETS_PATH, buildPayload('HIGH'));
  }
  if (!isSuccess(response.status)) {
    throw requestFailed('POST', TICKETS_PATH, response);
  }
  return { sinkTicketId: (response.json as ObjectResponse).id };
}

async function findHubSpotTicketByRef(
  config: ConnectionConfig,
  ticketRef: string,
): Promise<SinkTicketRef | null> {
  const path = `${TICKETS_PATH}/${encodeURIComponent(ticketRef)}?idProperty=zendori_ref`;
  const response = await request(config, 'GET', path);
  if (response.status === 200) {
    return { sinkTicketId: (response.json as ObjectResponse).id };
  }
  if (response.status === 404) {
    return null;
  }
  if (response.status === 400) {
    // idProperty lookup requires zendori_ref with hasUniqueValue — fall back to search.
    const search = await request(config, 'POST', TICKET_SEARCH_PATH, {
      filterGroups: [
        { filters: [{ propertyName: 'zendori_ref', operator: 'EQ', value: ticketRef }] },
      ],
    });
    if (search.status !== 200) {
      throw requestFailed('POST', TICKET_SEARCH_PATH, search);
    }
    const first = (search.json as SearchResponse).results[0];
    return first ? { sinkTicketId: first.id } : null;
  }
  throw requestFailed('GET', path, response);
}

async function attachHubSpotNote(
  config: ConnectionConfig,
  ticket: SinkTicketRef,
  note: NoteInput,
): Promise<void> {
  const body = `${note.body}\n\n— Quelle: Kanal ${note.sourceChannel}`.slice(
    0,
    NOTE_BODY_MAX_CHARS,
  );
  const response = await request(config, 'POST', NOTES_PATH, {
    properties: { hs_timestamp: note.occurredAt, hs_note_body: body },
    associations: [
      {
        to: { id: ticket.sinkTicketId },
        types: [
          { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_TICKET_TYPE_ID },
        ],
      },
    ],
  });
  if (!isSuccess(response.status)) {
    throw requestFailed('POST', NOTES_PATH, response);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkConnection(config: ConnectionConfig): Promise<SinkHealth> {
  let account: HubSpotResponse;
  try {
    account = await request(config, 'GET', ACCOUNT_INFO_PATH);
  } catch (error) {
    return { ok: false, detail: `Account-Info nicht erreichbar: ${errorMessage(error)}` };
  }
  if (account.status !== 200) {
    const detail =
      account.status === 401
        ? 'Token ungültig (401 bei Account-Info).'
        : account.status === 403
          ? 'Token ohne Berechtigung für Account-Info (403) — Scopes der Private App prüfen.'
          : `Account-Info fehlgeschlagen (Status ${account.status}).`;
    return { ok: false, detail };
  }
  let pipelines: HubSpotResponse;
  try {
    pipelines = await request(config, 'GET', TICKET_PIPELINES_PATH);
  } catch (error) {
    return { ok: false, detail: `Ticket-Pipelines nicht erreichbar: ${errorMessage(error)}` };
  }
  if (pipelines.status !== 200) {
    const detail =
      pipelines.status === 403
        ? 'Ticket-Pipelines nicht abrufbar (403) — fehlt der Scope "tickets"?'
        : `Ticket-Pipelines nicht abrufbar (Status ${pipelines.status}).`;
    return { ok: false, detail };
  }

  // Without the custom properties every deliver job dies with a 400 — an
  // all-green connection check would be lying.
  const missingProperties: string[] = [];
  for (const property of ['zendori_ref', 'zendori_source']) {
    try {
      const propertyRes = await request(config, 'GET', `${TICKET_PROPERTIES_PATH}/${property}`);
      if (propertyRes.status === 404) {
        missingProperties.push(property);
      } else if (!isSuccess(propertyRes.status)) {
        return {
          ok: false,
          detail: `Custom Property "${property}" nicht prüfbar (Status ${propertyRes.status}).`,
        };
      }
    } catch (error) {
      return { ok: false, detail: `Custom Properties nicht prüfbar: ${errorMessage(error)}` };
    }
  }
  if (missingProperties.length > 0) {
    return {
      ok: false,
      detail: `Token gültig, aber Custom Properties fehlen: ${missingProperties.join(', ')} — in den Einstellungen „Custom Properties anlegen" ausführen.`,
    };
  }

  return { ok: true, detail: 'Token gültig, Pipelines erreichbar, Custom Properties vorhanden.' };
}

export function createHubSpotSink(config: HubSpotConfig): TicketSink {
  return {
    upsertContact: (contact) => upsertHubSpotContact(config, contact),
    createTicket: (draft, contact) => createHubSpotTicket(config, draft, contact),
    attachNote: (ticket, note) => attachHubSpotNote(config, ticket, note),
    findTicketByRef: (ticketRef) => findHubSpotTicketByRef(config, ticketRef),
    healthCheck: () => checkConnection(config),
  };
}

export async function listTicketPipelines(config: {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<HubSpotPipeline[]> {
  const response = await request(config, 'GET', TICKET_PIPELINES_PATH);
  if (response.status !== 200) {
    throw requestFailed('GET', TICKET_PIPELINES_PATH, response);
  }
  const body = response.json as {
    results: Array<{ id: string; label: string; stages: Array<{ id: string; label: string }> }>;
  };
  // Stages arrive sorted by displayOrder (verified) — mapped 1:1.
  return body.results.map((pipeline) => ({
    id: pipeline.id,
    label: pipeline.label,
    stages: pipeline.stages.map((stage) => ({ id: stage.id, label: stage.label })),
  }));
}

export async function testHubSpotConnection(config: {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<SinkHealth> {
  return checkConnection(config);
}

const TICKET_PROPERTY_DEFINITIONS = [
  { name: 'zendori_ref', label: 'Zendori Referenz', hasUniqueValue: true },
  { name: 'zendori_source', label: 'Zendori Quelle', hasUniqueValue: false },
] as const;

export async function provisionTicketProperties(config: {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const definition of TICKET_PROPERTY_DEFINITIONS) {
    const path = `${TICKET_PROPERTIES_PATH}/${definition.name}`;
    const lookup = await request(config, 'GET', path);
    if (lookup.status === 200) {
      existing.push(definition.name);
      continue;
    }
    if (lookup.status !== 404) {
      throw requestFailed('GET', path, lookup);
    }
    const create = await request(config, 'POST', TICKET_PROPERTIES_PATH, {
      name: definition.name,
      label: definition.label,
      type: 'string',
      fieldType: 'text',
      groupName: 'ticketinformation',
      ...(definition.hasUniqueValue ? { hasUniqueValue: true } : {}),
    });
    if (!isSuccess(create.status)) {
      throw requestFailed('POST', TICKET_PROPERTIES_PATH, create);
    }
    created.push(definition.name);
  }
  return { created, existing };
}
