// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type * as z from 'zod/mini';

import { ApiKeyIssued, ApiKeyPage, ApiKeyRotated, ApiKeyView } from '../src/data/api-keys';
import { FAKE_STEP_UP_CODE, type FakeApi, type FakeApiOptions } from '../src/data/fake-api';
import { serveFakeApi } from './fake-api';
import { SCHEMES, settle, watchConsole, WIDTHS } from './support';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Dates on screen depend on the clock and the time zone, so both are fixed.
test.use({ timezoneId: 'UTC', locale: 'en-GB' });

async function open(
  page: Page,
  path = '/developers',
  options: FakeApiOptions = {},
): Promise<FakeApi> {
  await page.clock.setFixedTime(NOW);
  const fake = await serveFakeApi(page, { now: () => NOW, ...options });
  await page.goto(path);
  await settle(page);
  return fake;
}

function visible(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true }).filter({ visible: true });
}

async function listed(page: Page): Promise<void> {
  await expect(visible(page, 'ujk_test_pq7rx2mzk4ahwd3e')).toBeVisible();
}

function row(page: Page, name: string): Locator {
  return page
    .getByRole('table', { name: 'API keys' })
    .getByRole('row')
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function stepUp(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Code').fill(FAKE_STEP_UP_CODE);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

async function createKey(
  page: Page,
  name = 'CI runner',
): Promise<{ reveal: Locator; secret: string }> {
  await page.getByRole('button', { name: 'Create API key' }).click();
  const create = page.getByRole('dialog', { name: 'Create an API key' });
  await create.getByRole('textbox', { name: 'Name' }).fill(name);
  await create.getByRole('radio', { name: 'Payouts' }).click();
  await create.getByRole('combobox', { name: 'Expires after' }).click();
  await page.getByRole('option', { name: '90 days' }).click();
  await create.getByRole('button', { name: 'Create key' }).click();
  await stepUp(page);
  const reveal = page.getByRole('dialog', { name: 'Copy your new API key' });
  await expect(reveal).toBeVisible();
  const secret = (await reveal.locator('code').textContent()) ?? '';
  expect(secret).toMatch(/^ujk_test_[a-z2-7]{16}_[a-z2-7]{59}$/);
  return { reveal, secret };
}

async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map((v) => ({
    id: v.id,
    nodes: v.nodes.map((n) => n.target.join(' ')),
  }));
}

test.describe('api-keys.spec.ts', () => {
  test('after closing the dialog the secret is gone from the DOM and from any later response', async ({
    page,
  }) => {
    const messages = watchConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fake = await open(page);
    await listed(page);
    const { reveal, secret } = await createKey(page);
    await expect(reveal).toContainText('This is the only time UJIRA shows this key');

    await reveal.getByRole('button', { name: 'Done' }).click();
    await expect(reveal).toBeHidden();
    await expect(page.getByRole('button', { name: 'Create API key' })).toBeFocused();
    expect(await page.content()).not.toContain(secret);

    // Only the prefix remains.
    const created = row(page, 'CI runner');
    await expect(created).toContainText(secret.slice(0, 25));
    await expect(created).toContainText('4 Feb 2027');

    // Load the list again, here and after a reload, and look at every answer
    // that came after the one that issued the key.
    await page.reload();
    await settle(page);
    await listed(page);
    const issued = fake.served.findIndex((r) => r.body.includes(secret));
    expect(issued).toBeGreaterThanOrEqual(0);
    const later = fake.served.slice(issued + 1);
    expect(later.filter((r) => r.method === 'GET').length).toBeGreaterThanOrEqual(2);
    for (const response of later) expect(response.body).not.toContain(secret);

    const stored = await page.evaluate(() =>
      [localStorage, sessionStorage]
        .flatMap((s) => Object.keys(s).map((k) => `${k}=${s.getItem(k) ?? ''}`))
        .join('\n'),
    );
    expect(stored).not.toContain(secret);
    expect(page.url()).not.toContain(secret);
    expect(messages.join('\n')).not.toContain(secret);
    expect(messages).toEqual([]);
  });

  test('create, rotate and revoke ask for step-up', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fake = await open(page);
    await listed(page);

    // Create: cancelling the step up creates nothing.
    await page.getByRole('button', { name: 'Create API key' }).click();
    const create = page.getByRole('dialog', { name: 'Create an API key' });
    await create.getByRole('textbox', { name: 'Name' }).fill('CI runner');
    await create.getByRole('radio', { name: 'Read only' }).click();
    await create.getByRole('button', { name: 'Create key' }).click();
    const prompt = page.getByRole('dialog', { name: "Confirm it's you" });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByLabel('Code')).toBeFocused();
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await expect(create.getByRole('alert')).toContainText('No key was created');
    expect(fake.served.filter((r) => r.status === 201)).toEqual([]);
    await create.getByRole('button', { name: 'Create key' }).click();
    await stepUp(page);
    await page
      .getByRole('dialog', { name: 'Copy your new API key' })
      .getByRole('button', { name: 'Done' })
      .click();

    // Rotate, with the second factor gone stale.
    fake.expireStepUp();
    await row(page, 'Payroll server')
      .getByRole('button', { name: 'Rotate Payroll server' })
      .click();
    const rotate = page.getByRole('alertdialog', { name: 'Rotate Payroll server?' });
    await expect(rotate).toContainText('keeps working for 24 hours, until 7 Nov 2026, 10:00');
    await rotate.getByLabel(/to confirm/).fill('Payroll server');
    await rotate.getByRole('button', { name: 'Rotate key' }).click();
    await stepUp(page);
    const replacement = page.getByRole('dialog', { name: 'Copy the replacement key' });
    await expect(replacement).toContainText('The old key keeps working until 7 Nov 2026, 10:00');
    await replacement.getByRole('button', { name: 'Done' }).click();
    await expect(row(page, 'Payroll server').filter({ hasText: 'Being replaced' })).toHaveCount(1);

    // Revoke, stale again.
    fake.expireStepUp();
    await row(page, 'Reporting').getByRole('button', { name: 'Revoke Reporting' }).click();
    const revoke = page.getByRole('alertdialog', { name: 'Revoke Reporting?' });
    await revoke.getByLabel(/to confirm/).fill('Reporting');
    await revoke.getByRole('button', { name: 'Revoke key' }).click();
    await stepUp(page);
    await expect(row(page, 'Reporting')).toContainText('Revoked');

    const refusals = fake.served.filter((r) => r.body.includes('"STEP_UP_REQUIRED"'));
    expect(refusals.map((r) => r.path)).toEqual([
      '/v1/api-keys',
      '/v1/api-keys',
      '/v1/api-keys/5f0c1a2e-0000-4000-8000-000000000001/rotate',
      '/v1/api-keys/5f0c1a2e-0000-4000-8000-000000000003/revoke',
    ]);
  });

  test('revoke needs the typed key name', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fake = await open(page);
    await listed(page);
    const opener = row(page, 'Payroll server').getByRole('button', {
      name: 'Revoke Payroll server',
    });
    await opener.click();
    const dialog = page.getByRole('alertdialog', { name: 'Revoke Payroll server?' });
    const confirm = dialog.getByRole('button', { name: 'Revoke key' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/to confirm/).fill('Payroll');
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/to confirm/).fill('payroll server');
    await expect(confirm).toBeDisabled();

    // Escape leaves without revoking, and focus goes back where it was.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(fake.served.filter((r) => r.method === 'POST')).toEqual([]);

    await opener.click();
    await dialog.getByLabel(/to confirm/).fill('Payroll server');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await stepUp(page);
    await expect(row(page, 'Payroll server')).toContainText('Revoked');
    await expect(
      page.getByRole('status').filter({ hasText: 'Payroll server is revoked' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'API keys' })).toBeFocused();
  });

  test('copies the key to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await listed(page);
    const { reveal, secret } = await createKey(page);
    await reveal.getByRole('button', { name: 'Copy key' }).click();
    await expect(reveal).toContainText('Copied. Paste it where your software keeps secrets.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  });

  test('every answer the screen reads parses with its schema', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fake = await open(page);
    await listed(page);
    const { reveal } = await createKey(page);
    await reveal.getByRole('button', { name: 'Done' }).click();
    await row(page, 'Labelling agent')
      .getByRole('button', { name: 'Rotate Labelling agent' })
      .click();
    const rotate = page.getByRole('alertdialog');
    await rotate.getByLabel(/to confirm/).fill('Labelling agent');
    await rotate.getByRole('button', { name: 'Rotate key' }).click();
    await page
      .getByRole('dialog', { name: 'Copy the replacement key' })
      .getByRole('button', { name: 'Done' })
      .click();
    await row(page, 'Reporting').getByRole('button', { name: 'Revoke Reporting' }).click();
    const revoke = page.getByRole('alertdialog');
    await revoke.getByLabel(/to confirm/).fill('Reporting');
    await revoke.getByRole('button', { name: 'Revoke key' }).click();
    await expect(row(page, 'Reporting')).toContainText('Revoked');

    const schemaFor = (method: string, path: string): z.ZodMiniType | null => {
      if (method === 'GET' && path === '/v1/api-keys') return ApiKeyPage;
      if (method === 'POST' && path === '/v1/api-keys') return ApiKeyIssued;
      if (path.endsWith('/rotate')) return ApiKeyRotated;
      if (path.endsWith('/revoke')) return ApiKeyView;
      return null;
    };
    const answers = fake.served.filter((r) => r.status >= 200 && r.status < 300 && r.body !== '');
    expect(answers.length).toBeGreaterThanOrEqual(6);
    for (const answer of answers) {
      const schema = schemaFor(answer.method, answer.path);
      expect(schema, `${answer.method} ${answer.path}`).not.toBeNull();
      expect(
        schema?.safeParse(JSON.parse(answer.body)).success,
        `${answer.method} ${answer.path}`,
      ).toBe(true);
    }
  });

  test('a phone shows each key as a card, with its actions', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page);
    await expect(page.getByRole('table', { name: 'API keys' })).toBeHidden();
    const cards = page.locator('[data-slot="data-table-cards"]');
    await expect(cards.getByRole('article')).toHaveCount(5);
    await expect(cards.getByRole('button', { name: 'Revoke Payroll server' })).toBeVisible();
    await expect(cards.getByText('Expires in 10 days')).toBeVisible();
  });

  test('a failed load says so, with a reference, and tries again', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    const fake = await serveFakeApi(page, { now: () => NOW });
    fake.failNext({ method: 'GET', path: '/v1/api-keys' }, 'DB_UNAVAILABLE');
    await page.goto('/developers');
    await settle(page);
    const alert = page.getByRole('alert').filter({ hasText: 'Your API keys did not load' });
    await expect(alert).toContainText(/Reference req_fake_\d{8}/);
    await alert.getByRole('button', { name: 'Try again' }).click();
    await listed(page);
  });
});

