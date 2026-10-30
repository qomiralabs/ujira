// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, test, type Page } from '@playwright/test';

import { open, reach, setMode } from './flow.ts';

interface Painted {
  action: string;
  actionLabel: string;
  radius: string;
  controlRadius: string;
  card: string;
  text: string;
  font: string;
}

async function painted(page: Page): Promise<Painted> {
  return page.evaluate(() => {
    const shadow = document.querySelector('ujira-onboarding')?.shadowRoot;
    const read = (selector: string): CSSStyleDeclaration => {
      const found = shadow?.querySelector(selector);
      if (found === null || found === undefined) throw new Error(`nothing matches ${selector}`);
      return getComputedStyle(found);
    };
    const card = read('.widget');
    const action = read('.primary');
    const heading = read('.heading');
    return {
      action: action.backgroundColor,
      actionLabel: action.color,
      radius: card.borderTopLeftRadius,
      controlRadius: action.borderTopLeftRadius,
      card: card.backgroundColor,
      text: heading.color,
      font: heading.fontFamily,
    };
  });
}

test('host CSS variables change colours and radius', async ({ page }) => {
  await open(page);
  const before = await painted(page);
  // The defaults are the UJIRA light tokens: saffron action, teal ink label,
  // 10px card, 6px control.
  expect(before.action).toBe('rgb(244, 163, 0)');
  expect(before.actionLabel).toBe('rgb(11, 42, 51)');
  expect(before.radius).toBe('10px');
  expect(before.controlRadius).toBe('6px');
  expect(before.card).toBe('rgb(255, 255, 255)');
  // Read from the rendered element, not from our own stylesheet: a font
  // declaration that loses the cascade is invisible any other way.
  // The page asks for Inter first and falls back to the system stack, which
  // is the shared token stack resolved.
  expect(before.font).toBe('Inter, ui-sans-serif, system-ui, sans-serif');

  await page.addStyleTag({
    content: `#widget {
      --ujira-embed-accent: rgb(0, 90, 180);
      --ujira-embed-on-accent: rgb(255, 255, 255);
      --ujira-embed-surface: rgb(245, 247, 250);
      --ujira-embed-text: rgb(17, 24, 39);
      --ujira-embed-radius-card: 2px;
      --ujira-embed-radius-control: 18px;
      --ujira-embed-font: Georgia, serif;
    }`,
  });

  const after = await painted(page);
  expect(after.action).toBe('rgb(0, 90, 180)');
  expect(after.actionLabel).toBe('rgb(255, 255, 255)');
  expect(after.card).toBe('rgb(245, 247, 250)');
  expect(after.text).toBe('rgb(17, 24, 39)');
  expect(after.radius).toBe('2px');
  expect(after.controlRadius).toBe('18px');
  expect(after.font).toBe('Georgia, serif');
});

test('the mode attribute switches the whole widget to the dark tokens', async ({ page }) => {
  await open(page);
  expect((await painted(page)).card).toBe('rgb(255, 255, 255)');
  await setMode(page, 'dark');
  const dark = await painted(page);
  expect(dark.card).toBe('rgb(15, 76, 92)');
  expect(dark.text).toBe('rgb(251, 247, 240)');
});

test('the theme holds on every step', async ({ page }) => {
  await open(page);
  await page.addStyleTag({ content: '#widget { --ujira-embed-accent: rgb(0, 90, 180); }' });
  await reach(page, 'review');
  expect((await painted(page)).action).toBe('rgb(0, 90, 180)');
});
