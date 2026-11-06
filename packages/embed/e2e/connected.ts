// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Steps for the browser tests of the connected flow, against the fake API.

import { expect, type Page } from '@playwright/test';

import { en } from '../src/i18n/en.js';
import { field, heading, primary, WALLET, WIDGET } from './flow.ts';

export interface ConnectedOptions {
  scenario: 'ke-wallet' | 'ke-mobile' | 'activation' | 'self-wallet';
  /** The page hands the widget a wallet that signs. */
  wallet?: boolean;
  width?: number;
  /** Five when an identity check comes before the address. */
  expectedSteps?: number;
}

/** Opens the connected host page and waits for the first question. */
export async function openConnected(page: Page, options: ConnectedOptions): Promise<void> {
  await page.setViewportSize({ width: options.width ?? 420, height: 900 });
  const wallet = options.wallet === true ? '&wallet=1' : '';
  await page.goto(`/connected.html?scenario=${options.scenario}${wallet}`);
  await expect(page.locator(`${WIDGET} .progress`)).toHaveText(
    `Step 1 of ${String(options.expectedSteps ?? 4)}`,
  );
}

/** From the method step to the wallet step, with an ordinary address. */
export async function answerUpToProof(page: Page): Promise<void> {
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['destination.wallet.heading']);
  await field(page).fill(WALLET);
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['review.heading']);
  await primary(page).click();
}
