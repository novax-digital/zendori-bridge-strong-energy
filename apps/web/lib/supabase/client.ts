'use client';

import { createBrowserClient } from '@supabase/ssr';

/** Supabase client for Client Components (needed from Phase 1 on for live inbox updates). */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
