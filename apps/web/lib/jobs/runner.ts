import {
  createLogger,
  JOB_LEASE_SECONDS,
  retryDelaySeconds,
  withCorrelation,
  type JobRecord,
} from '@zendori/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getMessage, setMessageStatus } from '@/lib/db';
import { STEP_HANDLERS } from '@/lib/pipeline/steps';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Job runner (CLAUDE.md §5, Vercel variant): claims due jobs from the
 * Postgres queue and dispatches them to the pipeline step handlers.
 * Invoked right after ingest (after()) and by the minutely cron sweeper.
 * Drains in batches so a chained pipeline (extract -> ... -> confirm)
 * completes within one invocation instead of waiting a sweep per step.
 */

const log = createLogger({ name: 'jobs' });

/** Safety bounds per invocation. */
const MAX_BATCHES = 20;
const BATCH_SIZE = 10;

export interface SweepResult {
  released: number;
  rescued: number;
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
}

export async function runDueJobs(): Promise<SweepResult> {
  const supabase = createAdminClient();
  const result: SweepResult = {
    released: 0,
    rescued: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
  };

  const releasedRes = await supabase.rpc('release_stuck_jobs', {
    lease_seconds: JOB_LEASE_SECONDS,
  });
  if (releasedRes.error) {
    throw new Error(`release_stuck_jobs failed: ${releasedRes.error.message}`);
  }
  result.released = (releasedRes.data as number | null) ?? 0;

  // §5 never silent loss: re-enqueue messages stranded in 'received' with no
  // job (ingest crashed between message insert and job insert).
  const rescuedRes = await supabase.rpc('rescue_stranded_messages', { grace_seconds: 120 });
  if (rescuedRes.error) {
    throw new Error(`rescue_stranded_messages failed: ${rescuedRes.error.message}`);
  }
  result.rescued = (rescuedRes.data as number | null) ?? 0;
  if (result.rescued > 0) {
    log.warn({ rescued: result.rescued }, 'stranded messages re-enqueued (ingest crash?)');
  }

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const claimedRes = await supabase.rpc('claim_due_jobs', { batch_size: BATCH_SIZE });
    if (claimedRes.error) {
      throw new Error(`claim_due_jobs failed: ${claimedRes.error.message}`);
    }
    const jobs = (claimedRes.data as JobRecord[] | null) ?? [];
    if (jobs.length === 0) break;
    result.claimed += jobs.length;

    for (const job of jobs) {
      await processJob(supabase, job, result);
    }
  }

  return result;
}

async function processJob(
  supabase: SupabaseClient,
  job: JobRecord,
  result: SweepResult,
): Promise<void> {
  const jobLog = withCorrelation(log, job.correlation_id);
  try {
    const handler = STEP_HANDLERS[job.step];
    if (!handler) {
      throw new Error(`no handler registered for step "${job.step}"`);
    }
    await handler(job);
    await markJob(supabase, job.id, { status: 'succeeded', last_error: null });
    result.succeeded += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = job.attempts >= job.max_attempts;
    await markJob(supabase, job.id, {
      status: exhausted ? 'dead' : 'failed',
      last_error: message,
      run_after: new Date(Date.now() + retryDelaySeconds(job.attempts) * 1000).toISOString(),
    });
    if (exhausted) {
      // Never silent loss (§5): dead job => message visibly failed — but never
      // downgrade a terminal success (e.g. dead confirm after ticket_created).
      result.dead += 1;
      jobLog.error({ jobId: job.id, step: job.step, err: message }, 'job dead after max attempts');
      try {
        const current = await getMessage(job.message_id, supabase);
        if (!['ticket_created', 'attached_to_existing', 'spam'].includes(current.status)) {
          await setMessageStatus(job.message_id, 'failed', `${job.step}: ${message}`, supabase);
        }
      } catch (statusError) {
        jobLog.error(
          { jobId: job.id, err: String(statusError) },
          'failed to mark message as failed',
        );
      }
    } else {
      result.failed += 1;
      jobLog.warn(
        { jobId: job.id, step: job.step, attempt: job.attempts, err: message },
        'job attempt failed, retry scheduled',
      );
    }
  }
}

async function markJob(
  supabase: SupabaseClient,
  jobId: string,
  patch: { status: string; last_error: string | null; run_after?: string },
): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({ ...patch, claimed_at: null })
    .eq('id', jobId);
  if (error) {
    throw new Error(`failed to update job ${jobId}: ${error.message}`);
  }
}
