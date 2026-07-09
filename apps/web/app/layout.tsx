import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Zendori Bridge — Strong Energy',
  description: 'Multi-Channel-Intake-Bridge: Anfragen erfassen, qualifizieren, weiterleiten.',
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
