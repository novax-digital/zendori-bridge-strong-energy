'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { audit, getMessage, setMessageStatus } from '@/lib/db';
import { enqueueJob, kickJobRunnerAfterResponse } from '@/lib/jobs/enqueue';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Session check for dashboard actions; writes below use the admin client. */
async function requireUserId(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    redirect('/login');
  }
  return data.claims.sub;
}

/**
 * Drop the message's pending jobs so an operator decision (reprocess, spam)
 * is not raced by an in-flight pipeline. `processing` jobs cannot be deleted
 * safely — the spam guard in the step handlers neutralizes those.
 */
async function cancelPendingJobs(messageId: string, admin: SupabaseClient): Promise<void> {
  const { error } = await admin
    .from('jobs')
    .delete()
    .eq('message_id', messageId)
    .in('status', ['queued', 'failed']);
  if (error) throw new Error(`cancelPendingJobs failed: ${error.message}`);
}

/** Reset a message to `received` and restart the pipeline at the extract step (§11). */
export async function reprocessMessage(messageId: string): Promise<void> {
  const actorId = await requireUserId();
  const admin = createAdminClient();

  const message = await getMessage(messageId, admin);
  await cancelPendingJobs(messageId, admin);
  await setMessageStatus(messageId, 'received', null, admin);
  await enqueueJob('extract', messageId, message.correlation_id, admin);
  kickJobRunnerAfterResponse();

  await audit(
    {
      actorType: 'user',
      actorId,
      action: 'message_reprocessed',
      entity: 'inbound_message',
      entityId: messageId,
    },
    admin,
  );

  revalidatePath('/');
  revalidatePath(`/nachricht/${messageId}`);
}

export async function markAsSpam(messageId: string): Promise<void> {
  const actorId = await requireUserId();
  const admin = createAdminClient();

  // Order matters: status first (the step-level spam guard reads it), then
  // drop whatever is still queued.
  await setMessageStatus(messageId, 'spam', null, admin);
  await cancelPendingJobs(messageId, admin);

  await audit(
    {
      actorType: 'user',
      actorId,
      action: 'message_marked_spam',
      entity: 'inbound_message',
      entityId: messageId,
    },
    admin,
  );

  revalidatePath('/');
  revalidatePath(`/nachricht/${messageId}`);
}
