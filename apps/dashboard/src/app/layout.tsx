// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import './globals.css';

import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import type { ReactNode } from 'react';

import { modes } from '@ujira/ui';

import { AppShell } from '../shell/app-shell';
import { PREFERENCES_SCRIPT } from '../shell/preferences-script';

// Self-hosted at build time; latin-ext carries the Hausa, Yoruba and Igbo letters.
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600'],
  variable: '--ujira-font-inter',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500'],
  variable: '--ujira-font-jetbrains-mono',
  display: 'swap',
});

// JetBrains Mono draws no naira, cedi, peso or rupee sign. The second mono
// face that supplies them is not loaded here: nothing in the shell shows an
// amount yet, and fetching a third family at build time is what this app is
// moving away from. It arrives with the self hosted font work.
export const metadata: Metadata = {
  title: { default: 'UJIRA', template: '%s | UJIRA' },
  description: 'Mandates, payouts, approvals and receipts for your UJIRA projects.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: modes.light.bg },
    { media: '(prefers-color-scheme: dark)', color: modes.dark.bg },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The preferences script sets data-theme and data-rail before React loads.
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <Script id="ujira-preferences" strategy="beforeInteractive">
          {PREFERENCES_SCRIPT}
        </Script>
        <NuqsAdapter>
          <AppShell>{children}</AppShell>
        </NuqsAdapter>
      </body>
    </html>
  );
}
