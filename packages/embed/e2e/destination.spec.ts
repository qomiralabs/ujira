// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A destination UJIRA cannot pay is explained in plain words before anything
// is saved, on the field it belongs to.

import { expect, test } from '@playwright/test';

import { FAKE_ISSUER } from '../src/api/fake.js';
import { en } from '../src/i18n/en.js';
import { openConnected } from './connected.ts';
import { field, heading, memo, primary, WALLET, WIDGET } from './flow.ts';

test.beforeEach(async ({ page }) => {
  await openConnected(page, { scenario: 'ke-wallet' });
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['destination.wallet.heading']);
});

test('a text memo destination shows the unsupported message', async ({ page }) => {
  await field(page).fill(WALLET);
  await memo(page).fill('invoice 12');
  await primary(page).click();
  await expect(page.locator(`${WIDGET} .alert`)).toHaveText(en['destination.memo.unsupported']);
  await expect(memo(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(field(page)).toHaveAttribute('aria-invalid', 'false');
  await expect(heading(page)).toHaveText(en['destination.wallet.heading']);
});

test('the USDC issuer is refused, since a payout to it would be burned', async ({ page }) => {
  await field(page).fill(FAKE_ISSUER);
  await primary(page).click();
  await expect(page.locator(`${WIDGET} .alert`)).toHaveText(en['destination.wallet.unpayable']);
});

test('a numeric memo is kept, and shown on the review', async ({ page }) => {
  await field(page).fill(WALLET);
  await memo(page).fill('4815162342');
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['review.heading']);
  await expect(page.locator(`${WIDGET} .widget`)).toContainText('4815162342');
});
