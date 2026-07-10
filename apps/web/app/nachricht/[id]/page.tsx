import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type {
  AttachmentRef,
  Channel,
  MessageStatus,
  TicketExtraction,
  TicketPriority,
} from '@zendori/core';

import { AutoRefresh } from '@/components/auto-refresh';
import { CHANNEL_LABELS, PRIORITY_LABELS, StatusBadge } from '@/components/status-badge';
import { SubmitButton } from '@/components/submit-button';
import { signOut } from '@/lib/supabase/auth-actions';
import { createClient } from '@/lib/supabase/server';

import { markAsSpam, reprocessMessage } from './actions';

interface MessageRow {
  id: string;
  channel: Channel;
  external_id: string;
  sender_name: string | null;
  sender_email: string | null;
  sender_phone: string | null;
  subject: string | null;
  body_text: string | null;
  attachments: AttachmentRef[];
  raw: unknown;
  received_at: string;
  status: MessageStatus;
  error: string | null;
  correlation_id: string;
}

interface ExtractionRow {
  id: string;
  model: string;
  schema_version: string;
  data: TicketExtraction;
  confidence: number | null;
  missing_fields: string[];
  questions: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}

interface DedupRow {
  id: string;
  decision: string;
  confidence: number | null;
  reason: string | null;
  model: string | null;
  created_at: string;
}

interface TicketRow {
  ticket_ref: string;
  hubspot_ticket_id: string | null;
  category: string;
  priority: string;
}

const DEDUP_LABELS: Record<string, string> = {
  new: 'Neu',
  duplicate: 'Duplikat',
  follow_up: 'Folgenachricht',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const receivedAtFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Berlin',
});

