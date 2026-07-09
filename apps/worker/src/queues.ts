import {
  deadLetterQueue,
  PIPELINE_QUEUES,
  PIPELINE_RETRY,
  withCorrelation,
  type Logger,
  type PipelineJobData,
} from '@zendori/core';
import type { PgBoss } from 'pg-boss';

/**
 * Registers all pipeline queues with their retry policy and dead-letter queues,
 * plus stub workers. The actual step handlers land in Phase 1 — this skeleton
 * proves the queue topology, retry policy, and correlation-ID logging.
 */
export async function registerPipelineQueues(boss: PgBoss, log: Logger): Promise<string[]> {
  const registered: string[] = [];

  for (const queue of PIPELINE_QUEUES) {
    const dlq = deadLetterQueue(queue);

    // The dead-letter queue must exist before the main queue references it.
    await ensureQueue(boss, dlq, {});
    await ensureQueue(boss, queue, { ...PIPELINE_RETRY, deadLetter: dlq });
    registered.push(queue, dlq);

    // pg-boss v12 handlers receive an ARRAY of jobs, even with batchSize 1.
    await boss.work<PipelineJobData>(queue, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        const jobLog = withCorrelation(log, job.data.correlationId);
        jobLog.info(
          { queue, jobId: job.id, messageId: job.data.messageId },
          'pipeline step received — handler is a Phase 0 stub, implementation lands in Phase 1',
        );
      }
    });

    // Failed-beyond-retry jobs must end visibly (§5): log loudly; Phase 1 adds
    // status=failed on the message row + dashboard alert.
    await boss.work<PipelineJobData>(dlq, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        const jobLog = withCorrelation(log, job.data.correlationId);
        jobLog.error(
          { queue: dlq, jobId: job.id, messageId: job.data.messageId },
          'job exhausted all retries and landed in the dead-letter queue',
        );
      }
    });
  }

  return registered;
}

type QueueOptions = Parameters<PgBoss['createQueue']>[1];

async function ensureQueue(boss: PgBoss, name: string, options: QueueOptions): Promise<void> {
  const existing = await boss.getQueue(name);
  if (!existing) {
    await boss.createQueue(name, options);
  } else {
    await boss.updateQueue(name, options);
  }
}
