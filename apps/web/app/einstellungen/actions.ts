'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  decryptSecret,
  encryptSecret,
  listTicketPipelines,
  loadServerEnv,
  provisionTicketProperties,
  testHubSpotConnection,
} from '@zendori/core';

import { audit, setAppSetting } from '@/lib/db';
import { getMailbox } from '@/lib/db/mailboxes';
import { testMailboxConnection, type ConnectionTestResult } from '@/lib/mail/test-connection';
import { generateFormApiKey } from '@/lib/security/api-keys';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const uuidSchema = z.uuid();

async function requireUserId(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    redirect('/login');
  }
  return sub;
}

// ---------------------------------------------------------------------------
// A) HubSpot
// ---------------------------------------------------------------------------

export async function pruefeHubSpot(): Promise<void> {
  const userId = await requireUserId();
  const admin = createAdminClient();

  const env = loadServerEnv();
  if (!env.HUBSPOT_TOKEN) {
    await admin.from('app_settings').upsert({
      key: 'hubspot_pipelines_cache',
      value: {
        checkedAt: new Date().toISOString(),
        health: { ok: false, detail: 'HUBSPOT_TOKEN ist nicht gesetzt (ENV).' },
        pipelines: [],
      },
    });
    revalidatePath('/einstellungen');
    return;
  }

  let health: unknown;
  try {
    health = await testHubSpotConnection({ token: env.HUBSPOT_TOKEN });
  } catch (error) {
    health = { ok: false, detail: error instanceof Error ? error.message : 'Unbekannter Fehler' };
  }

  let pipelines: unknown = [];
  try {
    pipelines = await listTicketPipelines({ token: env.HUBSPOT_TOKEN });
  } catch {
    // Connection problems already surface via health; an empty list only disables the select.
    pipelines = [];
  }

  const { error } = await admin.from('app_settings').upsert({
    key: 'hubspot_pipelines_cache',
    value: { checkedAt: new Date().toISOString(), health, pipelines },
  });
  if (error) throw new Error(`hubspot_pipelines_cache upsert failed: ${error.message}`);

  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: 'hubspot.check_connection',
      entity: 'app_settings',
      entityId: 'hubspot_pipelines_cache',
    },
    admin,
  );
  revalidatePath('/einstellungen');
}

const pipelineStageSchema = z.string().regex(/^[^|]+\|[^|]+$/);

export async function speicherePipeline(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = pipelineStageSchema.safeParse(formData.get('pipeline_stage'));
  if (!parsed.success) {
    redirect('/einstellungen?fehler=pipeline#hubspot');
  }
  const [pipelineId, stageId] = parsed.data.split('|') as [string, string];

  const admin = createAdminClient();
  await setAppSetting('hubspot_pipeline_id', pipelineId, admin);
  await setAppSetting('hubspot_stage_id', stageId, admin);
  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: 'hubspot.select_pipeline',
      entity: 'app_settings',
      entityId: 'hubspot_pipeline_id',
      payload: { pipelineId, stageId },
    },
    admin,
  );
  revalidatePath('/einstellungen');
}

export async function provisioniereProperties(): Promise<void> {
  const userId = await requireUserId();
  const admin = createAdminClient();
  const checkedAt = new Date().toISOString();

  const env = loadServerEnv();
  let value: Record<string, unknown>;
  if (!env.HUBSPOT_TOKEN) {
    value = { checkedAt, error: 'HUBSPOT_TOKEN ist nicht gesetzt (ENV).' };
  } else
    try {
      const result = await provisionTicketProperties({ token: env.HUBSPOT_TOKEN });
      value = { checkedAt, result };
    } catch (error) {
      value = { checkedAt, error: error instanceof Error ? error.message : 'Unbekannter Fehler' };
    }

  const { error } = await admin
    .from('app_settings')
    .upsert({ key: 'hubspot_provision_result', value });
  if (error) throw new Error(`hubspot_provision_result upsert failed: ${error.message}`);

  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: 'hubspot.provision_properties',
      entity: 'app_settings',
      entityId: 'hubspot_provision_result',
    },
    admin,
  );
  revalidatePath('/einstellungen');
}

// ---------------------------------------------------------------------------
// B) Mailboxes
// ---------------------------------------------------------------------------

