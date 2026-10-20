import type { Metadata } from 'next';
import './globals.css';
import { AppShell } from '@/components/app-shell';

export const metadata: Metadata = {
  title: 'Memvora | Engineering memory',
  description:
    'Capture engineering investigations, preserve their evidence, and recover the steps later.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
