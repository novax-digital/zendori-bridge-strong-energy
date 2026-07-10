'use server';

import Anthropic from '@anthropic-ai/sdk';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  extractTicket,
  hasRequiredTicketFields,
  loadServerEnv,
  TICKET_PRIORITIES,
  type ExtractionRun,
  type TicketExtraction,
} from '@zendori/core';

import {
  audit,
  getAppSettings,
  getMessage,
  insertInboundMessage,
  setMessageStatus,
} from '@/lib/db';
import { enqueueJob, kickJobRunnerAfterResponse } from '@/lib/jobs/enqueue';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

/** Session check for dashboard actions; writes below use the admin client. */
async function requireUserId(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    redirect('/login');
  }
  return data.claims.sub;
}

function readString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Paste inbox step 1 (§10.3): persist the pasted text as an inbound message
 * and run the extraction synchronously so the preview can render immediately.
 * The regular pipeline continues from `contact_upsert` after the user
 * confirms the draft (createTicketFromPaste).
 */
export async function analysePaste(formData: FormData): Promise<void> {
  await requireUserId();

  const text = readString(formData, 'text');
  const kontext = readString(formData, 'kontext');
  if (!text) {
    redirect('/paste?fehler=eingabe');
  }

  const admin = createAdminClient();
  // Contact data is pulled from the pasted text DETERMINISTICALLY (regex) so
  // the AI call can run fully redacted (PII stays local).
  const detected = detectContactInText(text);
  const result = await insertInboundMessage(
    {
      channel: 'paste',
      externalId: crypto.randomUUID(),
      senderEmail: detected.email,
      senderPhone: detected.phone,
      bodyText: text,
      raw: { context_note: kontext || null },
      receivedAt: new Date().toISOString(),
    },
    admin,
  );
  if (!result.inserted) {
    // Unreachable with a fresh UUID as external_id; narrows the union.
    throw new Error('paste insert unexpectedly reported a duplicate');
  }
  const message = result.message;

  let run: ExtractionRun | null = null;
  try {
    const env = loadServerEnv();
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    const settings = await getAppSettings(admin);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    run = await extractTicket(
      client,
      {
        channel: message.channel,
        senderName: null,
        senderEmail: null,
        senderPhone: null,
        subject: null,
        bodyText: text,
        receivedAt: message.received_at,
        contextNote: kontext || null,
      },
      {
        categories: settings.ticket_categories,
        escalationThreshold: settings.extraction_escalation_threshold,
        modelExtract: env.ANTHROPIC_MODEL_EXTRACT,
        modelEscalation: env.ANTHROPIC_MODEL_ESCALATION,
      },
    );
  } catch {
    run = null;
  }
  if (!run) {
    // The preview page falls back to the raw text; the message stays `received`.
    redirect(`/paste?msg=${message.id}&fehler=extraktion`);
  }

  const { error } = await admin.from('extractions').insert({
    message_id: message.id,
    model: run.model,
    schema_version: '1',
    data: run.data,
    confidence: run.data.extraction.confidence,
    missing_fields: run.data.extraction.missing_fields,
    questions: run.data.extraction.questions,
    tokens_in: run.tokensIn,
    tokens_out: run.tokensOut,
  });
  if (error) {
    throw new Error(`storing paste extraction failed: ${error.message}`);
  }

  const needsInfo =
    !hasRequiredTicketFields(run.data) || run.data.extraction.missing_fields.length > 0;
  await setMessageStatus(message.id, needsInfo ? 'needs_info' : 'extracted', null, admin);

  redirect(`/paste?msg=${message.id}`);
}

const editedFieldsSchema = z.object({
  subject: z.string().min(1).max(80),
  description: z.string().min(1).max(20_000),
  category: z.string().min(1).max(100),
  priority: z.enum(TICKET_PRIORITIES),
  email: z.literal('').or(z.email().max(320)),
  phone: z.string().max(50),
  name: z.string().max(200),
  company: z.string().max(200),
});

/**
 * Paste inbox step 2 (§10.3): store the operator-edited draft as a new
 * extraction (model `paste-edited`, confidence 1) and hand the message to the
 * regular pipeline at `contact_upsert`.
 */
