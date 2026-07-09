import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/proxy';

// Next.js 16: proxy.ts replaces middleware.ts (runs on the Node.js runtime).
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Everything except static assets, exactly /healthz, and /api/* — API routes
  // (cron, later ingest webhooks) authenticate per-request, not via session.
  // NOTE: paths ending in an image extension bypass the session gate — any
  // Phase-1 route serving user content must live under /api/* with its own
  // auth or behind signed URLs, never rely on this proxy.
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|healthz$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
