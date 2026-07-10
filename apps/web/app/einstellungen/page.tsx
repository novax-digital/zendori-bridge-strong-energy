import type { ReactNode } from 'react';

import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { loadServerEnv } from '@zendori/core';

import { getAppSettings } from '@/lib/db';
import { createClient } from '@/lib/supabase/server';

import {
  erzeugeFormKey,
  loeschePostfach,
  provisioniereProperties,
  pruefeHubSpot,
  schalteFormKey,
  schaltePostfach,
  speichereAutoReply,
  speichereKategorien,
  speicherePipeline,
  speicherePostfach,
  testePostfach,
} from './actions';

// secret_encrypted is column-revoked for dashboard users — select('*') would fail with 42501.
const MAILBOX_COLUMNS =
  'id, label, imap_host, imap_port, smtp_host, smtp_port, username, auth_type, ' +
  'auto_reply_enabled, active, last_poll_at, last_uid, created_at, updated_at';

interface MailboxListRow {
  id: string;
  label: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  auth_type: 'password' | 'oauth2';
  auto_reply_enabled: boolean;
  active: boolean;
  last_poll_at: string | null;
  last_uid: number | null;
  created_at: string;
  updated_at: string;
}

interface FormApiKeyRow {
  id: string;
  site_label: string;
  active: boolean;
  created_at: string;
  allowed_origins: string[] | null;
}

const healthSchema = z.object({ ok: z.boolean(), detail: z.string() });

const hubspotCacheSchema = z.object({
  checkedAt: z.string(),
  health: healthSchema,
  pipelines: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      stages: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
});

const provisionCacheSchema = z.object({
  checkedAt: z.string(),
  result: z.object({ created: z.array(z.string()), existing: z.array(z.string()) }).optional(),
  error: z.string().optional(),
});

const mailboxTestsSchema = z.record(
  z.string(),
  z.object({ checkedAt: z.string(), imap: healthSchema, smtp: healthSchema }),
);

function parseOrNull<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const FEHLERMELDUNGEN: Record<string, string> = {
  pipeline: 'Bitte eine gültige Kombination aus Pipeline und Stage auswählen.',
  postfach: 'Postfach-Eingaben ungültig. Bitte alle Pflichtfelder prüfen (Ports 1–65535).',
  postfach_passwort: 'Beim Anlegen eines Postfachs ist ein Passwort erforderlich.',
  unbekannt: 'Der Datensatz wurde nicht gefunden.',
  form_key: 'Bitte eine Site-Bezeichnung angeben.',
  kategorien: 'Bitte mindestens eine Kategorie angeben (eine pro Zeile).',
  autoreply: 'Betreff und Text der Auto-Reply-Vorlage dürfen nicht leer sein.',
};

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Berlin',
});

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormat.format(date);
}

