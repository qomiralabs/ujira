// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The identity check a corridor needs, against the fake API. No real Self
// or anchor is called: the provider's page is a stand-in served by the test.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { en } from '../src/i18n/en.js';
import { openConnected } from './connected.ts';
import { heading, primary, WIDGET } from './flow.ts';

test.beforeEach(async ({ context }) => {
  await context.route('https://verify.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Stand-in ID check</title>' }),
  );
});

test('a Stellar wallet recipient verified with Self moves on to the address', async ({
  page,
  context,
}) => {
  await openConnected(page, { scenario: 'self-wallet', expectedSteps: 5 });
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['verify.heading']);
  await expect(primary(page)).toHaveText(en['verify.self.action']);

  const opened = context.waitForEvent('page');
  await primary(page).click();
  const provider = await opened;
  await expect(provider).toHaveURL('https://verify.example/self/check-0001');
  // The provider's page cannot reach back into the integrator's.
  expect(await provider.evaluate(() => window.opener === null)).toBe(true);

  await expect(heading(page)).toHaveText(en['verify.waiting.heading']);
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['destination.wallet.heading']);
  await expect(page.locator(`${WIDGET} .progress`)).toHaveText('Step 3 of 5');
});

test('a wallet recipient with no check to do goes straight to the address', async ({ page }) => {
  await openConnected(page, { scenario: 'ke-wallet' });
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['destination.wallet.heading']);
});

test('the check has no accessibility violations, before and while waiting', async ({ page }) => {
  await openConnected(page, { scenario: 'self-wallet', expectedSteps: 5 });
  await primary(page).click();
  const axe = async (): Promise<unknown[]> =>
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations.map((violation) => violation.id);
  await expect(heading(page)).toHaveText(en['verify.heading']);
  expect(await axe()).toEqual([]);
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['verify.waiting.heading']);
  expect(await axe()).toEqual([]);
});
