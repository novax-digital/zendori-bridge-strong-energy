import Anthropic from '@anthropic-ai/sdk';
import {
  createHubSpotSink,
  createLogger,
  extractTicket,
  hasRequiredTicketFields,
  loadServerEnv,
  stripReplyText,
  withCorrelation,
  type JobRecord,
  type PipelineStep,
  type SinkContactRef,
  type TicketExtraction,
  type TicketSink,
} from '@zendori/core';

import {
  audit,
  getAppSettings,
  getMessage,
  setMessageStatus,
  type AppSettings,
  type InboundMessageRow,
} from '@/lib/db';
import { getMailbox } from '@/lib/db/mailboxes';
import { enqueueJob } from '@/lib/jobs/enqueue';
import { sendAutoReply } from '@/lib/mail/send';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * The five pipeline steps (CLAUDE.md §5). Each is idempotent and throws on
 * failure — the job runner handles retry/backoff/dead. Every step loads its
 * state from the DB by messageId; job payloads carry no data.
 */

const log = createLogger({ name: 'pipeline' });

export const STEP_HANDLERS: Record<PipelineStep, (job: JobRecord) => Promise<void>> = {
  extract: withSpamGuard(stepExtract),
  contact_upsert: withSpamGuard(stepContactUpsert),
  dedup_check: withSpamGuard(stepDedupCheck),
  deliver: withSpamGuard(stepDeliver),
  confirm: withSpamGuard(stepConfirm),
};

/**
 * An operator's spam verdict is authoritative: in-flight jobs of an already
 * marked message become no-ops instead of creating tickets/auto-replies.
 */
function withSpamGuard(
  handler: (job: JobRecord) => Promise<void>,
): (job: JobRecord) => Promise<void> {
  return async (job) => {
    const message = await getMessage(job.message_id, createAdminClient());
    if (message.status === 'spam') {
      withCorrelation(log, job.correlation_id).info(
        { messageId: job.message_id, step: job.step },
        'message marked as spam — skipping pipeline step',
      );
      return;
    }
    await handler(job);
  };
}

