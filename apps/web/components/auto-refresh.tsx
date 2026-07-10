'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-fetches the server component data every `seconds` (Posteingang live update). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);

  return null;
}
