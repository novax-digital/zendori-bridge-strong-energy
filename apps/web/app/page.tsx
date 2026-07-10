import Link from 'next/link';
import { redirect } from 'next/navigation';

import { MESSAGE_STATUSES, type Channel, type MessageStatus } from '@zendori/core';

import { AutoRefresh } from '@/components/auto-refresh';
import { CHANNEL_LABELS, STATUS_LABELS, StatusBadge } from '@/components/status-badge';
import { SubmitButton } from '@/components/submit-button';
import { signOut } from '@/lib/supabase/auth-actions';
import { createClient } from '@/lib/supabase/server';

interface InboxRow {
  id: string;
  channel: Channel;
  status: MessageStatus;
  subject: string | null;
  sender_name: string | null;
  sender_email: string | null;
  received_at: string;
  correlation_id: string;
}

const receivedAtFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Berlin',
});

/**
 * Posteingang (§11). The proxy already gates unauthenticated requests;
 * this second check is defense in depth per Supabase guidance.
 */
export default async function PosteingangPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    redirect('/login');
  }

  const userEmail = typeof data.claims.email === 'string' ? data.claims.email : null;

  const { status } = await searchParams;
  const statusFilter =
    typeof status === 'string' && (MESSAGE_STATUSES as readonly string[]).includes(status)
      ? (status as MessageStatus)
      : null;

  let query = supabase
    .from('inbound_messages')
    .select('id, channel, status, subject, sender_name, sender_email, received_at, correlation_id')
    .order('received_at', { ascending: false })
    .limit(50);
  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }
  const { data: messages, error } = await query;
  if (error) {
    throw new Error(`loading inbound messages failed: ${error.message}`);
  }
  const rows = (messages ?? []) as InboxRow[];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3">
        <div className="flex items-baseline gap-6">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-semibold text-zinc-900">Zendori Bridge</span>
            <span className="text-xs text-zinc-400">Strong Energy</span>
          </div>
          <nav className="flex items-center gap-4 text-xs">
            <Link href="/" className="font-medium text-zinc-900">
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

      <main className="mx-auto w-full max-w-5xl flex-1 p-6">
        <h1 className="text-lg font-semibold text-zinc-900">Posteingang</h1>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <FilterChip href="/" active={statusFilter === null} label="Alle" />
          {MESSAGE_STATUSES.map((s) => (
            <FilterChip
              key={s}
              href={`/?status=${s}`}
              active={statusFilter === s}
              label={STATUS_LABELS[s]}
            />
          ))}
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          {rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-zinc-500">
              {statusFilter
                ? `Keine Nachrichten mit Status „${STATUS_LABELS[statusFilter]}“.`
                : 'Noch keine Nachrichten eingegangen.'}
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {rows.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/nachricht/${m.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-50"
                  >
                    <span className="w-20 shrink-0 rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-center text-[11px] text-zinc-600">
                      {CHANNEL_LABELS[m.channel]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">
                      {m.subject || '(ohne Betreff)'}
                    </span>
                    <span className="hidden w-44 shrink-0 truncate text-xs text-zinc-500 sm:block">
                      {m.sender_name || m.sender_email || '—'}
                    </span>
                    <span className="w-28 shrink-0 text-right text-xs tabular-nums text-zinc-500">
                      {receivedAtFormat.format(new Date(m.received_at))}
                    </span>
                    <StatusBadge status={m.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="mt-2 text-xs text-zinc-400">
          {rows.length} {rows.length === 1 ? 'Nachricht' : 'Nachrichten'} (max. 50) — Ansicht
          aktualisiert sich alle 10 Sekunden.
        </p>
      </main>

      <AutoRefresh seconds={10} />
    </div>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={
        active
          ? 'rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white'
          : 'rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100'
      }
    >
      {label}
    </Link>
  );
}
