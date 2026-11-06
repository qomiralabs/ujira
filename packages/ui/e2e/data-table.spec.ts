// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, test, type Page } from '@playwright/test';
import { loadStories, openStory, type StoryEntry } from './stories.ts';

function story(id: string): StoryEntry {
  const found = loadStories().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no story ${id} in the built catalogue`);
  return found;
}

const ROWS = '[data-slot="data-table-frame"] tbody tr[data-index]';

async function focusedIndex(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-index') ?? null);
}

test('arrows move the active row and Enter opens it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStory(page, story('patterns-datatable--default'), 'light');
  const rows = page.locator(ROWS);
  const count = await rows.count();
  expect(count).toBeGreaterThan(3);

  // Exactly one row is in the tab order; Tab from the last sort button lands on it.
  expect(await page.locator(`${ROWS}[tabindex="0"]`).count()).toBe(1);
  await page.getByRole('button', { name: 'Corridor' }).focus();
  await page.keyboard.press('Tab');
  expect(await focusedIndex(page)).toBe('0');

  await page.keyboard.press('ArrowDown');
  expect(await focusedIndex(page)).toBe('1');
  await page.keyboard.press('ArrowDown');
  expect(await focusedIndex(page)).toBe('2');
  await page.keyboard.press('ArrowUp');
  expect(await focusedIndex(page)).toBe('1');
  await page.keyboard.press('End');
  expect(await focusedIndex(page)).toBe(String(count - 1));
  await page.keyboard.press('Home');
  expect(await focusedIndex(page)).toBe('0');

  // The focused row shows the saffron ring.
  const outline = await page.evaluate(() => {
    const element = document.activeElement;
    return element === null ? null : getComputedStyle(element).outlineStyle;
  });
  expect(outline).toBe('solid');

  await page.keyboard.press('ArrowDown');
  const recipient = await page.locator(`${ROWS}[data-index="1"] td`).first().innerText();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('opened')).toContainText(`Opened ${recipient}`);
  await expect(page.locator(`${ROWS}[data-index="1"]`)).toHaveAttribute('aria-current', 'true');
});

test('a row click opens it, and a checkbox click does not', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStory(page, story('patterns-datatable--selection'), 'light');
  await page.locator(`${ROWS}[data-index="2"] [role="checkbox"]`).click();
  await expect(page.getByTestId('opened')).toHaveText('No payout open.');
  await page.locator(`${ROWS}[data-index="2"] td`).nth(1).click();
  await expect(page.getByTestId('opened')).toContainText('Opened');
});

test('the keyboard reaches rows far below the fold in a virtualised table', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStory(page, story('patterns-datatable--ten-thousand-rows'), 'light');
  await page.locator(`${ROWS}[data-index="0"]`).focus();
  await page.keyboard.press('End');
  await expect.poll(() => focusedIndex(page)).toBe('9999');
  // Only the rows in view are in the page.
  expect(await page.locator(ROWS).count()).toBeLessThan(100);
});
