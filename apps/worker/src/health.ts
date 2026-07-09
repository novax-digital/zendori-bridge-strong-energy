import { createServer, type Server } from 'node:http';

import type { Logger } from '@zendori/core';

/**
 * GET /healthz for the worker (CLAUDE.md §13). Reports pg-boss state and —
 * once the mail channel lands in Phase 1 — the last IMAP poll per mailbox.
 */

export interface HealthState {
  pgBossStarted: boolean;
  queues: string[];
  /** mailbox label → ISO timestamp of the last successful IMAP poll (Phase 1). */
  lastImapPollAt: Record<string, string>;
}

export function createHealthState(): HealthState {
  return { pgBossStarted: false, queues: [], lastImapPollAt: {} };
}

export function startHealthServer(port: number, state: HealthState, log: Logger): Server {
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/healthz') {
      const healthy = state.pgBossStarted;
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: healthy ? 'ok' : 'degraded',
          service: 'worker',
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          pgBossStarted: state.pgBossStarted,
          queues: state.queues,
          lastImapPollAt: state.lastImapPollAt,
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, () => {
    log.info({ port }, 'health server listening');
  });
  return server;
}
