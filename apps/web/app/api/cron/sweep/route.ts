import { createLogger, loadServerEnv } from '@zendori/core';

import { runDueJobs } from '@/lib/jobs/runner';

/**
 * Minutely cron sweeper (vercel.json → crons): releases expired job leases,
 * processes due jobs (retries included). From Phase 1 on it also triggers the
 * IMAP poll per mailbox. Authenticated via CRON_SECRET — Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` on cron invocations.
 */

const log = createLogger({ name: 'cron.sweep' });

export async function GET(request: Request): Promise<Response> {
  let env;
  try {
    env = loadServerEnv();
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'invalid env');
    return Response.json({ error: 'server misconfigured' }, { status: 500 });
  }

  if (request.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await runDueJobs();
    if (result.claimed > 0 || result.released > 0) {
      log.info(result, 'sweep finished');
    }
    return Response.json({ status: 'ok', ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message }, 'sweep failed');
    return Response.json({ error: 'sweep failed' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
// Sweeps are small batches; well below Vercel's function duration limits.
export const maxDuration = 60;