test.describe('api keys, visual and axe', () => {
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`the list, ${scheme}, ${String(width)} wide`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
        await open(page);
        await listed(page);
        await expect(page).toHaveScreenshot(`api-keys-${scheme}-${String(width)}.png`, {
          fullPage: true,
        });
        expect(await violations(page)).toEqual([]);
      });
    }

    test(`the empty project, ${scheme}, 1440 wide`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, '/developers?project=grants');
      await expect(page.getByRole('region', { name: 'No API keys yet' })).toBeVisible();
      await expect(page).toHaveScreenshot(`api-keys-empty-${scheme}-1440.png`);
      expect(await violations(page)).toEqual([]);
    });

    test(`creating a key, ${scheme}, 1440 wide`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page);
      await listed(page);
      await page.getByRole('button', { name: 'Create API key' }).click();
      const create = page.getByRole('dialog', { name: 'Create an API key' });
      await create.getByRole('button', { name: 'Create key' }).click();
      await expect(create.getByText('Give the key a name.')).toBeVisible();
      await expect(page).toHaveScreenshot(`api-keys-create-${scheme}-1440.png`);
      expect(await violations(page)).toEqual([]);

      await create.getByRole('textbox', { name: 'Name' }).fill('CI runner');
      await create.getByRole('radio', { name: 'Choose permissions' }).click();
      await create.getByRole('checkbox', { name: /See payouts/ }).click();
      await create.getByRole('button', { name: 'Create key' }).click();
      const prompt = page.getByRole('dialog', { name: "Confirm it's you" });
      await expect(prompt).toBeVisible();
      await expect(page).toHaveScreenshot(`api-keys-step-up-${scheme}-1440.png`);
      expect(await violations(page)).toEqual([]);

      await stepUp(page);
      const reveal = page.getByRole('dialog', { name: 'Copy your new API key' });
      await expect(reveal).toBeVisible();
      // The key is random, so it is masked; everything around it is compared.
      await expect(page).toHaveScreenshot(`api-keys-reveal-${scheme}-1440.png`, {
        mask: [reveal.locator('code')],
      });
      expect(await violations(page)).toEqual([]);
    });

    test(`revoking a key, ${scheme}, 1440 wide`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page);
      await listed(page);
      await row(page, 'Labelling agent')
        .getByRole('button', { name: 'Revoke Labelling agent' })
        .click();
      const dialog = page.getByRole('alertdialog', { name: 'Revoke Labelling agent?' });
      await dialog.getByLabel(/to confirm/).fill('Labelling agent');
      await expect(page).toHaveScreenshot(`api-keys-revoke-${scheme}-1440.png`);
      expect(await violations(page)).toEqual([]);
    });

    test(`creating a key on a phone, ${scheme}, 375 wide`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 375, height: 812 });
      await open(page);
      await page.getByRole('button', { name: 'Create API key' }).click();
      await expect(page.getByRole('dialog', { name: 'Create an API key' })).toBeVisible();
      await expect(page).toHaveScreenshot(`api-keys-create-${scheme}-375.png`);
      expect(await violations(page)).toEqual([]);
    });
  }
});
