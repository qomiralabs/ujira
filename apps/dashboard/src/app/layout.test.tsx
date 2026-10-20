// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modes } from '@ujira/ui';
import { describe, expect, it, vi } from 'vitest';

import { PREFERENCES_SCRIPT } from '../shell/preferences-script';
import RootLayout, { metadata, viewport } from './layout';

vi.mock('next/font/google', () => ({
  Inter: (options: { variable: string }) => ({ variable: `font${options.variable}` }),
  JetBrains_Mono: (options: { variable: string }) => ({ variable: `font${options.variable}` }),
  Noto_Sans_Mono: (options: { variable: string }) => ({ variable: `font${options.variable}` }),
}));
vi.mock('next/script', () => ({
  default: ({ id, children }: { id: string; children: string }) => (
    <script id={id} dangerouslySetInnerHTML={{ __html: children }} />
  ),
}));
vi.mock('nuqs/adapters/next/app', () => ({
  NuqsAdapter: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

describe('RootLayout', () => {
  const html = renderToStaticMarkup(
    <RootLayout>
      <p>Page body</p>
    </RootLayout>,
  );

  it('puts the font variables the tokens read on the root element', () => {
    // Noto Sans Mono is there only to supply the naira, cedi, peso and rupee
    // signs, which JetBrains Mono does not draw.
    expect(html).toMatch(
      /^<html lang="en" class="font--ujira-font-inter font--ujira-font-jetbrains-mono font--ujira-font-noto-sans-mono">/,
    );
  });

  it('applies stored preferences before the frame renders', () => {
    expect(html).toContain(`<script id="ujira-preferences">${PREFERENCES_SCRIPT}</script>`);
    expect(html.indexOf('ujira-preferences')).toBeLessThan(html.indexOf('<aside'));
  });

  it('renders the page inside the frame', () => {
    expect(html).toMatch(/<main id="main"[^>]*><p>Page body<\/p><\/main>/);
  });

  it('keeps the dashboard out of search engines and colours the browser chrome from the tokens', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(viewport.themeColor).toEqual([
      { media: '(prefers-color-scheme: light)', color: modes.light.bg },
      { media: '(prefers-color-scheme: dark)', color: modes.dark.bg },
    ]);
  });
});
