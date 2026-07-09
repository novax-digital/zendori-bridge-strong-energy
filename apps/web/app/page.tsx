import { redirect } from 'next/navigation';

import { signOut } from '@/lib/supabase/auth-actions';
import { createClient } from '@/lib/supabase/server';

/**
 * Posteingang (placeholder). The proxy already gates unauthenticated requests;
 * this second check is defense in depth per Supabase guidance.
 */
export default async function PosteingangPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    redirect('/login');
  }

  const userEmail = typeof data.claims.email === 'string' ? data.claims.email : null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold text-zinc-900">Zendori Bridge</span>
          <span className="text-xs text-zinc-400">Strong Energy</span>
        </div>
        <div className="flex items-center gap-4">
          {userEmail ? <span className="text-xs text-zinc-500">{userEmail}</span> : null}
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
            >
              Abmelden
            </button>
          </form>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-zinc-900">Posteingang</h1>
          <p className="mt-2 text-sm text-zinc-500">
            Noch keine Kanäle angebunden. Formular- und E-Mail-Ingest, KI-Extraktion und die
            HubSpot-Anbindung folgen in Phase 1.
          </p>
        </div>
      </main>
    </div>
  );
}
