// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import './globals.css';

import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import Script from 'next/script';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import type { ReactNode } from 'react';

import { modes } from '@ujira/ui';

import { AppShell } from '../shell/app-shell';
import { PREFERENCES_SCRIPT } from '../shell/preferences-script';

// From packages the lockfile pins, never fetched at build time. A download gave the
// same commit different font files from one build to the next, and text then drew
// differently from the visual baselines at random. fonts.test.ts holds the bytes.
//
// next/font needs each call written out, with literal values, and a unicode range
// applies to a whole call, so each family takes two. latin-ext carries the Hausa,
// Yoruba and Igbo letters. Only the last in each stack has the metric fallback: latin
// text falls through to it while its own face loads, and one on the latin family
// would catch the letters latin-ext draws. globals.css puts the stacks together.
const interLatin = localFont({
  src: '../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  weight: '400 600',
  variable: '--ujira-font-inter-latin',
  display: 'swap',
  adjustFontFallback: false,
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    },
  ],
});

const interLatinExt = localFont({
  src: '../../node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2',
  weight: '400 600',
  variable: '--ujira-font-inter-latin-ext',
  display: 'swap',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
    },
  ],
});

const monoLatin = localFont({
  src: '../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  weight: '400 500',
  variable: '--ujira-font-jetbrains-mono-latin',
  display: 'swap',
  adjustFontFallback: false,
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    },
  ],
});

const monoLatinExt = localFont({
  src: '../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2',
  weight: '400 500',
  variable: '--ujira-font-jetbrains-mono-latin-ext',
  display: 'swap',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
    },
  ],
});

// JetBrains Mono draws no naira, cedi, peso or rupee sign. The second mono face that
// supplies them ships inside @ujira/ui, so it needs nothing here.
const FONT_VARIABLES = [interLatin, interLatinExt, monoLatin, monoLatinExt]
  .map((font) => font.variable)
  .join(' ');

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
    <html lang="en" className={FONT_VARIABLES} suppressHydrationWarning>
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
