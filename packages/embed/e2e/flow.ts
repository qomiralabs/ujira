// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Shared steps for the browser tests. Locators reach through the shadow root
// the way a person reaches the controls: by what they are, not where they are.

import { expect, type Locator, type Page } from '@playwright/test';

import { encodeAccountAddress } from '../src/destination.js';

export const WIDGET = 'ujira-onboarding';
/** A real Stellar address, checksum and all, that belongs to nobody we know. */
export const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));
export const NAME = 'Amara Eze';

export interface OpenOptions {
  mode?: 'light' | 'dark';
  width?: number;
  height?: number;
}

export function heading(page: Page): Locator {
  return page.locator(`${WIDGET} .heading`);
}

export function primary(page: Page): Locator {
  return page.locator(`${WIDGET} .primary`);
}

/** The step's main question. The wallet step has a memo field under it too. */
export function field(page: Page): Locator {
  return page.locator(`${WIDGET} input#answer`);
}

export function memo(page: Page): Locator {
  return page.locator(`${WIDGET} input#memo`);
}

export function progress(page: Page): Locator {
  return page.locator(`${WIDGET} .progress`);
}

export async function setMode(page: Page, mode: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => {
    document.body.dataset['mode'] = next;
    document.querySelector('ujira-onboarding')?.setAttribute('mode', next);
  }, mode);
}

export async function open(page: Page, options: OpenOptions = {}): Promise<void> {
  if (options.width !== undefined) {
    await page.setViewportSize({ width: options.width, height: options.height ?? 900 });
  }
  await page.goto('/host.html');
  await expect(heading(page)).toBeVisible();
  if (options.mode === 'dark') await setMode(page, 'dark');
}

export async function answerName(page: Page): Promise<void> {
  await field(page).fill(NAME);
  await primary(page).click();
}

export async function answerMethod(page: Page): Promise<void> {
  await primary(page).click();
}

export async function answerDestination(page: Page): Promise<void> {
  await field(page).fill(WALLET);
  await primary(page).click();
}

/** Walks to the step named, filling in everything before it. */
export async function reach(
  page: Page,
  step: 'name' | 'method' | 'destination' | 'review' | 'done',
): Promise<void> {
  if (step === 'name') return;
  await answerName(page);
  if (step === 'method') return;
  await answerMethod(page);
  if (step === 'destination') return;
  await answerDestination(page);
  if (step === 'review') return;
  await primary(page).click();
  await expect(heading(page)).toBeVisible();
}
