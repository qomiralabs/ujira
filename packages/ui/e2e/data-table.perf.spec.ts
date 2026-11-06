// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The payouts table must stay quick at ten thousand rows. Interaction to next
// paint is the slowest interaction on the page, read here from the Event
// Timing entries the browser records for every key press and click, while
// the table is scrolled from top to bottom and back.

import { expect, test } from '@playwright/test';
import { loadStories, openStory } from './stories.ts';

const INP_BUDGET_MS = 200;
const ROWS = '[data-slot="data-table-frame"] tbody tr[data-index]';

test('scrolling 10,000 rows keeps INP under 200 ms', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const entry = loadStories().find((story) => story.id === 'patterns-datatable--ten-thousand-rows');
  if (entry === undefined) throw new Error('no ten thousand row story in the built catalogue');
  await openStory(page, entry, 'light');

  // Event entries only exist for interactions slower than 16 ms, so a quick
  // table records none. The first input is always recorded, which proves the
  // observer is working when the list stays empty.
  await page.evaluate(() => {
    const store = window as unknown as { __interactions: number[]; __firstInput: boolean };
    store.__interactions = [];
    store.__firstInput = false;
    new PerformanceObserver((list) => {
      for (const timing of list.getEntries() as PerformanceEventTiming[]) {
        if (timing.interactionId > 0) store.__interactions.push(timing.duration);
      }
      // The DOM library has no durationThreshold yet; Chromium reads it.
    }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
    new PerformanceObserver(() => {
      store.__firstInput = true;
    }).observe({ type: 'first-input', buffered: true });
  });

  await page.locator(`${ROWS}[data-index="0"]`).focus();
  for (let press = 0; press < 25; press++) await page.keyboard.press('PageDown');
  for (let press = 0; press < 10; press++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  for (let press = 0; press < 10; press++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Home');

  const frame = page.locator('[data-slot="data-table-frame"]');
  await frame.hover();
  for (let wheel = 0; wheel < 30; wheel++) await page.mouse.wheel(0, 2400);
  await page.locator(ROWS).first().click();
  await page.keyboard.press('Enter');

  // Event Timing entries are delivered after the next paint.
  await page.waitForTimeout(500);
  const { durations, firstInput } = await page.evaluate(() => {
    const store = window as unknown as { __interactions: number[]; __firstInput: boolean };
    return { durations: store.__interactions, firstInput: store.__firstInput };
  });
  expect(firstInput, 'the browser recorded no input at all').toBe(true);
  const worst = durations.length === 0 ? 0 : Math.max(...durations);
  test.info().annotations.push({
    type: 'interaction to next paint',
    description: `${String(worst)} ms worst of ${String(durations.length)} interactions`,
  });
  expect(worst).toBeLessThan(INP_BUDGET_MS);
  // Only the rows in view are in the page, however far it scrolled.
  expect(await page.locator(ROWS).count()).toBeLessThan(100);
});
