// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Captures the widget in light and dark at the review widths, for a design
// review. Nothing is written inside the checkout unless you ask for it.
//
//   node tools/screenshots.ts <folder>

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Page } from '@playwright/test';

import { encodeAccountAddress } from '../src/destination.ts';
import { startServer } from './serve.ts';

const WIDTHS = [320, 375, 768, 1440];
const MODES = ['light', 'dark'] as const;
const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));
const WIDGET = 'ujira-onboarding';

const folder = process.argv[2];
if (folder === undefined) {
  process.stderr.write('Usage: node tools/screenshots.ts <folder>\n');
  process.exit(2);
}

/** Opens a host page in a mode, waiting for the widget's first question. */
async function openPage(page: Page, url: string, mode: string): Promise<void> {
  await page.goto(url);
  await page.locator(`${WIDGET} .progress`).waitFor();
  await page.evaluate((next) => {
    document.body.dataset['mode'] = next;
    document.querySelector('ujira-onboarding')?.setAttribute('mode', next);
  }, mode);
}

async function press(page: Page): Promise<void> {
  await page.locator(`${WIDGET} .primary`).click();
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.locator(`${WIDGET} .heading`).first().waitFor();
  // Away from the action, so nothing is caught in its hover state.
  await page.mouse.move(0, 0);
  const path = join(folder ?? '.', `${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  process.stdout.write(`${path}\n`);
}

const root = join(import.meta.dirname, '..');
const running = await startServer(root, 4179);
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch();

try {
  for (const mode of MODES) {
    for (const width of WIDTHS) {
      const shot = (step: string): string => `embed-${step}-${String(width)}-${mode}`;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: mode,
      });

      // Handed answers: the name, the destination and the review.
      const page = await context.newPage();
      await openPage(page, `${running.url}/host.html`, mode);
      await shoot(page, shot('name'));
      await page.locator(`${WIDGET} input#answer`).fill('Amara Eze');
      await press(page);
      await press(page);
      await shoot(page, shot('destination'));
      await page.locator(`${WIDGET} input#answer`).fill(WALLET);
      await press(page);
      await shoot(page, shot('review'));

      // Connected: signing without a page wallet, and free activation.
      const connected = await context.newPage();
      for (const [url, name] of [
        ['/connected.html?scenario=ke-wallet', 'prove'],
        ['/connected.html?scenario=activation&wallet=1', 'activate'],
      ] as const) {
        await openPage(connected, `${running.url}${url}`, mode);
        await press(connected);
        await connected.locator(`${WIDGET} input#answer`).fill(WALLET);
        await press(connected);
        await press(connected);
        if (name === 'activate') {
          await connected.locator(`${WIDGET} .primary`).waitFor();
          await press(connected);
          await connected.locator(`${WIDGET} .text-button`).waitFor();
        } else {
          await connected.locator(`${WIDGET} .sign-text`).waitFor();
        }
        await shoot(connected, shot(name));
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await running.close();
}