export default async function NachrichtDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims) {
    redirect('/login');
  }
  const userEmail = typeof auth.claims.email === 'string' ? auth.claims.email : null;

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    notFound();
  }

  const [messageRes, extractionsRes, dedupRes, ticketRes] = await Promise.all([
    supabase.from('inbound_messages').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('extractions')
      .select(
        'id, model, schema_version, data, confidence, missing_fields, questions, tokens_in, tokens_out, created_at',
      )
      .eq('message_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('dedup_decisions')
      .select('id, decision, confidence, reason, model, created_at')
      .eq('message_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('tickets')
      .select('ticket_ref, hubspot_ticket_id, category, priority')
      .eq('first_message_id', id)
      .maybeSingle(),
  ]);

  if (messageRes.error) {
    throw new Error(`loading message failed: ${messageRes.error.message}`);
  }
  if (!messageRes.data) {
    notFound();
  }
  const message = messageRes.data as MessageRow;
  const extractions = (extractionsRes.data ?? []) as ExtractionRow[];
  const dedupDecisions = (dedupRes.data ?? []) as DedupRow[];
  const ticket = (ticketRes.data as TicketRow | null) ?? null;

  // "Was wurde an HubSpot übermittelt": audit entry of the deliver step +
  // deep link built from portal info captured during the connection test.
  interface DeliveryInfo {
    created_at: string;
    payload: {
      hubspotTicketId?: string | null;
      submitted?: Record<string, string | null>;
    } | null;
  }
  let delivery: DeliveryInfo | null = null;
  let hubspotLink: string | null = null;
  if (ticket) {
    const { data: auditRow } = await supabase
      .from('audit_log')
      .select('created_at, payload')
      .eq('action', 'ticket_created')
      .eq('entity', 'ticket')
      .eq('entity_id', ticket.ticket_ref)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    delivery = (auditRow as DeliveryInfo | null) ?? null;
    if (ticket.hubspot_ticket_id) {
      const { data: cacheRow } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'hubspot_pipelines_cache')
        .maybeSingle();
      const health = (
        cacheRow?.value as { health?: { portalId?: number; uiDomain?: string } } | null
      )?.health;
      if (health?.portalId && health?.uiDomain) {
        hubspotLink = `https://${health.uiDomain}/contacts/${health.portalId}/ticket/${ticket.hubspot_ticket_id}`;
      }
    }
  }

  const latest = extractions[0] ?? null;
  const questions =
    latest && Array.isArray(latest.questions)
      ? latest.questions.filter((q): q is string => typeof q === 'string')
      : [];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3">
        <div className="flex items-baseline gap-6">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-semibold text-zinc-900">Zendori Bridge</span>
            <span className="text-xs text-zinc-400">Strong Energy</span>
          </div>
          <nav className="flex items-center gap-4 text-xs">
            <Link href="/" className="text-zinc-500 hover:text-zinc-900">
              Posteingang
            </Link>
            <Link href="/paste" className="text-zinc-500 hover:text-zinc-900">
              Nachricht einfügen
            </Link>
            <Link href="/einstellungen" className="text-zinc-500 hover:text-zinc-900">
              Einstellungen
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          {userEmail ? <span className="text-xs text-zinc-500">{userEmail}</span> : null}
          <form action={signOut}>
            <SubmitButton variant="secondary">Abmelden</SubmitButton>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 p-6">
        <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-900">
          ← Zurück zum Posteingang
        </Link>

        {/* Kopf */}
        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-base font-semibold text-zinc-900">
              {message.subject || '(ohne Betreff)'}
            </h1>
            <StatusBadge status={message.status} />
          </div>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <DetailItem label="Kanal" value={CHANNEL_LABELS[message.channel]} />
            <DetailItem
              label="Empfangen"
              value={`${receivedAtFormat.format(new Date(message.received_at))} Uhr`}
            />
            <DetailItem
              label="Absender"
              value={
                [message.sender_name, message.sender_email, message.sender_phone]
                  .filter(Boolean)
                  .join(' · ') || '—'
              }
            />
            <div>
              <dt className="text-xs text-zinc-500">Correlation-ID</dt>
              <dd className="font-mono text-xs text-zinc-700">{message.correlation_id}</dd>
            </div>
          </dl>
          {message.status === 'failed' && message.error ? (
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {message.error}
            </p>
          ) : null}
        </section>

        {/* Extraktion */}
        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-zinc-900">Extraktion</h2>
          {!latest ? (
            <p className="mt-2 text-sm text-zinc-500">Noch keine Extraktion vorhanden.</p>
          ) : (
            <>
              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <DetailItem label="Kategorie" value={latest.data.ticket.category} />
                <DetailItem
                  label="Priorität"
                  value={`${PRIORITY_LABELS[latest.data.ticket.priority]} — ${latest.data.ticket.priority_reason}`}
                />
                <DetailItem label="Sprache" value={latest.data.ticket.language} />
                <DetailItem
                  label="Konfidenz"
                  value={
                    latest.confidence !== null ? `${Math.round(latest.confidence * 100)} %` : '—'
                  }
                />
                <div className="sm:col-span-2">
                  <dt className="text-xs text-zinc-500">Zusammenfassung</dt>
                  <dd className="text-sm text-zinc-800">{latest.data.meta.summary}</dd>
                </div>
              </dl>

              {latest.missing_fields.length > 0 ? (
                <div className="mt-3">
                  <p className="text-xs text-zinc-500">Fehlende Angaben</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {latest.missing_fields.map((field) => (
                      <span
                        key={field}
                        className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800"
                      >
                        {field}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {questions.length > 0 ? (
                <div className="mt-3">
                  <p className="text-xs text-zinc-500">Rückfragen der KI</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-zinc-800">
                    {questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <p className="mt-3 text-xs text-zinc-400">
                Modell {latest.model} · Schema v{latest.schema_version} · Tokens{' '}
                {latest.tokens_in ?? 0} / {latest.tokens_out ?? 0}
              </p>
            </>
          )}
        </section>

        {/* Ticket */}
        {ticket ? (
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-zinc-900">Ticket</h2>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-zinc-500">Referenz</dt>
                <dd className="font-mono text-sm text-zinc-800">{ticket.ticket_ref}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">HubSpot-Ticket-ID</dt>
                <dd className="font-mono text-sm text-zinc-800">
                  {ticket.hubspot_ticket_id ?? '—'}
                </dd>
              </div>
              <DetailItem label="Kategorie" value={ticket.category} />
              <DetailItem
                label="Priorität"
                value={PRIORITY_LABELS[ticket.priority as TicketPriority] ?? ticket.priority}
              />
              {delivery ? (
                <div>
                  <dt className="text-xs text-zinc-500">An HubSpot übermittelt</dt>
                  <dd className="text-sm text-zinc-800">
                    {receivedAtFormat.format(new Date(delivery.created_at))}
                  </dd>
                </div>
              ) : null}
              {delivery?.payload?.submitted ? (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-zinc-500">Übermittelte Felder</dt>
                  <dd className="mt-1 font-mono text-xs text-zinc-700">
                    {Object.entries(delivery.payload.submitted)
                      .filter(([, v]) => v)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' · ')}
                  </dd>
                </div>
              ) : null}
            </dl>
            {hubspotLink ? (
              <a
                href={hubspotLink}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
              >
                Ticket in HubSpot öffnen ↗
              </a>
            ) : null}
          </section>
        ) : null}

        {/* Dedup */}
        {dedupDecisions.length > 0 ? (
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-zinc-900">Dedup-Prüfung</h2>
            <ul className="mt-3 space-y-2">
              {dedupDecisions.map((d) => (
                <li key={d.id} className="text-sm text-zinc-800">
                  <span className="font-medium">{DEDUP_LABELS[d.decision] ?? d.decision}</span>
                  {d.confidence !== null ? (
                    <span className="text-zinc-500"> ({Math.round(d.confidence * 100)} %)</span>
                  ) : null}
                  {d.reason ? <span className="text-zinc-500"> — {d.reason}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Anhänge */}
        {message.attachments.length > 0 ? (
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-zinc-900">Anhänge</h2>
            <ul className="mt-3 space-y-1 text-sm text-zinc-800">
              {message.attachments.map((a) => (
                <li key={a.storagePath}>
                  {a.filename}{' '}
                  <span className="text-xs text-zinc-500">
                    ({Math.max(1, Math.round(a.sizeBytes / 1024))} KB)
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-zinc-400">Signierte Downloads folgen.</p>
          </section>
        ) : null}

        {/* Nachrichtentext */}
        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-zinc-900">Nachrichtentext</h2>
          <div className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-sm text-zinc-800">
            {message.body_text || '(kein Text)'}
          </div>
        </section>

        {/* Rohdaten */}
        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-zinc-900">
              Rohdaten
            </summary>
            <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-zinc-50 p-3 text-xs text-zinc-700">
              {JSON.stringify(message.raw, null, 2)}
            </pre>
          </details>
        </section>

        {/* Aktionen */}
        <div className="flex items-center gap-3">
          <form action={reprocessMessage.bind(null, message.id)}>
            <SubmitButton variant="primary" pendingText="Wird neu gestartet …">
              Erneut verarbeiten
            </SubmitButton>
          </form>
          {message.status !== 'spam' ? (
            <form action={markAsSpam.bind(null, message.id)}>
              <SubmitButton variant="secondary">Als Spam markieren</SubmitButton>
            </form>
          ) : null}
        </div>
      </main>

      <AutoRefresh seconds={10} />
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="text-sm text-zinc-800">{value}</dd>
    </div>
  );
}
