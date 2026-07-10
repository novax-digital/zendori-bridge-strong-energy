import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';

export interface MailboxRow {
  id: string;
  label: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  /** AES-256-GCM payload — decrypt with core decryptSecret + ENCRYPTION_KEY. */
  secret_encrypted: string;
  auth_type: 'password' | 'oauth2';
  auto_reply_enabled: boolean;
  active: boolean;
  last_poll_at: string | null;
  last_uid: number | null;
  imap_uidvalidity: number | null;
}

export async function listActiveMailboxes(
  supabase: SupabaseClient = createAdminClient(),
): Promise<MailboxRow[]> {
  const { data, error } = await supabase.from('mailboxes').select().eq('active', true);
  if (error) throw new Error(`listActiveMailboxes failed: ${error.message}`);
  return (data ?? []) as MailboxRow[];
}

export async function getMailbox(
  id: string,
  supabase: SupabaseClient = createAdminClient(),
): Promise<MailboxRow | null> {
  const { data, error } = await supabase.from('mailboxes').select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getMailbox failed: ${error.message}`);
  return (data as MailboxRow) ?? null;
}

export async function updateMailboxPollState(
  id: string,
  patch: { last_uid?: number; imap_uidvalidity?: number; last_poll_at?: string },
  supabase: SupabaseClient = createAdminClient(),
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update(patch).eq('id', id);
  if (error) throw new Error(`updateMailboxPollState failed: ${error.message}`);
}
