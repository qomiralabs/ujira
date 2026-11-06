// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Overlays keep focus inside while open and hand it back to the control that
// opened them, so a keyboard user is never left on the page behind.

import { expect, test, type Page } from '@playwright/test';
import { loadStories, openStory } from './stories.ts';

async function open(page: Page, id: string): Promise<void> {
  const story = loadStories().find((entry) => entry.id === id);
  if (story === undefined) throw new Error(`no story ${id} in the built catalogue`);
  await openStory(page, story, 'light');
}

async function focusIsInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    (within) => document.querySelector(within)?.contains(document.activeElement) ?? false,
    selector,
  );
}

const CASES = [
  {
    id: 'primitives-dialog--default',
    trigger: 'Review payout',
    overlay: '[data-slot="dialog-content"]',
  },
  {
    id: 'primitives-sheet--default',
    trigger: 'Open payout',
    overlay: '[data-slot="sheet-content"]',
  },
  {
    id: 'primitives-alertdialog--default',
    trigger: 'Pause mandate',
    overlay: '[data-slot="alert-dialog"]',
  },
] as const;

for (const { id, trigger, overlay } of CASES) {
  test(`${id}: dialog, sheet and popover trap focus and return it to the trigger`, async ({
    page,
  }) => {
    await open(page, id);
    const button = page.getByRole('button', { name: trigger });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(overlay)).toBeVisible();
    expect(await focusIsInside(page, overlay)).toBe(true);

    // Tab round the whole overlay and further: focus never leaves it.
    for (let press = 0; press < 8; press++) {
      await page.keyboard.press('Tab');
      expect(await focusIsInside(page, overlay), `after ${String(press + 1)} Tab`).toBe(true);
    }
    for (let press = 0; press < 3; press++) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusIsInside(page, overlay)).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(page.locator(overlay)).toHaveCount(0);
    await expect(button).toBeFocused();
  });
}

test('a pending dialog stays open on Escape', async ({ page }) => {
  await open(page, 'primitives-dialog--open-pending');
  await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible();
});

test('the typed confirmation turns the danger action on only for the exact word', async ({
  page,
}) => {
  await open(page, 'primitives-alertdialog--open-typed-confirmation');
  const action = page
    .locator('[data-slot="alert-dialog"]')
    .getByRole('button', { name: 'Pause mandate' });
  await expect(action).toBeDisabled();
  const input = page.getByRole('textbox', { name: 'Type pause to confirm' });
  await input.fill('Pause');
  await expect(action).toBeDisabled();
  await input.fill('pause');
  await expect(action).toBeEnabled();
});
