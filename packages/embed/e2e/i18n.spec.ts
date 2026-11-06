// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The widget in every language it offers: chosen by the page or the
// browser, and laid out at 320 px without anything spilling sideways.

import { expect, test, type Page } from '@playwright/test';

import { DRAFTS, readyLocales } from '../src/i18n/catalogue.js';
import { field, heading, primary, WALLET, WIDGET } from './flow.ts';

async function openIn(page: Page, locale: string, width = 420): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/host.html');
  await page.evaluate((next) => {
    document.querySelector('ujira-onboarding')?.setAttribute('locale', next);
  }, locale);
}

async function sideways(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('lang=sw renders Swahili', async ({ page }) => {
  await openIn(page, 'sw');
  await expect(heading(page)).toHaveText(DRAFTS.sw['name.heading'] ?? '');
  await expect(page.locator(`${WIDGET} section`)).toHaveAttribute('lang', 'sw');
});

test.describe('with a French browser and no language from the page', () => {
  test.use({ locale: 'fr-FR' });

  test('follows the browser', async ({ page }) => {
    await page.goto('/host.html');
    await page.evaluate(() => {
      document.querySelector('ujira-onboarding')?.removeAttribute('locale');
    });
    await expect(heading(page)).toHaveText(DRAFTS.fr['name.heading'] ?? '');
  });
});

for (const locale of readyLocales()) {
  test(`nothing spills sideways at 320 px in ${locale}`, async ({ page }) => {
    await openIn(page, locale, 320);
    await expect(heading(page)).toHaveText(DRAFTS[locale]['name.heading'] ?? '');
    expect(await sideways(page), 'the name step overflows').toBe(0);
    await field(page).fill('Amara Eze');
    await primary(page).click();
    expect(await sideways(page), 'the method step overflows').toBe(0);
    await primary(page).click();
    expect(await sideways(page), 'the destination step overflows').toBe(0);
    await field(page).fill(WALLET);
    await primary(page).click();
    await expect(heading(page)).toHaveText(DRAFTS[locale]['review.heading'] ?? '');
    expect(await sideways(page), 'the review step overflows').toBe(0);
  });
}
