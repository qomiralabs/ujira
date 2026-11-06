// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A detail sheet sits over the list it was opened from. Closing it must leave
// the list exactly where it was, with focus back on the row, so a person
// working down a long list never loses their place.

import { expect, test } from '@playwright/test';
import { loadStories, openStory } from './stories.ts';

test('opening and closing restores scroll position and focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const story = loadStories().find((entry) => entry.id === 'patterns-detailsheet--default');
  if (story === undefined) throw new Error('no detail sheet story in the built catalogue');
  await openStory(page, story, 'light');

  const row = page.locator('[data-row="Recipient 30"]');
  await row.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before, 'the row is below the fold, so the page has scrolled').toBeGreaterThan(0);

  await row.focus();
  await page.keyboard.press('Enter');
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Recipient 30' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);

  // The same with the pointer and the close button.
  await row.click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test('the sheet fills a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const story = loadStories().find((entry) => entry.id === 'patterns-detailsheet--open');
  if (story === undefined) throw new Error('no open detail sheet story in the built catalogue');
  await openStory(page, story, 'light');
  const box = await page.locator('[data-slot="sheet-content"]').boundingBox();
  expect(box?.width).toBe(375);
  expect(box?.height).toBe(812);
});
