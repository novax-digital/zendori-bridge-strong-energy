'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { createClient } from '@/lib/supabase/server';

const credentialsSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

export async function signIn(formData: FormData): Promise<void> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    redirect('/login?fehler=eingabe');
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    redirect('/login?fehler=anmeldung');
  }

  redirect('/');
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  // scope 'local' clears the session cookies even when the token-revoke
  // endpoint is unreachable — a plain signOut() can silently keep the session.
  await supabase.auth.signOut({ scope: 'local' });
  redirect('/login');
}
