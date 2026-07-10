import { createTransport } from 'nodemailer';
import { createLogger, decryptSecret, loadServerEnv } from '@zendori/core';

import { getMailbox } from '@/lib/db/mailboxes';

/**
 * SMTP auto-reply (CLAUDE.md §10.2). Throws on failure — the job runner
 * retries. Loop protection: the caller must not reply to auto-submitted mail;
 * outbound mail is marked as auto-replied so other systems do the same.
 */

const log = createLogger({ name: 'mail.send' });

const TICKET_REF_PLACEHOLDER = /{{\s*ticket_ref\s*}}/g;

export async function sendAutoReply(opts: {
  mailboxId: string;
  to: string;
  template: { subject: string; body: string };
  ticketRef: string;
  inReplyTo?: string | null;
}): Promise<void> {
  const mailbox = await getMailbox(opts.mailboxId);
  if (!mailbox) throw new Error(`mailbox ${opts.mailboxId} not found`);
  if (!mailbox.active) throw new Error(`mailbox ${mailbox.label} is inactive`);
  if (!mailbox.auto_reply_enabled) {
    log.info({ mailbox: mailbox.label }, 'auto-reply disabled for mailbox — skipping');
    return;
  }

  const env = loadServerEnv();
  const password = decryptSecret(mailbox.secret_encrypted, env.ENCRYPTION_KEY);
  const transporter = createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: mailbox.smtp_port === 465,
    auth: { user: mailbox.username, pass: password },
  });

  try {
    await transporter.sendMail({
      from: mailbox.username,
      to: opts.to,
      subject: opts.template.subject.replace(TICKET_REF_PLACEHOLDER, opts.ticketRef),
      text: opts.template.body.replace(TICKET_REF_PLACEHOLDER, opts.ticketRef),
      inReplyTo: opts.inReplyTo ?? undefined,
      references: opts.inReplyTo ?? undefined,
      headers: {
        'Auto-Submitted': 'auto-replied',
        'X-Auto-Response-Suppress': 'All',
      },
    });
  } finally {
    transporter.close();
  }
  log.info({ mailbox: mailbox.label, ticketRef: opts.ticketRef }, 'auto-reply sent');
}
