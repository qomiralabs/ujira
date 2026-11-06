// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Free activation is offered first when it can fix what stops a wallet
// receiving, and is never itself the proof that the wallet is the
// recipient's: the signature step follows it.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { en } from '../src/i18n/en.js';
import { answerUpToProof, openConnected } from './connected.ts';
import { heading, primary, WIDGET } from './flow.ts';

test('eligible recipient with no account sees Activate this account for free, and the proof step follows a landed activation', async ({
  page,
}) => {
  await openConnected(page, { scenario: 'activation', wallet: true });
  await answerUpToProof(page);
  await expect(heading(page)).toHaveText(en['prove.heading']);
  await primary(page).click();

  await expect(heading(page)).toHaveText(en['activate.heading']);
  await expect(primary(page)).toHaveText('Activate this account for free');
  await expect(page.locator(`${WIDGET} .progress`)).toHaveText('Step 4 of 4');
  await primary(page).click();

  await expect(heading(page)).toHaveText(en['prove.heading']);
  expect(await page.evaluate(() => window.walletSigned?.transactions)).toBe(1);
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['done.heading']);
  expect(await page.evaluate(() => window.walletSigned?.messages)).toBe(2);
});

test('the wallet and activation steps have no accessibility violations', async ({ page }) => {
  await openConnected(page, { scenario: 'activation', wallet: true });
  await answerUpToProof(page);
  const axe = async (): Promise<unknown[]> =>
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations.map((violation) => violation.id);
  await expect(heading(page)).toHaveText(en['prove.heading']);
  expect(await axe()).toEqual([]);
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['activate.heading']);
  expect(await axe()).toEqual([]);
});

test('without a page wallet, the recipient signs in their own wallet and pastes it back', async ({
  page,
}) => {
  await openConnected(page, { scenario: 'ke-wallet' });
  await answerUpToProof(page);
  await expect(page.locator(`${WIDGET} .sign-text`)).toContainText('confirm your payout address');
  await page.locator(`${WIDGET} input#signature`).fill('c2lnbmVk');
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['done.heading']);
});