export async function testePostfach(id: string): Promise<void> {
  const userId = await requireUserId();
  const parsedId = uuidSchema.safeParse(id);
  if (!parsedId.success) {
    redirect('/einstellungen?fehler=unbekannt#postfaecher');
  }

  const admin = createAdminClient();
  // Admin read on purpose: secret_encrypted is column-revoked for dashboard users.
  const mailbox = await getMailbox(parsedId.data, admin);
  if (!mailbox) {
    redirect('/einstellungen?fehler=unbekannt#postfaecher');
  }

  let result: ConnectionTestResult;
  try {
    const password = decryptSecret(mailbox.secret_encrypted, loadServerEnv().ENCRYPTION_KEY);
    result = await testMailboxConnection({
      imap_host: mailbox.imap_host,
      imap_port: mailbox.imap_port,
      smtp_host: mailbox.smtp_host,
      smtp_port: mailbox.smtp_port,
      username: mailbox.username,
      password,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unbekannter Fehler';
    result = { imap: { ok: false, detail }, smtp: { ok: false, detail } };
  }

  const { data: row, error: readError } = await admin
    .from('app_settings')
    .select('value')
    .eq('key', 'mailbox_test_results')
    .maybeSingle();
  if (readError) throw new Error(`mailbox_test_results read failed: ${readError.message}`);
  const existing =
    row && typeof row.value === 'object' && row.value !== null && !Array.isArray(row.value)
      ? (row.value as Record<string, unknown>)
      : {};

  const { error } = await admin.from('app_settings').upsert({
    key: 'mailbox_test_results',
    value: { ...existing, [mailbox.id]: { ...result, checkedAt: new Date().toISOString() } },
  });
  if (error) throw new Error(`mailbox_test_results upsert failed: ${error.message}`);

  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: 'mailbox.test_connection',
      entity: 'mailboxes',
      entityId: mailbox.id,
      payload: { imapOk: result.imap.ok, smtpOk: result.smtp.ok },
    },
    admin,
  );
  revalidatePath('/einstellungen');
}

export async function schaltePostfach(id: string, active: boolean): Promise<void> {
  const userId = await requireUserId();
  const parsedId = uuidSchema.safeParse(id);
  if (!parsedId.success) {
    redirect('/einstellungen?fehler=unbekannt#postfaecher');
  }
  const nextActive = active === true;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('mailboxes')
    .update({ active: nextActive })
    .eq('id', parsedId.data)
    .select('id');
  if (error) throw new Error(`mailbox toggle failed: ${error.message}`);
  if (!data || data.length === 0) {
    redirect('/einstellungen?fehler=unbekannt#postfaecher');
  }

  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: nextActive ? 'mailbox.activate' : 'mailbox.deactivate',
      entity: 'mailboxes',
      entityId: parsedId.data,
    },
    admin,
  );
  revalidatePath('/einstellungen');
}

export async function loeschePostfach(id: string): Promise<void> {
  const userId = await requireUserId();
  const parsedId = uuidSchema.safeParse(id);
  if (!parsedId.success) {
    redirect('/einstellungen?fehler=unbekannt#postfaecher');
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('mailboxes')
    .delete()
    .eq('id', parsedId.data)
    .select('id, label');
  if (error) throw new Error(`mailbox delete failed: ${error.message}`);
  const deleted = data?.[0] as { id: string; label: string } | undefined;
  if (!deleted) {
    redirect('/einstellungen?fehler=unbekannt#postfaecher');
  }

  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: 'mailbox.delete',
      entity: 'mailboxes',
      entityId: deleted.id,
      payload: { label: deleted.label },
    },
    admin,
  );
  revalidatePath('/einstellungen');
}

const mailboxSchema = z.object({
  id: uuidSchema.optional(),
  label: z.string().trim().min(1),
  imap_host: z.string().trim().min(1),
  imap_port: z.coerce.number().int().min(1).max(65535),
  smtp_host: z.string().trim().min(1),
  smtp_port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  password: z.string().min(1).optional(),
  auto_reply_enabled: z.boolean(),
  active: z.boolean(),
});

export async function speicherePostfach(formData: FormData): Promise<void> {
  const userId = await requireUserId();

  const idRaw = formData.get('id');
  const passwordRaw = formData.get('password');
  const parsed = mailboxSchema.safeParse({
    id: typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : undefined,
    label: formData.get('label'),
    imap_host: formData.get('imap_host'),
    imap_port: formData.get('imap_port'),
    smtp_host: formData.get('smtp_host'),
    smtp_port: formData.get('smtp_port'),
    username: formData.get('username'),
    password: typeof passwordRaw === 'string' && passwordRaw.length > 0 ? passwordRaw : undefined,
    auto_reply_enabled: formData.get('auto_reply_enabled') === 'on',
    active: formData.get('active') === 'on',
  });
  if (!parsed.success) {
    redirect('/einstellungen?fehler=postfach#postfach-form');
  }
  const input = parsed.data;
  if (!input.id && !input.password) {
    redirect('/einstellungen?fehler=postfach_passwort#postfach-form');
  }

  const secretEncrypted = input.password
    ? encryptSecret(input.password, loadServerEnv().ENCRYPTION_KEY)
    : null;

  const base = {
    label: input.label,
    imap_host: input.imap_host,
    imap_port: input.imap_port,
    smtp_host: input.smtp_host,
    smtp_port: input.smtp_port,
    username: input.username,
    auto_reply_enabled: input.auto_reply_enabled,
    active: input.active,
  };

  const admin = createAdminClient();
  let mailboxId: string;
  if (input.id) {
    const { data, error } = await admin
      .from('mailboxes')
      .update(secretEncrypted ? { ...base, secret_encrypted: secretEncrypted } : base)
      .eq('id', input.id)
      .select('id');
    if (error) throw new Error(`mailbox update failed: ${error.message}`);
    if (!data || data.length === 0) {
      redirect('/einstellungen?fehler=unbekannt#postfaecher');
    }
    mailboxId = input.id;
  } else {
    const { data, error } = await admin
      .from('mailboxes')
      .insert({ ...base, secret_encrypted: secretEncrypted, auth_type: 'password' })
      .select('id')
      .single();
    if (error) throw new Error(`mailbox insert failed: ${error.message}`);
    mailboxId = String(data.id);
  }

  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: input.id ? 'mailbox.update' : 'mailbox.create',
      entity: 'mailboxes',
      entityId: mailboxId,
      payload: { ...base, passwordChanged: Boolean(secretEncrypted) },
    },
    admin,
  );
  revalidatePath('/einstellungen');
  // Drops a possibly active ?bearbeiten=… so the form resets after saving.
  redirect('/einstellungen#postfaecher');
}

