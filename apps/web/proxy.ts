import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/proxy';

// Next.js 16: proxy.ts replaces middleware.ts (runs on the Node.js runtime).
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Everything except static assets and the healthcheck. Ingest webhooks
  // (Phase 1) authenticate per-request and get added here as exclusions.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|healthz|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
