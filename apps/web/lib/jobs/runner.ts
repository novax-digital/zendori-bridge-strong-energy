import {
  createLogger,
  JOB_LEASE_SECONDS,
  PIPELINE_STEPS,
  retryDelaySeconds,
  withCorrelation,
  type JobRecord,
  type PipelineStep,
} from '@zendori/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Job runner (CLAUDE.md §5, Vercel variant): claims due jobs from the
 * Postgres queue and dispatches them to step handlers. Invoked by the
 * minutely cron sweeper — and from Phase 1 on directly after ingest.
 *
 * Handlers are Phase-0 stubs; the real implementations land in Phase 1.
 */

type StepHandler = (job: JobRecord) => Promise<void>;

const log = createLogger({ name: 'jobs' });

const HANDLERS: Record<PipelineStep, StepHandler> = Object.fromEntries(
  PIPELINE_STEPS.map((step) => [
    step,
    async (job: JobRecord) => {
      withCorrelation(log, job.correlation_id).info(
        { step, jobId: job.id, messageId: job.message_id },
        'pipeline step received — handler is a Phase 0 stub, implementation lands in Phase 1',
      );
    },
  ]),
) as Record<PipelineStep, StepHandler>;

export interface SweepResult {
  released: number;
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
}

/** One sweep: release expired leases, then claim and process due jobs. */
export async function runDueJobs(batchSize = 10): Promise<SweepResult> {
  const supabase = createAdminClient();
  const result: SweepResult = { released: 0, claimed: 0, succeeded: 0, failed: 0, dead: 0 };

  const releasedRes = await supabase.rpc('release_stuck_jobs', {
    lease_seconds: JOB_LEASE_SECONDS,
  });
  if (releasedRes.error) {
    throw new Error(`release_stuck_jobs failed: ${releasedRes.error.message}`);
  }
  result.released = (releasedRes.data as number | null) ?? 0;

  const claimedRes = await supabase.rpc('claim_due_jobs', { batch_size: batchSize });
  if (claimedRes.error) {
    throw new Error(`claim_due_jobs failed: ${claimedRes.error.message}`);
  }
  const jobs = (claimedRes.data as JobRecord[] | null) ?? [];
  result.claimed = jobs.length;

  for (const job of jobs) {
    const jobLog = withCorrelation(log, job.correlation_id);
    try {
      const handler = HANDLERS[job.step];
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
        // Never silent loss (§5): from Phase 1 on this also sets the message
        // row to status=failed and raises the dashboard alert.
        jobLog.error(
          { jobId: job.id, step: job.step, err: message },
          'job dead after max attempts',
        );
        result.dead += 1;
      } else {
        jobLog.warn(
          { jobId: job.id, step: job.step, err: message },
          'job attempt failed, retry scheduled',
        );
        result.failed += 1;
      }
    }
  }

  return result;
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