// ---------------------------------------------------------------------------
// C) Form API keys
// ---------------------------------------------------------------------------

const formKeySchema = z.object({
  site_label: z.string().trim().min(1),
  allowed_origins: z.string().optional(),
});

export async function erzeugeFormKey(formData: FormData): Promise<void> {
  const userId = await requireUserId();

  const originsRaw = formData.get('allowed_origins');
  const parsed = formKeySchema.safeParse({
    site_label: formData.get('site_label'),
    allowed_origins: typeof originsRaw === 'string' ? originsRaw : undefined,
  });
  if (!parsed.success) {
    redirect('/einstellungen?fehler=form_key#form-keys');
  }

  const allowedOrigins = [
    ...new Set(
      (parsed.data.allowed_origins ?? '')
        .split(/[\n,]+/)
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  ];

  const { key, keyHash } = generateFormApiKey();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('form_api_keys')
    .insert({
      key_hash: keyHash,
      site_label: parsed.data.site_label,
      allowed_origins: allowedOrigins,
      active: true,
    })
    .select('id')
    .single();
  if (error) throw new Error(`form_api_keys insert failed: ${error.message}`);

  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: 'form_api_key.create',
      entity: 'form_api_keys',
      entityId: String(data.id),
      payload: { siteLabel: parsed.data.site_label, allowedOrigins },
    },
    admin,
  );
  revalidatePath('/einstellungen');
  // The clear-text key is shown exactly once via the query param (§10.1).
  redirect(`/einstellungen?neuer_key=${encodeURIComponent(key)}#form-keys`);
}

export async function schalteFormKey(id: string, active: boolean): Promise<void> {
  const userId = await requireUserId();
  const parsedId = uuidSchema.safeParse(id);
  if (!parsedId.success) {
    redirect('/einstellungen?fehler=unbekannt#form-keys');
  }
  const nextActive = active === true;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('form_api_keys')
    .update({ active: nextActive })
    .eq('id', parsedId.data)
    .select('id');
  if (error) throw new Error(`form_api_keys toggle failed: ${error.message}`);
  if (!data || data.length === 0) {
    redirect('/einstellungen?fehler=unbekannt#form-keys');
  }

  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: nextActive ? 'form_api_key.activate' : 'form_api_key.deactivate',
      entity: 'form_api_keys',
      entityId: parsedId.data,
    },
    admin,
  );
  revalidatePath('/einstellungen');
}

// ---------------------------------------------------------------------------
// D) Categories
// ---------------------------------------------------------------------------

export async function speichereKategorien(formData: FormData): Promise<void> {
  const userId = await requireUserId();

  const raw = formData.get('kategorien');
  const categories =
    typeof raw === 'string'
      ? [
          ...new Set(
            raw
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          ),
        ]
      : [];
  if (categories.length === 0) {
    redirect('/einstellungen?fehler=kategorien#kategorien');
  }

  const admin = createAdminClient();
  await setAppSetting('ticket_categories', categories, admin);
  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: 'settings.update_categories',
      entity: 'app_settings',
      entityId: 'ticket_categories',
      payload: { categories },
    },
    admin,
  );
  revalidatePath('/einstellungen');
}

// ---------------------------------------------------------------------------
// E) Auto-reply template
// ---------------------------------------------------------------------------

const autoReplySchema = z.object({
  subject: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

export async function speichereAutoReply(formData: FormData): Promise<void> {
  const userId = await requireUserId();

  const parsed = autoReplySchema.safeParse({
    subject: formData.get('subject'),
    body: formData.get('body'),
  });
  if (!parsed.success) {
    redirect('/einstellungen?fehler=autoreply#auto-reply');
  }

  const admin = createAdminClient();
  await setAppSetting('auto_reply_template', parsed.data, admin);
  await audit(
    {
      actorType: 'user',
      actorId: userId,
      action: 'settings.update_auto_reply',
      entity: 'app_settings',
      entityId: 'auto_reply_template',
      payload: parsed.data,
    },
    admin,
  );
  revalidatePath('/einstellungen');
}
