import { ImapFlow } from 'imapflow';
import { simpleParser, type Attachment, type ParsedMail } from 'mailparser';
import {
  createLogger,
  decryptSecret,
  detectAutoSubmitted,
  loadServerEnv,
  type AttachmentRef,
} from '@zendori/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { audit, getAppSettings, insertInboundMessage, type AppSettings } from '@/lib/db';
import { listActiveMailboxes, updateMailboxPollState, type MailboxRow } from '@/lib/db/mailboxes';
import { enqueueJob } from '@/lib/jobs/enqueue';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * IMAP polling (CLAUDE.md §10.2): the minutely cron opens one connection per
 * active mailbox, ingests everything above last_uid and closes again. The
 * sweeper calls runDueJobs right after polling, so enqueued jobs need no kick.
 * PII rule: never log subjects, addresses or bodies — counts and labels only.
 */

const log = createLogger({ name: 'mail.poll' });

export interface PollSummary {
  mailboxes: number;
  newMessages: number;
  errors: Array<{ mailbox: string; error: string }>;
}

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export async function pollAllMailboxes(): Promise<PollSummary> {
  const env = loadServerEnv();
  const supabase = createAdminClient();
  const mailboxes = await listActiveMailboxes(supabase);
  const settings = await getAppSettings(supabase);
  const summary: PollSummary = { mailboxes: mailboxes.length, newMessages: 0, errors: [] };

  for (const mailbox of mailboxes) {
    try {
      const newMessages = await pollMailbox(mailbox, settings, env.ENCRYPTION_KEY, supabase);
      summary.newMessages += newMessages;
      log.info({ mailbox: mailbox.label, newMessages }, 'mailbox polled');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push({ mailbox: mailbox.label, error: message });
      log.error({ mailbox: mailbox.label, err: message }, 'mailbox poll failed');
    }
  }
  return summary;
}

async function pollMailbox(
  mailbox: MailboxRow,
  settings: AppSettings,
  encryptionKey: string,
  supabase: SupabaseClient,
): Promise<number> {
  if (mailbox.auth_type !== 'password') {
    throw new Error('OAuth2-Postfächer werden noch nicht unterstützt');
  }
  const password = decryptSecret(mailbox.secret_encrypted, encryptionKey);
  const client = new ImapFlow({
    host: mailbox.imap_host,
    port: mailbox.imap_port,
    secure: mailbox.imap_port === 993,
    auth: { user: mailbox.username, pass: password },
    logger: false,
  });
  await client.connect();

  let newMessages = 0;
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const box = client.mailbox;
      if (!box) throw new Error('INBOX could not be selected');
      const uidValidity = box.uidValidity;

      let lastUid = mailbox.last_uid ?? 0;
      if (mailbox.imap_uidvalidity === null || BigInt(mailbox.imap_uidvalidity) !== uidValidity) {
        // UIDVALIDITY changed (or first poll): stored UIDs are void — restart
        // from 0 and persist immediately so a crash mid-poll stays consistent.
        lastUid = 0;
        await updateMailboxPollState(
          mailbox.id,
          { last_uid: 0, imap_uidvalidity: Number(uidValidity) },
          supabase,
        );
      }

      // Collect first, process after: running IMAP commands inside the fetch
      // iterator deadlocks the connection (imapflow fetch() doc).
      const fetched: Array<{ uid: number; source: Buffer }> = [];
      if (box.exists > 0) {
        for await (const msg of client.fetch(
          `${lastUid + 1}:*`,
          { uid: true, source: true },
          { uid: true },
        )) {
          // IMAP quirk: an out-of-range `n:*` still returns the last message,
          // so a stale UID can come back even when nothing is new.
          if (msg.uid <= lastUid || !msg.source) continue;
          fetched.push({ uid: msg.uid, source: msg.source });
        }
      }
      fetched.sort((a, b) => a.uid - b.uid);

      let maxUid = lastUid;
      for (const item of fetched) {
        try {
          const inserted = await ingestMessage(mailbox, uidValidity, item, settings, supabase);
          if (inserted) newMessages += 1;
          await client.messageFlagsAdd({ uid: item.uid }, ['\\Seen'], { uid: true });
        } catch (error) {
          // Poison message: skip past it so it cannot wedge the whole mailbox
          // (all newer mail would otherwise never be ingested). It stays
          // UNREAD in the mailbox and the failure is recorded loudly — no
          // silent loss.
          const reason = error instanceof Error ? error.message : String(error);
          log.error({ mailbox: mailbox.label, uid: item.uid, err: reason }, 'mail ingest failed');
          await audit(
            {
              actorType: 'system',
              action: 'mail_ingest_failed',
              entity: 'mailbox',
              entityId: mailbox.id,
              payload: { uid: item.uid, reason },
            },
            supabase,
          ).catch(() => {});
        }
        if (item.uid > maxUid) maxUid = item.uid;
      }

      const patch: { last_uid?: number; last_poll_at: string } = {
        last_poll_at: new Date().toISOString(),
      };
      if (maxUid !== lastUid) patch.last_uid = maxUid;
      await updateMailboxPollState(mailbox.id, patch, supabase);
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
  return newMessages;
}

