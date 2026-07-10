import { newCorrelationId, type AttachmentRef, type Channel, type MessageStatus } from '@zendori/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Server-side data access for the pipeline (service key, bypasses RLS).
 * Dashboard READS go through the user-scoped client instead (RLS applies) —
 * see lib/supabase/server.ts.
 */

export interface InboundMessageRow {
  id: string;
  channel: Channel;
  external_id: string;
  sender_name: string | null;
  sender_email: string | null;
  sender_phone: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  attachments: AttachmentRef[];
  raw: unknown;
  received_at: string;
  status: MessageStatus;
  error: string | null;
  correlation_id: string;
  created_at: string;
}

export interface NewInboundMessage {
  channel: Channel;
  externalId: string;
  senderName?: string | null;
  senderEmail?: string | null;
  senderPhone?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  attachments?: AttachmentRef[];
  raw: unknown;
  receivedAt: string;
}

export type InsertMessageResult =
  | { inserted: true; message: InboundMessageRow }
  | { inserted: false; reason: 'duplicate' };

/** Insert a normalized message; (channel, external_id) duplicates are a no-op (§8 stage 1). */
export async function insertInboundMessage(
  input: NewInboundMessage,
  supabase: SupabaseClient = createAdminClient(),
): Promise<InsertMessageResult> {
  const { data, error } = await supabase
    .from('inbound_messages')
    .insert({
      channel: input.channel,
      external_id: input.externalId,
      sender_name: input.senderName ?? null,
      sender_email: input.senderEmail ?? null,
      sender_phone: input.senderPhone ?? null,
      subject: input.subject ?? null,
      body_text: input.bodyText ?? null,
      body_html: input.bodyHtml ?? null,
      attachments: input.attachments ?? [],
      raw: input.raw,
      received_at: input.receivedAt,
      status: 'received',
      correlation_id: newCorrelationId(),
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return { inserted: false, reason: 'duplicate' };
    }
    throw new Error(`insertInboundMessage failed: ${error.message}`);
  }
  return { inserted: true, message: data as InboundMessageRow };
}

export async function getMessage(
  messageId: string,
  supabase: SupabaseClient = createAdminClient(),
): Promise<InboundMessageRow> {
  const { data, error } = await supabase
    .from('inbound_messages')
    .select()
    .eq('id', messageId)
    .single();
  if (error) throw new Error(`getMessage failed: ${error.message}`);
  return data as InboundMessageRow;
}

export async function setMessageStatus(
  messageId: string,
  status: MessageStatus,
  errorText: string | null = null,
  supabase: SupabaseClient = createAdminClient(),
): Promise<void> {
  const { error } = await supabase
    .from('inbound_messages')
    .update({ status, error: errorText })
    .eq('id', messageId);
  if (error) throw new Error(`setMessageStatus failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// app_settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  ticket_categories: string[];
  dedup_window_days: number;
  dedup_confidence_threshold: number;
  extraction_escalation_threshold: number;
  attachment_max_mb: number;
  form_rate_limit_per_minute: number;
  hubspot_pipeline_id: string | null;
  hubspot_stage_id: string | null;
  auto_reply_template: { subject: string; body: string };
  retention_raw_messages_days: number;
  retention_call_recordings_days: number;
}

const SETTINGS_DEFAULTS: AppSettings = {
  ticket_categories: ['Frage', 'Störung', 'Reklamation', 'Bestellung', 'Sonstiges'],
  dedup_window_days: 14,
  dedup_confidence_threshold: 0.8,
  extraction_escalation_threshold: 0.7,
  attachment_max_mb: 10,
  form_rate_limit_per_minute: 30,
  hubspot_pipeline_id: null,
  hubspot_stage_id: null,
  auto_reply_template: {
    subject: 'Ihre Anfrage ist eingegangen [{{ticket_ref}}]',
    body: 'Guten Tag,\n\nvielen Dank für Ihre Nachricht. Ihr Anliegen wurde unter der Referenz {{ticket_ref}} aufgenommen. Wir melden uns schnellstmöglich bei Ihnen.\n\nBitte lassen Sie die Referenz im Betreff stehen, wenn Sie auf diese E-Mail antworten.\n\nFreundliche Grüße\nStrong Energy',
  },
  retention_raw_messages_days: 90,
  retention_call_recordings_days: 30,
};

/** Load all settings with defaults for anything unset. */
export async function getAppSettings(
  supabase: SupabaseClient = createAdminClient(),
): Promise<AppSettings> {
  const { data, error } = await supabase.from('app_settings').select('key, value');
  if (error) throw new Error(`getAppSettings failed: ${error.message}`);
  const map = Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));
  return { ...SETTINGS_DEFAULTS, ...map } as AppSettings;
}

export async function setAppSetting(
  key: keyof AppSettings,
  value: unknown,
  supabase: SupabaseClient = createAdminClient(),
): Promise<void> {
  const { error } = await supabase.from('app_settings').upsert({ key, value });
  if (error) throw new Error(`setAppSetting failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// audit log (§12: every writing action, user or system)
// ---------------------------------------------------------------------------

export async function audit(
  entry: {
    actorType: 'user' | 'system';
    actorId?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    payload?: unknown;
  },
  supabase: SupabaseClient = createAdminClient(),
): Promise<void> {
  const { error } = await supabase.from('audit_log').insert({
    actor_type: entry.actorType,
    actor_id: entry.actorId ?? null,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entityId ?? null,
    payload: entry.payload ?? null,
  });
  if (error) throw new Error(`audit failed: ${error.message}`);
}
