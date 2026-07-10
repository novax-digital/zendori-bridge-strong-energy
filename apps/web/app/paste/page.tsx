import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import {
  TICKET_PRIORITIES,
  type Channel,
  type MessageStatus,
  type TicketExtraction,
} from '@zendori/core';

import { PRIORITY_LABELS } from '@/components/status-badge';
import { SubmitButton } from '@/components/submit-button';
import { getAppSettings } from '@/lib/db';
import { signOut } from '@/lib/supabase/auth-actions';
import { createClient } from '@/lib/supabase/server';

import { analysePaste, createTicketFromPaste, discardPaste } from './actions';

const FEHLERMELDUNGEN: Record<string, string> = {
  eingabe: 'Eingaben unvollständig oder ungültig. Bitte prüfen.',
  extraktion:
    'Die KI-Analyse ist fehlgeschlagen. Der Originaltext wurde in die Beschreibung übernommen — bitte Felder manuell ausfüllen.',
  kontakt: 'Bitte mindestens E-Mail-Adresse oder Telefonnummer angeben.',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MessageRow {
  id: string;
  channel: Channel;
  subject: string | null;
  body_text: string | null;
  status: MessageStatus;
}

export default async function PastePage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string | string[]; fehler?: string | string[] }>;
}) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims) {
    redirect('/login');
  }
  const userEmail = typeof auth.claims.email === 'string' ? auth.claims.email : null;

  const params = await searchParams;
  const msgId = typeof params.msg === 'string' ? params.msg : undefined;
  const fehlerKey = typeof params.fehler === 'string' ? params.fehler : undefined;
  const fehlermeldung =
    fehlerKey && Object.hasOwn(FEHLERMELDUNGEN, fehlerKey) ? FEHLERMELDUNGEN[fehlerKey] : undefined;

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
            <Link href="/paste" className="font-medium text-zinc-900">
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

      <main className="mx-auto w-full max-w-3xl flex-1 p-6">
        {msgId ? (
          <Preview msgId={msgId} fehlerKey={fehlerKey} fehlermeldung={fehlermeldung} />
        ) : (
          <InputForm fehlermeldung={fehlermeldung} />
        )}
      </main>
    </div>
  );
}

function InputForm({ fehlermeldung }: { fehlermeldung?: string }) {
  return (
    <>
      <h1 className="text-lg font-semibold text-zinc-900">Nachricht einfügen</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Beliebigen kopierten Text (E-Mail, Chatverlauf, Telefonnotiz) einfügen — die KI erstellt
        daraus einen Ticket-Entwurf zur Prüfung.
      </p>

      {fehlermeldung ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {fehlermeldung}
        </p>
      ) : null}

      <form
        action={analysePaste}
        className="mt-4 space-y-4 rounded-lg border border-zinc-200 bg-white p-6"
      >
        <div>
          <label htmlFor="text" className="block text-sm font-medium text-zinc-700">
            Nachrichtentext
          </label>
          <textarea
            id="text"
            name="text"
            required
            rows={12}
            placeholder="Kopierten Text hier einfügen …"
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="kontext" className="block text-sm font-medium text-zinc-700">
            Kontext (optional)
          </label>
          <input
            id="kontext"
            name="kontext"
            type="text"
            placeholder="z. B. „Anruf von heute Vormittag, Kunde klang verärgert“"
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
        </div>
        <SubmitButton variant="primary" pendingText="Analysiere …">
          Analysieren
        </SubmitButton>
      </form>
    </>
  );
}

