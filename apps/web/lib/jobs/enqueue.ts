import { createLogger, type PipelineStep } from '@zendori/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';

import { runDueJobs } from '@/lib/jobs/runner';
import { createAdminClient } from '@/lib/supabase/admin';

/** Insert a pipeline job (due immediately). */
export async function enqueueJob(
  step: PipelineStep,
  messageId: string,
  correlationId: string,
  supabase: SupabaseClient = createAdminClient(),
): Promise<void> {
  const { error } = await supabase.from('jobs').insert({
    step,
    message_id: messageId,
    correlation_id: correlationId,
  });
  // 23505 = a pending job for (message, step) already exists (partial unique
  // index) — duplicate enqueues from double clicks or overlapping runners
  // collapse into that job, which is exactly what we want.
  if (error && error.code !== '23505') {
    throw new Error(`enqueueJob(${step}) failed: ${error.message}`);
  }
}

/**
 * Process due jobs right after the current response is sent (Vercel keeps the
 * function alive via after()). The minutely cron sweeper remains the safety
 * net for retries and anything this kick misses.
 */
export function kickJobRunnerAfterResponse(): void {
  after(async () => {
    try {
      await runDueJobs();
    } catch (error) {
      // Never rethrow (the sweeper retries) — but log loudly: a silently
      // failing kick masked a runner-blocking bug once already.
      createLogger({ name: 'jobs.kick' }).error(
        { err: error instanceof Error ? error.message : String(error) },
        'post-response job kick failed — cron sweeper will retry',
      );
    }
  });
}