function first(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const cardClass = 'rounded-lg border border-zinc-200 bg-white p-6 shadow-sm';
const labelClass = 'block text-sm font-medium text-zinc-700';
const inputClass =
  'mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none';
const buttonPrimary =
  'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700';
const buttonSecondary =
  'rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100';
const buttonDanger =
  'rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50';

const BADGE_TONES = {
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-800',
  zinc: 'bg-zinc-100 text-zinc-600',
} as const;

function Badge({ tone, children }: { tone: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export default async function EinstellungenPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    redirect('/login');
  }

  const params = await searchParams;
  const fehlerKey = first(params.fehler);
  const fehlermeldung =
    fehlerKey && Object.hasOwn(FEHLERMELDUNGEN, fehlerKey) ? FEHLERMELDUNGEN[fehlerKey] : undefined;
  // New form API key arrives via short-lived cookie (never via URL).
  const cookieStore = await cookies();
  const neuerKey = cookieStore.get('zendori_neuer_form_key')?.value ?? null;
  const bearbeitenId = first(params.bearbeiten);

  const [settings, mailboxesRes, apiKeysRes, cacheRes] = await Promise.all([
    getAppSettings(supabase),
    supabase.from('mailboxes').select(MAILBOX_COLUMNS).order('created_at', { ascending: true }),
    supabase
      .from('form_api_keys')
      .select('id, site_label, active, created_at, allowed_origins')
      .order('created_at', { ascending: false }),
    supabase
      .from('app_settings')
      .select('key, value')
      .in('key', ['hubspot_pipelines_cache', 'hubspot_provision_result', 'mailbox_test_results']),
  ]);
  if (mailboxesRes.error) throw new Error(`mailboxes read failed: ${mailboxesRes.error.message}`);
  if (apiKeysRes.error) throw new Error(`form_api_keys read failed: ${apiKeysRes.error.message}`);
  if (cacheRes.error) throw new Error(`app_settings read failed: ${cacheRes.error.message}`);

  const mailboxes = (mailboxesRes.data ?? []) as unknown as MailboxListRow[];
  const apiKeys = (apiKeysRes.data ?? []) as unknown as FormApiKeyRow[];

  const cache = new Map<string, unknown>(
    ((cacheRes.data ?? []) as { key: string; value: unknown }[]).map((row) => [row.key, row.value]),
  );
  const hubspotCache = parseOrNull(hubspotCacheSchema, cache.get('hubspot_pipelines_cache'));
  const provision = parseOrNull(provisionCacheSchema, cache.get('hubspot_provision_result'));
  const mailboxTests = parseOrNull(mailboxTestsSchema, cache.get('mailbox_test_results')) ?? {};

  const hubspotTokenSet = Boolean(loadServerEnv().HUBSPOT_TOKEN);
  const editMailbox = bearbeitenId
    ? (mailboxes.find((mailbox) => mailbox.id === bearbeitenId) ?? null)
    : null;
  const currentPipelineStage =
    settings.hubspot_pipeline_id && settings.hubspot_stage_id
      ? `${settings.hubspot_pipeline_id}|${settings.hubspot_stage_id}`
      : '';

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold text-zinc-900">Zendori Bridge</span>
          <span className="text-xs text-zinc-400">Einstellungen</span>
        </div>
        <Link href="/" className="text-xs font-medium text-zinc-600 hover:text-zinc-900">
          Zurück zum Posteingang
        </Link>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 p-6">
        {fehlermeldung ? (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {fehlermeldung}
          </p>
        ) : null}

        {/* A) HubSpot */}
        <section id="hubspot" className={cardClass}>
          <h2 className="text-base font-semibold text-zinc-900">HubSpot</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Verbindungsstatus, Ticket-Pipeline und Custom Properties.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-zinc-600">HUBSPOT_TOKEN:</span>
            <Badge tone={hubspotTokenSet ? 'green' : 'red'}>
              {hubspotTokenSet ? 'gesetzt' : 'nicht gesetzt'}
            </Badge>
          </div>

          <form action={pruefeHubSpot} className="mt-3">
            <button type="submit" className={buttonSecondary}>
              Verbindung prüfen &amp; Pipelines laden
            </button>
          </form>

          {hubspotCache ? (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={hubspotCache.health.ok ? 'green' : 'red'}>
                  {hubspotCache.health.ok ? 'Verbindung OK' : 'Verbindung fehlgeschlagen'}
                </Badge>
                <span className="break-all text-zinc-600">{hubspotCache.health.detail}</span>
                <span className="text-xs text-zinc-400">
                  Zuletzt geprüft: {formatDateTime(hubspotCache.checkedAt)}
                </span>
              </div>

              {hubspotCache.pipelines.length > 0 ? (
                <form action={speicherePipeline} className="mt-4 flex flex-wrap items-end gap-3">
                  <div className="w-full max-w-md">
                    <label htmlFor="pipeline_stage" className={labelClass}>
                      Ticket-Pipeline und Start-Stage
                    </label>
                    <select
                      id="pipeline_stage"
                      name="pipeline_stage"
                      required
                      defaultValue={currentPipelineStage}
                      className={inputClass}
                    >
                      <option value="">Bitte wählen …</option>
                      {hubspotCache.pipelines.map((pipeline) => (
                        <optgroup key={pipeline.id} label={pipeline.label}>
                          {pipeline.stages.map((stage) => (
                            <option key={stage.id} value={`${pipeline.id}|${stage.id}`}>
                              {stage.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <button type="submit" className={buttonPrimary}>
                    Pipeline speichern
                  </button>
                </form>
              ) : (
                <p className="mt-3 text-sm text-zinc-500">Keine Pipelines geladen.</p>
              )}
            </>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">
              Noch nicht geprüft. „Verbindung prüfen“ lädt Status und Pipelines.
            </p>
          )}

          <p className="mt-2 text-xs text-zinc-500">
            Aktuell konfiguriert:{' '}
            {settings.hubspot_pipeline_id && settings.hubspot_stage_id
              ? `Pipeline ${settings.hubspot_pipeline_id} · Stage ${settings.hubspot_stage_id}`
              : 'noch keine Auswahl gespeichert.'}
          </p>

          <div className="mt-6 border-t border-zinc-100 pt-4">
            <h3 className="text-sm font-semibold text-zinc-900">Ticket-Properties</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Legt die Custom Properties <code>zendori_source</code> und <code>zendori_ref</code> im
              HubSpot-Account an.
            </p>
            <form action={provisioniereProperties} className="mt-3">
              <button type="submit" className={buttonSecondary}>
                Properties anlegen / prüfen
              </button>
            </form>
            {provision ? (
              <div className="mt-3 space-y-1 text-sm">
                {provision.error ? (
                  <p className="text-red-700">Fehler: {provision.error}</p>
                ) : provision.result ? (
                  <>
                    <p className="text-zinc-700">
                      Angelegt:{' '}
                      {provision.result.created.length > 0
                        ? provision.result.created.join(', ')
                        : 'keine'}
                    </p>
                    <p className="text-zinc-700">
                      Bereits vorhanden:{' '}
                      {provision.result.existing.length > 0
                        ? provision.result.existing.join(', ')
                        : 'keine'}
                    </p>
                  </>
                ) : (
                  <p className="text-zinc-500">Ergebnis liegt in unbekanntem Format vor.</p>
                )}
                <p className="text-xs text-zinc-400">
                  Zuletzt ausgeführt: {formatDateTime(provision.checkedAt)}
                </p>
              </div>
            ) : null}
          </div>
        </section>

        {/* B) Mailboxes */}
        <section id="postfaecher" className={cardClass}>
          <h2 className="text-base font-semibold text-zinc-900">Postfächer</h2>
          <p className="mt-1 text-sm text-zinc-500">
            E-Mail-Konten für den Abruf (IMAP) und die Auto-Reply (SMTP). Zugangsdaten werden
            verschlüsselt gespeichert.
          </p>

          {mailboxes.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">Noch keine Postfächer angelegt.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[68rem] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                    <th className="py-2 pr-4 font-medium">Postfach</th>
                    <th className="py-2 pr-4 font-medium">IMAP</th>
                    <th className="py-2 pr-4 font-medium">SMTP</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Auto-Reply</th>
                    <th className="py-2 pr-4 font-medium">Letzter Abruf</th>
                    <th className="py-2 pr-4 font-medium">Verbindungstest</th>
                    <th className="py-2 font-medium">Aktionen</th>
                  </tr>
                </thead>
                <tbody>
                  {mailboxes.map((mailbox) => {
                    const test = mailboxTests[mailbox.id];
                    return (
                      <tr key={mailbox.id} className="border-b border-zinc-100 align-top">
                        <td className="py-3 pr-4">
                          <p className="font-medium text-zinc-900">{mailbox.label}</p>
                          <p className="text-xs text-zinc-500">
                            {mailbox.username} · {mailbox.auth_type}
                          </p>
                        </td>
                        <td className="py-3 pr-4 text-zinc-700">
                          {mailbox.imap_host}:{mailbox.imap_port}
                        </td>
                        <td className="py-3 pr-4 text-zinc-700">
                          {mailbox.smtp_host}:{mailbox.smtp_port}
                        </td>
                        <td className="py-3 pr-4">
                          <Badge tone={mailbox.active ? 'green' : 'zinc'}>
                            {mailbox.active ? 'Aktiv' : 'Inaktiv'}
                          </Badge>
                        </td>
                        <td className="py-3 pr-4">
                          <Badge tone={mailbox.auto_reply_enabled ? 'green' : 'zinc'}>
                            {mailbox.auto_reply_enabled ? 'An' : 'Aus'}
                          </Badge>
                        </td>
                        <td className="py-3 pr-4 text-zinc-700">
                          {formatDateTime(mailbox.last_poll_at)}
                        </td>
                        <td className="max-w-64 py-3 pr-4">
                          {test ? (
                            <div className="space-y-0.5 text-xs">
                              <p className={test.imap.ok ? 'text-green-700' : 'text-red-700'}>
                                IMAP: {test.imap.ok ? 'OK' : 'Fehler'} —{' '}
                                <span className="break-words">{test.imap.detail}</span>
                              </p>
                              <p className={test.smtp.ok ? 'text-green-700' : 'text-red-700'}>
                                SMTP: {test.smtp.ok ? 'OK' : 'Fehler'} —{' '}
                                <span className="break-words">{test.smtp.detail}</span>
                              </p>
                              <p className="text-zinc-400">
                                geprüft {formatDateTime(test.checkedAt)}
                              </p>
                            </div>
                          ) : (
                            <span className="text-xs text-zinc-400">—</span>
                          )}
                        </td>
                        <td className="py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <form action={testePostfach.bind(null, mailbox.id)}>
                              <button type="submit" className={buttonSecondary}>
                                Verbindung testen
                              </button>
                            </form>
                            <a
                              href={`/einstellungen?bearbeiten=${mailbox.id}#postfach-form`}
                              className={buttonSecondary}
                            >
                              Bearbeiten
                            </a>
                            <form action={schaltePostfach.bind(null, mailbox.id, !mailbox.active)}>
                              <button type="submit" className={buttonSecondary}>
                                {mailbox.active ? 'Deaktivieren' : 'Aktivieren'}
                              </button>
                            </form>
                            <form action={loeschePostfach.bind(null, mailbox.id)}>
                              <button type="submit" className={buttonDanger}>
                                Löschen
                              </button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div id="postfach-form" className="mt-6 border-t border-zinc-100 pt-4">
            <h3 className="text-sm font-semibold text-zinc-900">
              {editMailbox ? `Postfach bearbeiten: ${editMailbox.label}` : 'Postfach anlegen'}
            </h3>
            <form action={speicherePostfach} className="mt-3 space-y-4">
              {editMailbox ? <input type="hidden" name="id" value={editMailbox.id} /> : null}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label htmlFor="postfach-label" className={labelClass}>
                    Bezeichnung
                  </label>
                  <input
                    id="postfach-label"
                    name="label"
                    type="text"
                    required
                    defaultValue={editMailbox?.label ?? ''}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="postfach-username" className={labelClass}>
                    Benutzername
                  </label>
                  <input
                    id="postfach-username"
                    name="username"
                    type="text"
                    required
                    defaultValue={editMailbox?.username ?? ''}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="postfach-password" className={labelClass}>
                    Passwort
                  </label>
                  <input
                    id="postfach-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required={!editMailbox}
                    className={inputClass}
                  />
                  {editMailbox ? (
                    <p className="mt-1 text-xs text-zinc-500">
                      Leer lassen, um das gespeicherte Passwort zu behalten.
                    </p>
                  ) : null}
                </div>
                <div>
                  <label htmlFor="postfach-imap-host" className={labelClass}>
                    IMAP-Server
                  </label>
                  <input
                    id="postfach-imap-host"
                    name="imap_host"
                    type="text"
                    required
                    defaultValue={editMailbox?.imap_host ?? ''}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="postfach-imap-port" className={labelClass}>
                    IMAP-Port
                  </label>
                  <input
                    id="postfach-imap-port"
                    name="imap_port"
                    type="number"
                    min={1}
                    max={65535}
                    required
                    defaultValue={editMailbox?.imap_port ?? 993}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="postfach-smtp-host" className={labelClass}>
                    SMTP-Server
                  </label>
                  <input
                    id="postfach-smtp-host"
                    name="smtp_host"
                    type="text"
                    required
                    defaultValue={editMailbox?.smtp_host ?? ''}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="postfach-smtp-port" className={labelClass}>
                    SMTP-Port
                  </label>
                  <input
                    id="postfach-smtp-port"
                    name="smtp_port"
                    type="number"
                    min={1}
                    max={65535}
                    required
                    defaultValue={editMailbox?.smtp_port ?? 465}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="checkbox"
                    name="auto_reply_enabled"
                    defaultChecked={editMailbox?.auto_reply_enabled ?? false}
                    className="h-4 w-4 rounded border-zinc-300"
                  />
                  Auto-Reply aktiv
                </label>
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="checkbox"
                    name="active"
                    defaultChecked={editMailbox?.active ?? true}
                    className="h-4 w-4 rounded border-zinc-300"
                  />
                  Postfach aktiv (wird abgerufen)
                </label>
              </div>
              <div className="flex items-center gap-3">
                <button type="submit" className={buttonPrimary}>
                  Postfach speichern
                </button>
                {editMailbox ? (
                  <a
                    href="/einstellungen#postfaecher"
                    className="text-sm text-zinc-600 hover:text-zinc-900"
                  >
                    Abbrechen
                  </a>
                ) : null}
              </div>
            </form>
          </div>
        </section>

        {/* C) Form API keys */}
        <section id="form-keys" className={cardClass}>
          <h2 className="text-base font-semibold text-zinc-900">Formular-API-Keys</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Schlüssel für den Formular-Ingest der Kundenwebsites. Es wird nur ein Hash gespeichert.
          </p>

          {neuerKey ? (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">Neuer API-Schlüssel erstellt</p>
              <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-sm text-zinc-900">
                {neuerKey}
              </code>
              <p className="mt-1 text-xs text-amber-800">
                Jetzt kopieren — der Schlüssel wird nicht erneut angezeigt.
              </p>
            </div>
          ) : null}

          {apiKeys.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">Noch keine API-Keys erstellt.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                    <th className="py-2 pr-4 font-medium">Site</th>
                    <th className="py-2 pr-4 font-medium">Erlaubte Origins</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Erstellt</th>
                    <th className="py-2 font-medium">Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  {apiKeys.map((apiKey) => (
                    <tr key={apiKey.id} className="border-b border-zinc-100 align-top">
                      <td className="py-3 pr-4 font-medium text-zinc-900">{apiKey.site_label}</td>
                      <td className="max-w-80 break-words py-3 pr-4 text-zinc-700">
                        {(apiKey.allowed_origins ?? []).length > 0
                          ? (apiKey.allowed_origins ?? []).join(', ')
                          : '—'}
                      </td>
                      <td className="py-3 pr-4">
                        <Badge tone={apiKey.active ? 'green' : 'zinc'}>
                          {apiKey.active ? 'Aktiv' : 'Deaktiviert'}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4 text-zinc-700">
                        {formatDateTime(apiKey.created_at)}
                      </td>
                      <td className="py-3">
                        <form action={schalteFormKey.bind(null, apiKey.id, !apiKey.active)}>
                          <button
                            type="submit"
                            className={apiKey.active ? buttonDanger : buttonSecondary}
                          >
                            {apiKey.active ? 'Deaktivieren' : 'Aktivieren'}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-6 border-t border-zinc-100 pt-4">
            <h3 className="text-sm font-semibold text-zinc-900">Neuen Schlüssel erzeugen</h3>
            <form action={erzeugeFormKey} className="mt-3 max-w-md space-y-4">
              <div>
                <label htmlFor="key-site-label" className={labelClass}>
                  Site-Bezeichnung
                </label>
                <input
                  id="key-site-label"
                  name="site_label"
                  type="text"
                  required
                  placeholder="z. B. strongenergy.de"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="key-allowed-origins" className={labelClass}>
                  Erlaubte Origins
                </label>
                <textarea
                  id="key-allowed-origins"
                  name="allowed_origins"
                  rows={3}
                  placeholder={'https://www.strongenergy.de\nhttps://strongenergy.de'}
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-zinc-500">
                  Eine Origin pro Zeile oder durch Kommas getrennt (CORS-Freigabe).
                </p>
              </div>
              <button type="submit" className={buttonPrimary}>
                Schlüssel erzeugen
              </button>
            </form>
          </div>
        </section>

        {/* D) Categories */}
        <section id="kategorien" className={cardClass}>
          <h2 className="text-base font-semibold text-zinc-900">Kategorien</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Liste der Ticket-Kategorien für die KI-Klassifikation — eine Kategorie pro Zeile.
          </p>
          <form action={speichereKategorien} className="mt-4 max-w-md space-y-3">
            <textarea
              id="kategorien-liste"
              name="kategorien"
              rows={6}
              required
              aria-label="Kategorien, eine pro Zeile"
              defaultValue={settings.ticket_categories.join('\n')}
              className={inputClass}
            />
            <button type="submit" className={buttonPrimary}>
              Kategorien speichern
            </button>
          </form>
        </section>

        {/* E) Auto-reply template */}
        <section id="auto-reply" className={cardClass}>
          <h2 className="text-base font-semibold text-zinc-900">Auto-Reply-Vorlage</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Bestätigungsmail für eingehende E-Mails. Der Platzhalter <code>{'{{ticket_ref}}'}</code>{' '}
            wird durch die Ticket-Referenz ersetzt.
          </p>
          <form action={speichereAutoReply} className="mt-4 max-w-2xl space-y-4">
            <div>
              <label htmlFor="auto-reply-subject" className={labelClass}>
                Betreff
              </label>
              <input
                id="auto-reply-subject"
                name="subject"
                type="text"
                required
                defaultValue={settings.auto_reply_template.subject}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="auto-reply-body" className={labelClass}>
                Text
              </label>
              <textarea
                id="auto-reply-body"
                name="body"
                rows={8}
                required
                defaultValue={settings.auto_reply_template.body}
                className={inputClass}
              />
            </div>
            <button type="submit" className={buttonPrimary}>
              Vorlage speichern
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
