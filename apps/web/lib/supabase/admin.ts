import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadServerEnv } from '@zendori/core';

/**
 * Service-role client — bypasses RLS. SERVER ONLY: must never be imported
 * from a Client Component (the secret key would leak into the bundle).
 * Used by the job runner, cron sweeper, and later the ingest/sink code.
 */
export function createAdminClient(): SupabaseClient {
  const env = loadServerEnv();
  return createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
