// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, test } from '@playwright/test';

import { SCHEMES, SECTIONS, settle, watchConsole, WIDTHS } from './support';

test.describe('visual snapshots', () => {
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`overview, ${scheme}, ${String(width)} wide`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await settle(page);
        await expect(page).toHaveScreenshot(`overview-${scheme}-${String(width)}.png`, {
          fullPage: true,
        });
      });
    }

    test(`collapsed rail and a section, ${scheme}, 1440 wide`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/approvals');
      await settle(page);
      await page.getByRole('button', { name: 'Collapse navigation' }).click();
      await expect(page).toHaveScreenshot(`rail-collapsed-${scheme}-1440.png`);
    });

    test(`navigation drawer, ${scheme}, 375 wide`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/payouts');
      await settle(page);
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
      await expect(page).toHaveScreenshot(`drawer-${scheme}-375.png`);
    });

    test(`command palette, ${scheme}, 1440 wide`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/');
      await settle(page);
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog', { name: 'Go to a page' })).toBeVisible();
      await expect(page).toHaveScreenshot(`palette-${scheme}-1440.png`);
    });
  }
});

test.describe('shell', () => {
  test('every section loads with no console errors or warnings', async ({ page }) => {
    const messages = watchConsole(page);
    for (const path of SECTIONS) {
      await page.goto(path);
      await settle(page);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    expect(messages).toEqual([]);
  });

  test('the rail moves between sections and marks the current one', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await settle(page);
    const rail = page.getByRole('complementary').getByRole('navigation', { name: 'Main' });
    await rail.getByRole('link', { name: 'Mandates' }).click();
    await expect(page).toHaveURL('/mandates');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mandates');
    await expect(page).toHaveTitle('Mandates | UJIRA');
    await expect(rail.getByRole('link', { name: 'Mandates' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(rail.getByRole('link', { name: 'Overview' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the project lives in the URL and follows every link', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/payouts');
    await settle(page);
    await page.getByRole('button', { name: /Switch project/ }).click();
    await page.getByRole('menuitemradio', { name: 'Bug bounties' }).click();
    await expect(page).toHaveURL('/payouts?project=bounties');
    await page.getByRole('link', { name: 'Receipts' }).click();
    await expect(page).toHaveURL('/receipts?project=bounties');
    await page.reload();
    await settle(page);
    await expect(page.getByRole('button', { name: /Switch project/ })).toHaveAccessibleName(
      'Project: Bug bounties. Switch project',
    );
  });

  test('an unknown project in the URL falls back to the default one', async ({ page }) => {
    await page.goto('/?project=nope');
    await settle(page);
    await expect(page.getByRole('button', { name: /Switch project/ }).first()).toHaveAccessibleName(
      'Project: Labelling payouts. Switch project',
    );
  });

  test('the theme follows the system until one is picked, and the pick survives a reload', async ({
    page,
  }) => {
    const html = page.locator('html');
    const background = () => html.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await settle(page);
    await expect(html).not.toHaveAttribute('data-theme');
    const dark = await background();
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await background();
    expect(light).not.toBe(dark);
    await page.getByRole('group', { name: 'Theme' }).getByText('Dark').click({ force: true });
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await background()).toBe(dark);
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await background()).toBe(dark);
    await page.getByRole('radio', { name: 'Match system' }).check({ force: true });
    await expect(html).not.toHaveAttribute('data-theme');
    expect(await background()).toBe(light);
  });

  test('a collapsed rail stays collapsed across a reload, before hydration', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await settle(page);
    await page.getByRole('button', { name: 'Collapse navigation' }).click();
    const rail = page.getByRole('complementary');
    await expect(rail).toHaveCSS('width', '64px');
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('aside');
    // The inline script sets the attribute before the first paint.
    await expect(page.locator('html')).toHaveAttribute('data-rail', 'collapsed');
    await expect(rail).toHaveCSS('width', '64px');
    await settle(page);
    await page.getByRole('button', { name: 'Expand navigation' }).click();
    await expect(rail).toHaveCSS('width', '240px');
  });

  test('the command palette opens from the keyboard and jumps to a page', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Go to a page' });
    await expect(palette).toBeVisible();
    await page.keyboard.type('fund');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/funding');
    await expect(palette).toBeHidden();
    await page.getByRole('button', { name: /Go to a page/ }).click();
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('on a phone the navigation is a drawer that traps focus and closes on Escape', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await settle(page);
    await expect(page.getByRole('complementary')).toBeHidden();
    const opener = page.getByRole('button', { name: 'Open navigation' });
    await opener.click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    // A modal dialog lets Tab reach the browser's own controls after its last
    // item, but never the page behind it.
    for (let i = 0; i < 15; i += 1) {
      await page.keyboard.press('Tab');
      const where = await drawer.evaluate((el) =>
        el.contains(document.activeElement)
          ? 'drawer'
          : document.activeElement === document.body
            ? 'browser'
            : 'page',
      );
      expect(where).not.toBe('page');
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.click();
    await drawer.getByRole('link', { name: 'Approvals' }).click();
    await expect(page).toHaveURL('/approvals');
    await expect(drawer).toBeHidden();
  });

  test('the project switcher works inside the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await settle(page);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await drawer.getByRole('button', { name: /Switch project/ }).click();
    await drawer.getByRole('menuitemradio', { name: 'Community grants' }).click();
    await expect(page).toHaveURL('/?project=grants');
  });

  test('the skip link moves focus to the page content', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });

  test('an unknown address shows the not found page inside the shell', async ({ page }) => {
    const response = await page.goto('/users');
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole('heading', { name: 'There is no page at this address' }),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeAttached();
  });
});
