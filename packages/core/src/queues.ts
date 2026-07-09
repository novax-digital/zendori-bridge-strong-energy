/**
 * pg-boss queue contracts (CLAUDE.md §5). Every pipeline step is idempotent,
 * retried with exponential backoff (max 5), and ends visibly: failed jobs land
 * in a dead-letter queue and the message row is marked `failed`.
 *
 * Queue names: pg-boss v12 only allows letters, numbers, `-`, `_`, `.`.
 */

export const QUEUE = {
  /** Step 2 — AI extraction of the ticket schema from the normalized message. */
  EXTRACT: 'pipeline.extract',
  /** Step 3 — find-or-create the contact in the sink. */
  CONTACT_UPSERT: 'pipeline.contact-upsert',
  /** Step 4 — three-stage dedup check (hard hits, candidates, LLM judge). */
  DEDUP_CHECK: 'pipeline.dedup-check',
  /** Step 5 — create ticket OR attach note, depending on the dedup decision. */
  DELIVER: 'pipeline.deliver',
  /** Step 6 — channel-specific confirmation (mail auto-reply, WhatsApp ack, ...). */
  CONFIRM: 'pipeline.confirm',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const PIPELINE_QUEUES: readonly QueueName[] = Object.values(QUEUE);

export const DEAD_LETTER_SUFFIX = '.dlq';

export function deadLetterQueue(queue: QueueName): string {
  return `${queue}${DEAD_LETTER_SUFFIX}`;
}

/** Payload shared by all pipeline jobs — steps load their state from the DB by messageId. */
export interface PipelineJobData {
  messageId: string;
  correlationId: string;
  [key: string]: unknown;
}

/** Retry policy per CLAUDE.md §5: exponential backoff, max 5 attempts. */
export const PIPELINE_RETRY = {
  retryLimit: 5,
  retryBackoff: true,
  /** Base delay in seconds for the exponential backoff. */
  retryDelay: 15,
} as const;
