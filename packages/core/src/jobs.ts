/**
 * Pipeline job contracts (CLAUDE.md §5, Vercel variant — docs/entscheidungen.md D).
 * Jobs live in the Postgres table `public.jobs` and are claimed atomically via
 * the `claim_due_jobs` RPC (FOR UPDATE SKIP LOCKED). Processing runs in Vercel
 * Functions: kicked right after ingest, plus a minutely cron sweeper that picks
 * up retries, releases stuck leases, and polls the mailboxes (Phase 1).
 *
 * Every step is idempotent and retried with exponential backoff (max 5);
 * exhausted jobs become status `dead` and end visibly (message `failed`
 * + dashboard alert in Phase 1). Never silent loss of a message.
 */

/** Pipeline steps in execution order. Must stay in sync with handler registry and docs. */
export const PIPELINE_STEPS = [
  /** Step 2 — AI extraction of the ticket schema from the normalized message. */
  'extract',
  /** Step 3 — find-or-create the contact in the sink. */
  'contact_upsert',
  /** Step 4 — three-stage dedup check (hard hits, candidates, LLM judge). */
  'dedup_check',
  /** Step 5 — create ticket OR attach note, depending on the dedup decision. */
  'deliver',
  /** Step 6 — channel-specific confirmation (mail auto-reply, WhatsApp ack, ...). */
  'confirm',
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** Must stay in sync with the `job_status` Postgres enum. */
export const JOB_STATUSES = ['queued', 'processing', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Row shape of `public.jobs` (as returned by the claim RPC). */
export interface JobRecord {
  id: string;
  step: PipelineStep;
  message_id: string;
  correlation_id: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  claimed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Retry policy per CLAUDE.md §5 — mirrored in SQL (`job_retry_delay`). */
export const JOB_MAX_ATTEMPTS = 5;
export const JOB_BASE_BACKOFF_SECONDS = 15;

/** Exponential backoff: 15s, 30s, 60s, 120s, ... after the n-th attempt. */
export function retryDelaySeconds(attempts: number): number {
  return JOB_BASE_BACKOFF_SECONDS * 2 ** Math.max(attempts - 1, 0);
}

/**
 * A `processing` job whose lease is older than this is considered crashed
 * (function timeout/abort) and is released for retry by the sweeper.
 */
export const JOB_LEASE_SECONDS = 300;
