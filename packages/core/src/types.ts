import { randomUUID } from 'node:crypto';

/** Intake channels. Must stay in sync with the `channel_type` Postgres enum. */
export const CHANNELS = ['form', 'email', 'phone', 'whatsapp', 'paste'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Processing states of an inbound message. Must stay in sync with the `message_status` Postgres enum. */
export const MESSAGE_STATUSES = [
  'received',
  'extracted',
  'needs_info',
  'ticket_created',
  'attached_to_existing',
  'spam',
  'failed',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Dedup verdicts. Must stay in sync with the `dedup_decision_type` Postgres enum. */
export const DEDUP_DECISIONS = ['new', 'duplicate', 'follow_up'] as const;
export type DedupDecision = (typeof DEDUP_DECISIONS)[number];

/** Reference to an attachment stored in Supabase Storage (never inline file contents). */
export interface AttachmentRef {
  storagePath: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * The normalized message every channel adapter produces.
 * Adapters map channel-specific payloads onto this shape; the pipeline only ever sees this.
 */
export interface InboundMessage {
  id: string;
  channel: Channel;
  /** Channel-specific stable ID (mail Message-ID, Twilio SID, Vapi call ID, ...) — unique per channel. */
  externalId: string;
  senderName: string | null;
  senderEmail: string | null;
  senderPhone: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentRef[];
  /** Raw channel payload, persisted verbatim for audit/replay. */
  raw: unknown;
  receivedAt: string;
  status: MessageStatus;
  correlationId: string;
}

/** One correlation ID per message, threaded through all logs and jobs. */
export function newCorrelationId(): string {
  return randomUUID();
}
