// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { SCHEMES, SECTIONS, settle } from './support';

// WCAG 2.2 AA, every level and version up to it.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(' ')),
  }));
}

for (const scheme of SCHEMES) {
  test.describe(`axe, ${scheme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
    });

    for (const path of [...SECTIONS, '/not-a-page']) {
      test(`${path} has no violations`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(path);
        await settle(page);
        expect(await violations(page)).toEqual([]);
      });
    }

    test('the phone layout with the drawer open has no violations', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/');
      await settle(page);
      expect(await violations(page)).toEqual([]);
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test('the tablet layout has no violations', async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto('/payouts');
      await settle(page);
      expect(await violations(page)).toEqual([]);
    });

    test('the collapsed rail, the project menu and the palette have no violations', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/');
      await settle(page);
      await page.getByRole('button', { name: 'Collapse navigation' }).click();
      expect(await violations(page)).toEqual([]);
      await page.getByRole('button', { name: /Switch project/ }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog', { name: 'Go to a page' })).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test('a manual theme over the opposite system setting has no violations', async ({ page }) => {
      await page.goto('/');
      await settle(page);
      const other = scheme === 'light' ? 'Dark' : 'Light';
      await page.getByRole('radio', { name: other }).check({ force: true });
      expect(await violations(page)).toEqual([]);
    });
  });
}
