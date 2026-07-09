const startedAt = Date.now();

/** Liveness endpoint for Docker/Traefik healthchecks (CLAUDE.md §13). Public, no auth. */
export function GET(): Response {
  return Response.json({
    status: 'ok',
    service: 'web',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
}

export const dynamic = 'force-dynamic';
