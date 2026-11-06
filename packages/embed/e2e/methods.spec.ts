// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Only the methods the recipient's corridor pays out are offered, and only
// once the widget's own path for them is finished.

import { expect, test } from '@playwright/test';

import { en } from '../src/i18n/en.js';
import { openConnected } from './connected.ts';
import { WIDGET } from './flow.ts';

test('with no signed anchor, KE offers only USDC to your Stellar wallet', async ({ page }) => {
  await openConnected(page, { scenario: 'ke-wallet' });
  await expect(page.locator(`${WIDGET} .statement-name`)).toHaveText('USDC to your Stellar wallet');
  await expect(page.locator(`${WIDGET} input[type="radio"]`)).toHaveCount(0);
});

// The issue asks for mobile money to be offered alongside the wallet where a
// signed partner pays it out. At the testnet launch only the wallet path is
// finished, so the widget keeps mobile money closed even then; this pins that
// down, and turns into the "offers it alongside" test the day the path opens.
test('with a signed mobile money anchor, KE still offers only the wallet until that path opens', async ({
  page,
}) => {
  await openConnected(page, { scenario: 'ke-mobile' });
  await expect(page.locator(`${WIDGET} .statement-name`)).toHaveText(en['method.wallet.name']);
  await expect(page.locator(`${WIDGET} .widget`)).not.toContainText(en['method.mobile.name']);
});