export async function createTicketFromPaste(formData: FormData): Promise<void> {
  const actorId = await requireUserId();

  const messageId = readString(formData, 'messageId');
  if (!z.uuid().safeParse(messageId).success) {
    redirect('/paste');
  }

  const parsed = editedFieldsSchema.safeParse({
    subject: readString(formData, 'subject'),
    description: readString(formData, 'description'),
    category: readString(formData, 'category'),
    priority: readString(formData, 'priority'),
    email: readString(formData, 'email'),
    phone: readString(formData, 'phone'),
    name: readString(formData, 'name'),
    company: readString(formData, 'company'),
  });
  if (!parsed.success) {
    redirect(`/paste?msg=${messageId}&fehler=eingabe`);
  }
  const fields = parsed.data;
  if (!fields.email && !fields.phone) {
    redirect(`/paste?msg=${messageId}&fehler=kontakt`);
  }

  // Double-submit guard: once a ticket (or a running pipeline) exists for
  // this paste message, a second click must not start a parallel chain.
  const admin = createAdminClient();
  const existingMessage = await getMessage(messageId, admin);
  if (['ticket_created', 'attached_to_existing', 'spam'].includes(existingMessage.status)) {
    redirect(`/nachricht/${messageId}`);
  }

  const message = existingMessage;
  if (message.channel !== 'paste') {
    throw new Error('createTicketFromPaste only accepts paste messages');
  }

  const { data: previousRow, error: previousError } = await admin
    .from('extractions')
    .select('data')
    .eq('message_id', messageId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previousError) {
    throw new Error(`loading previous extraction failed: ${previousError.message}`);
  }
  const previous = previousRow ? (previousRow.data as TicketExtraction) : null;

  const data: TicketExtraction = {
    contact: {
      name: fields.name || null,
      email: fields.email || null,
      phone: fields.phone || null,
      company: fields.company || null,
    },
    ticket: {
      subject: fields.subject,
      description: fields.description,
      category: fields.category,
      priority: fields.priority,
      priority_reason: 'Manuell im Paste-Editor festgelegt.',
      language: previous?.ticket.language ?? 'de',
    },
    meta: previous?.meta ?? { is_spam: false, is_auto_reply: false, summary: fields.subject },
    extraction: { confidence: 1, missing_fields: [], questions: [] },
  };

  const { error } = await admin.from('extractions').insert({
    message_id: messageId,
    model: 'paste-edited',
    schema_version: '1',
    data,
    confidence: 1,
    missing_fields: [],
    questions: [],
  });
  if (error) {
    throw new Error(`storing edited extraction failed: ${error.message}`);
  }

  await setMessageStatus(messageId, 'extracted', null, admin);
  await enqueueJob('contact_upsert', messageId, message.correlation_id, admin);
  kickJobRunnerAfterResponse();

  await audit(
    {
      actorType: 'user',
      actorId,
      action: 'paste_ticket_submitted',
      entity: 'inbound_message',
      entityId: messageId,
      payload: { category: fields.category, priority: fields.priority },
    },
    admin,
  );

  redirect(`/nachricht/${messageId}`);
}

/** Discard a paste draft: the message is kept for audit but parked as spam. */
export async function discardPaste(formData: FormData): Promise<void> {
  const actorId = await requireUserId();

  const messageId = readString(formData, 'messageId');
  if (!z.uuid().safeParse(messageId).success) {
    redirect('/paste');
  }

  const admin = createAdminClient();
  await setMessageStatus(messageId, 'spam', null, admin);
  await audit(
    {
      actorType: 'user',
      actorId,
      action: 'paste_discarded',
      entity: 'inbound_message',
      entityId: messageId,
    },
    admin,
  );

  redirect('/paste');
}

/** First e-mail address / phone-looking number in the pasted text (German formats). */
function detectContactInText(text: string): { email: string | null; phone: string | null } {
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
  const phoneMatch = text.match(/(?:\+|0)[\d\s\-/().]{5,20}\d/);
  const phone =
    phoneMatch && phoneMatch[0].replace(/\D/g, '').length >= 7 ? phoneMatch[0].trim() : null;
  return { email, phone };
}
