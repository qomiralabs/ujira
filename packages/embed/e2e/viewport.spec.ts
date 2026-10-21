// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, test, type Page } from '@playwright/test';

import {
  answerDestination,
  answerMethod,
  answerName,
  open,
  primary,
  reach,
  WIDGET,
} from './flow.ts';

const NARROW = 320;

async function sidewaysScroll(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('the widget fits a 320 px screen', async ({ page }) => {
  await open(page, { width: NARROW, height: 720 });
  // Before the screenshot, not after: on a platform with no baseline the
  // comparison throws and anything below it never runs.
  expect(await sidewaysScroll(page)).toBe(0);
  await expect(page.locator(`${WIDGET} .widget`)).toHaveScreenshot('name-step-320.png');
});

// The step whose heading already wraps at 320 in the narrow face, and the
// one the switched off methods will arrive on with longer headings still.
test('the destination step fits a 320 px screen', async ({ page }) => {
  await open(page, { width: NARROW, height: 720 });
  await reach(page, 'destination');
  expect(await sidewaysScroll(page)).toBe(0);
  await expect(page.locator(`${WIDGET} .widget`)).toHaveScreenshot('destination-step-320.png');
});

test('nothing spills sideways on any step at 320 px', async ({ page }) => {
  await open(page, { width: NARROW, height: 720 });
  expect(await sidewaysScroll(page), 'the name step overflows').toBe(0);
  await answerName(page);
  expect(await sidewaysScroll(page), 'the method step overflows').toBe(0);
  await answerMethod(page);
  expect(await sidewaysScroll(page), 'the destination step overflows').toBe(0);
  await answerDestination(page);
  expect(await sidewaysScroll(page), 'the review step overflows').toBe(0);
  await primary(page).click();
  await expect(page.locator(`${WIDGET} .heading`)).toBeVisible();
  expect(await sidewaysScroll(page), 'the confirmation overflows').toBe(0);
});

test('every control is big enough to hit with a thumb', async ({ page }) => {
  await open(page, { width: NARROW, height: 720 });
  await reach(page, 'destination');
  const controls = page.locator(
    `${WIDGET} input.input, ${WIDGET} .primary, ${WIDGET} .text-button`,
  );
  // The destination step has exactly these three: back, the field and the
  // action. A count keeps this from passing while finding nothing.
  const count = await controls.count();
  expect(count).toBe(3);
  for (let index = 0; index < count; index++) {
    const box = await controls.nth(index).boundingBox();
    expect(box?.height ?? 0, `control ${String(index)} is too short`).toBeGreaterThanOrEqual(44);
  }
});
