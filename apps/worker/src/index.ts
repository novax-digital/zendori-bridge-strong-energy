import { createLogger, loadWorkerEnv } from '@zendori/core';
import { PgBoss } from 'pg-boss';

import { createHealthState, startHealthServer } from './health.js';
import { registerPipelineQueues } from './queues.js';

/**
 * Worker entrypoint: pg-boss job processing (+ IMAP ingest from Phase 1 on).
 * Connects via the Supavisor session pooler / direct connection — never the
 * transaction pooler (enforced in env validation).
 */
async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const log = createLogger({ name: 'worker', level: env.LOG_LEVEL });
  const health = createHealthState();
  const healthServer = startHealthServer(env.WORKER_HEALTH_PORT, health, log);

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: 'pgboss',
    max: 5,
  });

  boss.on('error', (error) => {
    log.error({ err: error }, 'pg-boss error');
  });

  await boss.start();
  health.pgBossStarted = true;
  log.info('pg-boss started');

  health.queues = await registerPipelineQueues(boss, log);
  log.info({ queues: health.queues }, 'pipeline queues registered');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    health.pgBossStarted = false;
    try {
      await boss.stop({ graceful: true, timeout: 30_000 });
    } catch (error) {
      log.error({ err: error }, 'error while stopping pg-boss');
    }
    healthServer.close(() => process.exit(0));
    // Fallback if the health server does not close in time.
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Logger may not exist yet (env parsing failed) — fall back to stderr.
  console.error('worker failed to start:', error);
  process.exit(1);
});
