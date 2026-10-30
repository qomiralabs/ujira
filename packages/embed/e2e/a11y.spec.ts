// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { field, open, primary, reach, WIDGET } from './flow.ts';

const STEPS = ['name', 'method', 'destination', 'review', 'done'] as const;
const MODES = ['light', 'dark'] as const;

async function violations(page: Page): Promise<unknown[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => node.target),
  }));
}

for (const mode of MODES) {
  for (const step of STEPS) {
    test(`no accessibility violations on the ${step} step in ${mode} mode`, async ({ page }) => {
      await open(page, { mode });
      await reach(page, step);
      expect(await violations(page)).toEqual([]);
    });
  }
}

test('no accessibility violations while a problem is on screen', async ({ page }) => {
  await open(page);
  await primary(page).click();
  await expect(page.locator(`${WIDGET} .alert`)).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('the whole flow can be done from the keyboard', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Tab');
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('Amara Eze');
  await page.keyboard.press('Enter');
  await expect(page.locator(`${WIDGET} .statement-name`)).toBeVisible();
  // Focus lands on the new question, so a screen reader reads it next.
  await expect(page.locator(`${WIDGET} .heading`)).toBeFocused();
});
