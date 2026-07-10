import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';

/**
 * Mailbox connection test for the settings UI (CLAUDE.md §11): IMAP login +
 * INBOX access and SMTP login, each reported independently. Details are
 * end-user copy (German).
 */

export interface ConnectionTestResult {
  imap: { ok: boolean; detail: string };
  smtp: { ok: boolean; detail: string };
}

export async function testMailboxConnection(mailbox: {
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string;
}): Promise<ConnectionTestResult> {
  return {
    imap: await testImap(mailbox),
    smtp: await testSmtp(mailbox),
  };
}

async function testImap(mailbox: {
  imap_host: string;
  imap_port: number;
  username: string;
  password: string;
}): Promise<{ ok: boolean; detail: string }> {
  const client = new ImapFlow({
    host: mailbox.imap_host,
    port: mailbox.imap_port,
    secure: mailbox.imap_port === 993,
    auth: { user: mailbox.username, pass: mailbox.password },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let exists = 0;
    try {
      const box = client.mailbox;
      exists = box ? box.exists : 0;
    } finally {
      lock.release();
    }
    return { ok: true, detail: `INBOX erreichbar (${exists} Nachrichten)` };
  } catch (error) {
    return { ok: false, detail: `IMAP-Verbindung fehlgeschlagen: ${errorMessage(error)}` };
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

async function testSmtp(mailbox: {
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string;
}): Promise<{ ok: boolean; detail: string }> {
  const transporter = createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: mailbox.smtp_port === 465,
    // Port 587 & friends: enforce STARTTLS — otherwise a MITM stripping the
    // capability downgrades to cleartext (password + PII).
    requireTLS: mailbox.smtp_port !== 465,
    auth: { user: mailbox.username, pass: mailbox.password },
  });
  try {
    await transporter.verify();
    return { ok: true, detail: 'SMTP-Login erfolgreich' };
  } catch (error) {
    return { ok: false, detail: `SMTP-Verbindung fehlgeschlagen: ${errorMessage(error)}` };
  } finally {
    transporter.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
