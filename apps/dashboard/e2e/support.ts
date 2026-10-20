// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, type Page } from '@playwright/test';

export const WIDTHS = [375, 768, 1440] as const;
export const SCHEMES = ['light', 'dark'] as const;

export const SECTIONS = [
  '/',
  '/payouts',
  '/approvals',
  '/mandates',
  '/recipients',
  '/receipts',
  '/funding',
  '/corridors',
  '/developers',
  '/settings',
] as const;

/** Collects console errors and warnings, which must stay at zero. */
export function watchConsole(page: Page): string[] {
  const messages: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      messages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  return messages;
}

/**
 * Waits for the self-hosted fonts and for React to hydrate. The prerendered
 * HTML is interactive looking before hydration, so a click or a shortcut sent
 * too early would do nothing. React marks the DOM nodes it owns with a
 * __reactProps key; the theme radios exist on every page.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page.locator('main')).toBeVisible();
  await page.waitForFunction(() => {
    const radio = document.querySelector('input[name="theme"]');
    return radio !== null && Object.keys(radio).some((key) => key.startsWith('__reactProps'));
  });
}