// ---------------------------------------------------------------------------
// Step 2 — AI extraction
// ---------------------------------------------------------------------------
async function stepExtract(job: JobRecord): Promise<void> {
  const supabase = createAdminClient();
  const jobLog = withCorrelation(log, job.correlation_id);
  const message = await getMessage(job.message_id, supabase);
  const settings = await getAppSettings(supabase);
  const env = loadServerEnv();

  const rawBody = message.body_text ?? message.subject ?? '';
  const bodyText = message.channel === 'email' ? stripReplyText(rawBody) : rawBody;
  const contextNote = message.channel === 'paste' ? readPasteContext(message.raw) : null;

  let run;
  try {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    run = await extractTicket(
      client,
      {
        channel: message.channel,
        senderName: message.sender_name,
        senderEmail: message.sender_email,
        senderPhone: message.sender_phone,
        subject: message.subject,
        bodyText,
        receivedAt: message.received_at,
        contextNote,
      },
      {
        categories: settings.ticket_categories,
        escalationThreshold: settings.extraction_escalation_threshold,
        modelExtract: env.ANTHROPIC_MODEL_EXTRACT,
        modelEscalation: env.ANTHROPIC_MODEL_ESCALATION,
      },
    );
  } catch (error) {
    // §7: an AI outage must never block forwarding. On the FINAL attempt we
    // fall back to a raw-data extraction flagged ai_skipped and continue.
    if (job.attempts < job.max_attempts) throw error;
    jobLog.warn(
      { messageId: message.id, err: error instanceof Error ? error.message : String(error) },
      'extraction failed on final attempt — continuing with ai_skipped fallback',
    );
    run = {
      data: buildAiSkippedExtraction(message, bodyText, settings),
      model: 'ai_skipped',
      tokensIn: 0,
      tokensOut: 0,
      escalated: false,
    };
  }

  const { error: insertError } = await supabase.from('extractions').insert({
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
  if (insertError) throw new Error(`storing extraction failed: ${insertError.message}`);

  const headerAutoSubmitted = readAutoSubmittedFlag(message.raw);
  if (run.data.meta.is_spam || run.data.meta.is_auto_reply || headerAutoSubmitted) {
    await setMessageStatus(message.id, 'spam', null, supabase);
    jobLog.info(
      {
        messageId: message.id,
        isSpam: run.data.meta.is_spam,
        isAutoReply: run.data.meta.is_auto_reply || headerAutoSubmitted,
      },
      'message classified as spam/auto-reply — no ticket',
    );
    return;
  }

  if (!hasRequiredTicketFields(run.data) || run.data.extraction.missing_fields.length > 0) {
    await setMessageStatus(message.id, 'needs_info', null, supabase);
    jobLog.info(
      { messageId: message.id, missing: run.data.extraction.missing_fields },
      'required fields missing — message parked as needs_info',
    );
    return;
  }

  await setMessageStatus(message.id, 'extracted', null, supabase);
  await enqueueJob('contact_upsert', message.id, job.correlation_id, supabase);
}

// ---------------------------------------------------------------------------
// Step 3 — contact upsert (sink + local cache)
// ---------------------------------------------------------------------------
async function stepContactUpsert(job: JobRecord): Promise<void> {
  const supabase = createAdminClient();
  const message = await getMessage(job.message_id, supabase);
  const extraction = await getLatestExtraction(job.message_id);

  const email = normalizeEmail(extraction.contact.email ?? message.sender_email);
  const phone = extraction.contact.phone ?? message.sender_phone;
  if (!email && !phone) {
    throw new Error('contact_upsert reached without any contact channel');
  }

  const cached = await findCachedContact(email, phone);
  if (!cached) {
    const sink = await getSink();
    const contactRef = await sink.upsertContact(
      {
        name: extraction.contact.name ?? message.sender_name,
        email,
        phone,
        company: extraction.contact.company,
      },
      { correlationId: job.correlation_id },
    );
    const { error } = await supabase.from('contacts_cache').upsert(
      {
        email,
        phone,
        hubspot_contact_id: contactRef.sinkContactId,
        name: extraction.contact.name ?? message.sender_name,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: email ? 'email' : 'phone' },
    );
    if (error) {
      if (error.code !== '23505') {
        throw new Error(`contacts_cache upsert failed: ${error.message}`);
      }
      // The upsert can violate the OTHER unique column: a new email whose
      // phone already belongs to a different cached contact (shared office
      // number). Cache by email only so the deliver lookup (email-first)
      // resolves; a phone-only conflict means the row already exists.
      if (email) {
        const retry = await supabase.from('contacts_cache').upsert(
          {
            email,
            phone: null,
            hubspot_contact_id: contactRef.sinkContactId,
            name: extraction.contact.name ?? message.sender_name,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'email' },
        );
        if (retry.error) {
          throw new Error(`contacts_cache email-only upsert failed: ${retry.error.message}`);
        }
      }
    }
  }

  await enqueueJob('dedup_check', message.id, job.correlation_id, supabase);
}

// ---------------------------------------------------------------------------
// Step 4 — dedup check (Phase 1: pass-through; engine lands in Phase 1.5)
// ---------------------------------------------------------------------------
async function stepDedupCheck(job: JobRecord): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from('dedup_decisions').insert({
    message_id: job.message_id,
    candidate_ticket_ids: [],
    decision: 'new',
    confidence: 1,
    reason: 'Phase 1: Pass-through — Dedup-Engine folgt in Phase 1.5',
    model: null,
  });
  if (error) throw new Error(`dedup decision insert failed: ${error.message}`);
  await enqueueJob('deliver', job.message_id, job.correlation_id, supabase);
}

// ---------------------------------------------------------------------------
// Step 5 — deliver (create ticket in the sink; idempotent via local mirror)
// ---------------------------------------------------------------------------
async function stepDeliver(job: JobRecord): Promise<void> {
  const supabase = createAdminClient();
  const jobLog = withCorrelation(log, job.correlation_id);
  const message = await getMessage(job.message_id, supabase);
  const extraction = await getLatestExtraction(job.message_id);

  // Local mirror row is the idempotency anchor (unique index on
  // first_message_id — a concurrent deliver loses the insert race and
  // continues with the winner's row).
  let ticket = await findTicketByMessage(job.message_id);
  if (!ticket) {
    const { data, error } = await supabase
      .from('tickets')
      .insert({
        subject: extraction.ticket.subject,
        description: extraction.ticket.description,
        category: extraction.ticket.category,
        priority: extraction.ticket.priority,
        source_channel: message.channel,
        first_message_id: message.id,
      })
      .select()
      .single();
    if (error) {
      if (error.code === '23505') {
        ticket = await findTicketByMessage(job.message_id);
      }
      if (!ticket) throw new Error(`ticket mirror insert failed: ${error.message}`);
    } else {
      ticket = data as TicketRow;
    }
  }

  if (!ticket.hubspot_ticket_id) {
    const sink = await getSink();
    const email = normalizeEmail(extraction.contact.email ?? message.sender_email);
    const phone = extraction.contact.phone ?? message.sender_phone;
    const cached = await findCachedContact(email, phone);
    if (!cached) throw new Error('contact missing from cache — contact_upsert did not run?');
    const contactRef: SinkContactRef = { sinkContactId: cached.hubspot_contact_id };

    const existing = await sink.findTicketByRef(ticket.ticket_ref, {
      correlationId: job.correlation_id,
    });
    const sinkTicket =
      existing ??
      (await sink.createTicket(
        {
          ticketRef: ticket.ticket_ref,
          subject: extraction.ticket.subject,
          description: buildTicketContent(extraction, message),
          category: extraction.ticket.category,
          priority: extraction.ticket.priority,
          sourceChannel: message.channel,
        },
        contactRef,
        { correlationId: job.correlation_id },
      ));

    const { error } = await supabase
      .from('tickets')
      .update({
        hubspot_ticket_id: sinkTicket.sinkTicketId,
        hubspot_contact_id: cached.hubspot_contact_id,
      })
      .eq('id', ticket.id);
    if (error) throw new Error(`ticket mirror update failed: ${error.message}`);
  }

  await setMessageStatus(message.id, 'ticket_created', null, supabase);
  await audit(
    {
      actorType: 'system',
      action: 'ticket_created',
      entity: 'ticket',
      entityId: ticket.ticket_ref,
      payload: { messageId: message.id, channel: message.channel },
    },
    supabase,
  );
  jobLog.info({ ticketRef: ticket.ticket_ref, messageId: message.id }, 'ticket delivered to sink');
  await enqueueJob('confirm', message.id, job.correlation_id, supabase);
}

// ---------------------------------------------------------------------------
// Step 6 — confirm (channel-specific; Phase 1: e-mail auto-reply)
// ---------------------------------------------------------------------------
async function stepConfirm(job: JobRecord): Promise<void> {
  const supabase = createAdminClient();
  const message = await getMessage(job.message_id, supabase);
  if (message.channel !== 'email') return;

  if (readAutoSubmittedFlag(message.raw)) return; // loop protection (§10.2)
  if (!message.sender_email) return;

  const ticket = await findTicketByMessage(message.id);
  if (!ticket) throw new Error('confirm reached without a ticket row');

  const mailboxId = readMailboxId(message.raw);
  if (!mailboxId) return;

  const mailbox = await getMailbox(mailboxId, supabase);
  // Never reply to the mailbox's own address (self-loop, §10.2).
  if (
    !mailbox ||
    mailbox.username.trim().toLowerCase() === message.sender_email.trim().toLowerCase()
  ) {
    return;
  }

  // Idempotency: the runner delivers at-least-once — never send the
  // confirmation twice. The audit row written right after sending is the
  // sent-marker (worst case on a crash in between: exactly one duplicate).
  const { data: alreadySent, error: auditError } = await supabase
    .from('audit_log')
    .select('id')
    .eq('action', 'auto_reply_sent')
    .eq('entity', 'inbound_message')
    .eq('entity_id', message.id)
    .limit(1)
    .maybeSingle();
  if (auditError) throw new Error(`auto-reply idempotency check failed: ${auditError.message}`);
  if (alreadySent) return;

  const settings = await getAppSettings(supabase);
  await sendAutoReply({
    mailboxId,
    to: message.sender_email,
    template: settings.auto_reply_template,
    ticketRef: ticket.ticket_ref,
    inReplyTo: message.external_id,
  });
  await audit(
    {
      actorType: 'system',
      action: 'auto_reply_sent',
      entity: 'inbound_message',
      entityId: message.id,
      payload: { ticketRef: ticket.ticket_ref },
    },
    supabase,
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface TicketRow {
  id: string;
  ticket_ref: string;
  hubspot_ticket_id: string | null;
  hubspot_contact_id: string | null;
}

async function findTicketByMessage(messageId: string): Promise<TicketRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('tickets')
    .select('id, ticket_ref, hubspot_ticket_id, hubspot_contact_id')
    .eq('first_message_id', messageId)
    .maybeSingle();
  if (error) throw new Error(`ticket lookup failed: ${error.message}`);
  return (data as TicketRow) ?? null;
}

async function getLatestExtraction(messageId: string): Promise<TicketExtraction> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('extractions')
    .select('data')
    .eq('message_id', messageId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`extraction lookup failed: ${error.message}`);
  if (!data) throw new Error('no extraction found for message');
  return data.data as TicketExtraction;
}

async function findCachedContact(
  email: string | null,
  phone: string | null,
): Promise<{ hubspot_contact_id: string } | null> {
  const supabase = createAdminClient();
  let query = supabase.from('contacts_cache').select('hubspot_contact_id');
  if (email) {
    query = query.eq('email', email);
  } else if (phone) {
    query = query.eq('phone', phone);
  } else {
    return null;
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`contacts_cache lookup failed: ${error.message}`);
  return (data as { hubspot_contact_id: string }) ?? null;
}

async function getSink(): Promise<TicketSink> {
  const env = loadServerEnv();
  const settings = await getAppSettings();
  const pipelineId = settings.hubspot_pipeline_id ?? env.HUBSPOT_PIPELINE_ID;
  const stageId = settings.hubspot_stage_id ?? env.HUBSPOT_STAGE_ID;
  if (!env.HUBSPOT_TOKEN || !pipelineId || !stageId) {
    throw new Error(
      'HubSpot is not configured (token/pipeline/stage) — set HUBSPOT_TOKEN and choose a pipeline in Einstellungen',
    );
  }
  return createHubSpotSink({ token: env.HUBSPOT_TOKEN, pipelineId, stageId });
}

function normalizeEmail(email: string | null): string | null {
  return email ? email.trim().toLowerCase() : null;
}

function buildTicketContent(extraction: TicketExtraction, message: InboundMessageRow): string {
  const parts = [extraction.ticket.description];
  if (message.attachments.length > 0) {
    parts.push(
      '',
      `Anhänge (${message.attachments.length}, abrufbar im Zendori-Dashboard):`,
      ...message.attachments.map((a) => `- ${a.filename} (${a.contentType})`),
    );
  }
  parts.push('', `— Eingang über Kanal "${message.channel}" am ${message.received_at}`);
  return parts.join('\n');
}

function buildAiSkippedExtraction(
  message: InboundMessageRow,
  bodyText: string,
  settings: AppSettings,
): TicketExtraction {
  const fallbackCategory =
    settings.ticket_categories[settings.ticket_categories.length - 1] ?? 'Sonstiges';
  return {
    contact: {
      name: message.sender_name,
      email: message.sender_email,
      phone: message.sender_phone,
      company: null,
    },
    ticket: {
      subject: (message.subject ?? 'Anfrage (ohne KI-Extraktion)').slice(0, 80),
      description: bodyText.slice(0, 20_000) || '(kein Text)',
      category: fallbackCategory,
      priority: 'normal',
      priority_reason: 'KI-Extraktion übersprungen (ai_skipped) — Standardpriorität.',
      language: 'de',
    },
    meta: {
      is_spam: false,
      is_auto_reply: false,
      summary: 'Anfrage ohne KI-Extraktion weitergeleitet (ai_skipped).',
    },
    extraction: { confidence: 0, missing_fields: [], questions: [] },
  };
}

function readAutoSubmittedFlag(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as Record<string, unknown>;
  const check = record['auto_submitted'] as { isAutoSubmitted?: boolean } | undefined;
  return Boolean(check?.isAutoSubmitted);
}

function readMailboxId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)['mailbox_id'];
  return typeof value === 'string' ? value : null;
}

function readPasteContext(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)['context_note'];
  return typeof value === 'string' && value.trim() ? value : null;
}
