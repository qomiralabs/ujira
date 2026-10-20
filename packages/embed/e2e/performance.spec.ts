// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The widget has to be usable on a cheap phone on a slow connection, so the
// test measures the thing that matters: how long until the first question is
// on screen and its control can be used.

import { expect, test } from '@playwright/test';

import { field, heading, WIDGET } from './flow.ts';

// Regular 3G, the profile Lighthouse uses: 1.6 Mbps down, 750 Kbps up,
// 300 ms round trip.
const DOWNLOAD = (1.6 * 1024 * 1024) / 8;
const UPLOAD = (750 * 1024) / 8;
const LATENCY = 300;
const BUDGET_MS = 1500;

test('interactive in under 1.5 s on a 3G connection', async ({ page }) => {
  const client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: DOWNLOAD,
    uploadThroughput: UPLOAD,
    latency: LATENCY,
  });

  const started = Date.now();
  await page.goto('/host.html');
  await expect(heading(page)).toBeVisible();
  await field(page).fill('Amara Eze');
  const elapsed = Date.now() - started;

  await expect(page.locator(`${WIDGET} input.input`)).toHaveValue('Amara Eze');
  test.info().annotations.push({ type: 'interactive', description: `${String(elapsed)} ms` });
  expect(elapsed, `interactive after ${String(elapsed)} ms`).toBeLessThan(BUDGET_MS);
});
