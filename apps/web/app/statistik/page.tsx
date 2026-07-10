import Link from 'next/link';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';

/**
 * Statistik (Abrechnungsgrundlage): Nachrichtenvolumen pro Kanal/Status,
 * erstellte Tickets und KI-Token-Verbrauch pro Modell, monatsweise.
 * Aggregation läuft in SQL (get_statistics, Migration 0004) über den
 * User-Client — RLS gilt.
 */

interface Statistics {
  messages_total: number;
  by_channel: Array<{ channel: string; count: number }>;
  by_status: Array<{ status: string; count: number }>;
  tickets_created: number;
  ai: Array<{ model: string; calls: number; tokens_in: number; tokens_out: number }>;
}

const CHANNEL_LABELS: Record<string, string> = {
  form: 'Formular',
  email: 'E-Mail',
  paste: 'Notiz',
  phone: 'Telefon',
  whatsapp: 'WhatsApp',
};

const STATUS_LABELS: Record<string, string> = {
  received: 'Eingegangen',
  extracted: 'Extrahiert',
  needs_info: 'Braucht Info',
  ticket_created: 'Ticket erstellt',
  attached_to_existing: 'Angehängt',
  spam: 'Spam',
  failed: 'Fehlgeschlagen',
};

const monthFormat = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const numberFormat = new Intl.NumberFormat('de-DE');

function parseMonth(value: string | undefined): { year: number; month: number } {
  const match = value?.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) return { year, month };
  }
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function monthParam(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export default async function StatistikPage({
  searchParams,
}: {
  searchParams: Promise<{ monat?: string | string[] }>;
}) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims) {
    redirect('/login');
  }

  const params = await searchParams;
  const { year, month } = parseMonth(typeof params.monat === 'string' ? params.monat : undefined);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  const prev = month === 1 ? monthParam(year - 1, 12) : monthParam(year, month - 1);
  const next = month === 12 ? monthParam(year + 1, 1) : monthParam(year, month + 1);

  const { data, error } = await supabase.rpc('get_statistics', {
    from_ts: from.toISOString(),
    to_ts: to.toISOString(),
  });
  if (error) {
    throw new Error(`get_statistics failed: ${error.message}`);
  }
  const stats = data as Statistics;
  const totalTokens = stats.ai.reduce((sum, row) => sum + row.tokens_in + row.tokens_out, 0);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold text-zinc-900">Zendori Bridge</span>
          <span className="text-xs text-zinc-400">Statistik</span>
        </div>
        <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-900">
          Zurück zum Posteingang
        </Link>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-zinc-900">
            Statistik — {monthFormat.format(from)}
          </h1>
          <div className="flex items-center gap-2 text-xs">
            <Link
              href={`/statistik?monat=${prev}`}
              className="rounded-md border border-zinc-300 px-2.5 py-1 text-zinc-600 hover:bg-zinc-100"
            >
              ← Vormonat
            </Link>
            <Link
              href={`/statistik?monat=${next}`}
              className="rounded-md border border-zinc-300 px-2.5 py-1 text-zinc-600 hover:bg-zinc-100"
            >
              Folgemonat →
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Nachrichten" value={numberFormat.format(stats.messages_total)} />
          <StatCard label="Tickets erstellt" value={numberFormat.format(stats.tickets_created)} />
          <StatCard label="KI-Tokens gesamt" value={numberFormat.format(totalTokens)} />
        </div>

        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-zinc-900">Nachrichten pro Kanal</h2>
          {stats.by_channel.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">Keine Nachrichten in diesem Monat.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <tbody className="divide-y divide-zinc-100">
                {stats.by_channel.map((row) => (
                  <tr key={row.channel}>
                    <td className="py-1.5 text-zinc-700">
                      {CHANNEL_LABELS[row.channel] ?? row.channel}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-900">
                      {numberFormat.format(row.count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-zinc-900">Nachrichten nach Status</h2>
          {stats.by_status.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">Keine Nachrichten in diesem Monat.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <tbody className="divide-y divide-zinc-100">
                {stats.by_status.map((row) => (
                  <tr key={row.status}>
                    <td className="py-1.5 text-zinc-700">
                      {STATUS_LABELS[row.status] ?? row.status}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-900">
                      {numberFormat.format(row.count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-zinc-900">KI-Verbrauch pro Modell</h2>
          {stats.ai.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">Keine KI-Aufrufe in diesem Monat.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="pb-2 font-medium">Modell</th>
                  <th className="pb-2 text-right font-medium">Aufrufe</th>
                  <th className="pb-2 text-right font-medium">Input-Tokens</th>
                  <th className="pb-2 text-right font-medium">Output-Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {stats.ai.map((row) => (
                  <tr key={row.model}>
                    <td className="py-1.5 font-mono text-xs text-zinc-700">{row.model}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-900">
                      {numberFormat.format(row.calls)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-900">
                      {numberFormat.format(row.tokens_in)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-900">
                      {numberFormat.format(row.tokens_out)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-zinc-400">
            Grundlage für die transaktionale Abrechnung: Nachrichten- und Token-Zahlen je
            Kalendermonat (UTC). Modellpreise siehe Anthropic-Preisliste.
          </p>
        </section>
      </main>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{value}</p>
    </div>
  );
}