async function Preview({
  msgId,
  fehlerKey,
  fehlermeldung,
}: {
  msgId: string;
  fehlerKey?: string;
  fehlermeldung?: string;
}) {
  if (!UUID_PATTERN.test(msgId)) {
    notFound();
  }

  const supabase = await createClient();
  const [messageRes, extractionRes, settings] = await Promise.all([
    supabase
      .from('inbound_messages')
      .select('id, channel, subject, body_text, status')
      .eq('id', msgId)
      .maybeSingle(),
    supabase
      .from('extractions')
      .select('data, missing_fields, questions')
      .eq('message_id', msgId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    getAppSettings(supabase),
  ]);

  if (messageRes.error) {
    throw new Error(`loading paste message failed: ${messageRes.error.message}`);
  }
  if (!messageRes.data) {
    notFound();
  }
  const message = messageRes.data as MessageRow;
  if (message.channel !== 'paste') {
    notFound();
  }

  const extraction = extractionRes.data ? (extractionRes.data.data as TicketExtraction) : null;
  const missingFields: string[] = extractionRes.data?.missing_fields ?? [];
  const missing = new Set(missingFields);
  const questions: string[] = Array.isArray(extractionRes.data?.questions)
    ? extractionRes.data.questions.filter((q: unknown): q is string => typeof q === 'string')
    : [];

  const missingFor = (field: string): boolean => {
    if (missing.has(field)) return true;
    // The model reports an unclear request as e.g. "anliegen_unklar" (§7 prompt).
    if (field === 'description') {
      return missingFields.some((m) => m.includes('anliegen'));
    }
    return false;
  };

  const fallbackCategory = settings.ticket_categories[settings.ticket_categories.length - 1] ?? '';
  const prefill = {
    subject: extraction?.ticket.subject ?? message.subject ?? '',
    description: extraction?.ticket.description ?? message.body_text ?? '',
    category: extraction?.ticket.category ?? fallbackCategory,
    priority: extraction?.ticket.priority ?? 'normal',
    email: extraction?.contact.email ?? '',
    phone: extraction?.contact.phone ?? '',
    name: extraction?.contact.name ?? '',
    company: extraction?.contact.company ?? '',
  };
  const categories = settings.ticket_categories.includes(prefill.category)
    ? settings.ticket_categories
    : [prefill.category, ...settings.ticket_categories].filter(Boolean);

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-zinc-900">Ticket-Entwurf prüfen</h1>
        <Link
          href={`/nachricht/${message.id}`}
          className="text-xs text-zinc-500 hover:text-zinc-900"
        >
          Zur Detailansicht →
        </Link>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Entwurf prüfen und ergänzen — erst „Ticket erstellen“ übergibt die Anfrage an HubSpot.
      </p>

      {fehlermeldung ? (
        <p
          role="alert"
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            fehlerKey === 'extraktion'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          {fehlermeldung}
        </p>
      ) : null}

      {questions.length > 0 ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-800">Die KI hat Rückfragen:</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-800">
            {questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        action={createTicketFromPaste}
        className="mt-4 space-y-4 rounded-lg border border-zinc-200 bg-white p-6"
      >
        <input type="hidden" name="messageId" value={message.id} />

        <div>
          <label htmlFor="subject" className="block text-sm font-medium text-zinc-700">
            Betreff
          </label>
          <input
            id="subject"
            name="subject"
            type="text"
            required
            maxLength={80}
            defaultValue={prefill.subject}
            className={fieldClasses(missingFor('subject'))}
          />
          {missingFor('subject') ? <MissingHint /> : null}
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium text-zinc-700">
            Beschreibung
          </label>
          <textarea
            id="description"
            name="description"
            required
            rows={8}
            defaultValue={prefill.description}
            className={fieldClasses(missingFor('description'))}
          />
          {missingFor('description') ? <MissingHint /> : null}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="category" className="block text-sm font-medium text-zinc-700">
              Kategorie
            </label>
            <select
              id="category"
              name="category"
              defaultValue={prefill.category}
              className={fieldClasses(false)}
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="priority" className="block text-sm font-medium text-zinc-700">
              Priorität
            </label>
            <select
              id="priority"
              name="priority"
              defaultValue={prefill.priority}
              className={fieldClasses(false)}
            >
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-zinc-700">
              E-Mail-Adresse
            </label>
            <input
              id="email"
              name="email"
              type="email"
              defaultValue={prefill.email}
              className={fieldClasses(missingFor('email'))}
            />
            {missingFor('email') ? <MissingHint /> : null}
          </div>
          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-zinc-700">
              Telefon
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              defaultValue={prefill.phone}
              className={fieldClasses(missingFor('phone'))}
            />
            {missingFor('phone') ? <MissingHint /> : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-zinc-700">
              Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              defaultValue={prefill.name}
              className={fieldClasses(missingFor('name'))}
            />
            {missingFor('name') ? <MissingHint /> : null}
          </div>
          <div>
            <label htmlFor="company" className="block text-sm font-medium text-zinc-700">
              Firma
            </label>
            <input
              id="company"
              name="company"
              type="text"
              defaultValue={prefill.company}
              className={fieldClasses(missingFor('company'))}
            />
            {missingFor('company') ? <MissingHint /> : null}
          </div>
        </div>

        <p className="text-xs text-zinc-400">
          Mindestens ein Kontaktweg (E-Mail oder Telefon) ist erforderlich.
        </p>

        <div className="flex items-center gap-3">
          <SubmitButton variant="primary" pendingText="Erstelle Ticket …">
            Ticket erstellen
          </SubmitButton>
          <SubmitButton variant="secondary" formAction={discardPaste} formNoValidate>
            Verwerfen
          </SubmitButton>
        </div>
      </form>

      {message.body_text ? (
        <details className="mt-4 rounded-lg border border-zinc-200 bg-white p-5">
          <summary className="cursor-pointer text-sm font-semibold text-zinc-900">
            Originaltext anzeigen
          </summary>
          <div className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-sm text-zinc-800">
            {message.body_text}
          </div>
        </details>
      ) : null}
    </>
  );
}

function fieldClasses(missing: boolean): string {
  const base = 'mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none';
  return missing
    ? `${base} border-amber-400 ring-2 ring-amber-200 focus:border-amber-500`
    : `${base} border-zinc-300 focus:border-zinc-500`;
}

function MissingHint() {
  return <p className="mt-1 text-xs text-amber-700">Fehlende Angabe — bitte ergänzen.</p>;
}