/** Parse, persist, upload attachments and enqueue extraction. Returns false for duplicates. */
async function ingestMessage(
  mailbox: MailboxRow,
  uidValidity: bigint,
  item: { uid: number; source: Buffer },
  settings: AppSettings,
  supabase: SupabaseClient,
): Promise<boolean> {
  const parsed = await simpleParser(item.source);
  const externalId = parsed.messageId ?? `${mailbox.id}:${uidValidity}:${item.uid}`;
  const headers = headersRecordFrom(parsed);

  const maxBytes = settings.attachment_max_mb * 1024 * 1024;
  const eligible: Attachment[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  parsed.attachments.forEach((att, index) => {
    const name = sanitizeFilename(att.filename, index);
    if (!ALLOWED_ATTACHMENT_TYPES.has(att.contentType.toLowerCase())) {
      skipped.push({ name, reason: `Dateityp nicht erlaubt (${att.contentType})` });
    } else if (att.content.length > maxBytes) {
      skipped.push({ name, reason: `Datei zu groß (Limit ${settings.attachment_max_mb} MB)` });
    } else {
      eligible.push(att);
    }
  });

  const raw = {
    mailbox_id: mailbox.id,
    uid: item.uid,
    uidvalidity: String(uidValidity),
    auto_submitted: detectAutoSubmitted(headers),
    message_id: parsed.messageId ?? null,
    in_reply_to: parsed.inReplyTo ?? null,
    references: parsed.references ?? null,
    skipped_attachments: skipped,
  };

  const result = await insertInboundMessage(
    {
      channel: 'email',
      externalId,
      senderName: parsed.from?.value?.[0]?.name || null,
      senderEmail: parsed.from?.value?.[0]?.address || null,
      subject: parsed.subject || null,
      bodyText: parsed.text ?? (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : null),
      bodyHtml: typeof parsed.html === 'string' ? parsed.html : null,
      raw,
      attachments: [],
      receivedAt: (parsed.date ?? new Date()).toISOString(),
    },
    supabase,
  );
  if (!result.inserted) return false;
  const message = result.message;

  const refs: AttachmentRef[] = [];
  let skippedChanged = false;
  for (const [index, att] of eligible.entries()) {
    const filename = sanitizeFilename(att.filename, index);
    // Index prefix: two attachments with the same filename must not collide.
    const storagePath = `${message.id}/${index}-${filename}`;
    const { error } = await supabase.storage
      .from('attachments')
      .upload(storagePath, att.content, { contentType: att.contentType });
    if (error) {
      skipped.push({ name: filename, reason: `Upload fehlgeschlagen: ${error.message}` });
      skippedChanged = true;
      continue;
    }
    refs.push({
      storagePath,
      filename,
      contentType: att.contentType,
      sizeBytes: att.content.length,
    });
  }

  if (refs.length > 0 || skippedChanged) {
    const patch: Record<string, unknown> = {};
    if (refs.length > 0) patch.attachments = refs;
    // `skipped` is referenced by `raw`, so upload failures are already in there.
    if (skippedChanged) patch.raw = raw;
    const { error } = await supabase.from('inbound_messages').update(patch).eq('id', message.id);
    if (error) throw new Error(`attachment update failed: ${error.message}`);
  }

  await enqueueJob('extract', message.id, message.correlation_id, supabase);
  return true;
}

/** Lowercased header record for detectAutoSubmitted; repeated headers become arrays. */
function headersRecordFrom(parsed: ParsedMail): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  for (const { key, line } of parsed.headerLines) {
    const colon = line.indexOf(':');
    const value = colon >= 0 ? line.slice(colon + 1).trim() : '';
    const name = key.toLowerCase();
    const existing = record[name];
    if (existing === undefined) {
      record[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      record[name] = [existing, value];
    }
  }
  return record;
}

function sanitizeFilename(filename: string | undefined, index: number): string {
  const cleaned = (filename ?? '')
    .replace(/[/\\]/g, '_')

    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return cleaned || `anhang-${index + 1}`;
}
