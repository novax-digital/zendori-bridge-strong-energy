import { redirect } from 'next/navigation';

import { signIn } from '@/lib/supabase/auth-actions';
import { createClient } from '@/lib/supabase/server';

const FEHLERMELDUNGEN: Record<string, string> = {
  eingabe: 'Bitte E-Mail-Adresse und Passwort eingeben.',
  anmeldung: 'Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen.',
};

export default async function LoginPage({
  searchParams,
}: {
  // Next delivers arrays for repeated query params — handle both shapes.
  searchParams: Promise<{ fehler?: string | string[] }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) {
    redirect('/');
  }

  const { fehler } = await searchParams;
  // Object.hasOwn guards against prototype keys (?fehler=constructor would
  // otherwise resolve to a function and crash the render).
  const fehlerKey = typeof fehler === 'string' ? fehler : undefined;
  const fehlermeldung =
    fehlerKey && Object.hasOwn(FEHLERMELDUNGEN, fehlerKey) ? FEHLERMELDUNGEN[fehlerKey] : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-zinc-900">Zendori Bridge</h1>
        <p className="mt-1 text-sm text-zinc-500">Anmeldung — Zugang nur auf Einladung.</p>

        {fehlermeldung ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {fehlermeldung}
          </p>
        ) : null}

        <form action={signIn} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-zinc-700">
              E-Mail-Adresse
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-zinc-700">
              Passwort
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Anmelden
          </button>
        </form>
      </div>
    </main>
  );
}
