// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Captures the widget in light and dark at the review widths, for a design
// review. Nothing is written inside the checkout unless you ask for it.
//
//   node tools/screenshots.ts <folder>

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { startServer } from './serve.ts';

const WIDTHS = [320, 375, 768, 1440];
const MODES = ['light', 'dark'] as const;
const STEPS = ['name', 'review'] as const;
const WALLET = `G${'A'.repeat(55)}`;

const folder = process.argv[2];
if (folder === undefined) {
  process.stderr.write('Usage: node tools/screenshots.ts <folder>\n');
  process.exit(2);
}

const root = join(import.meta.dirname, '..');
const running = await startServer(root, 4179);
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch();

try {
  for (const mode of MODES) {
    for (const width of WIDTHS) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: mode,
      });
      await page.goto(`${running.url}/host.html`);
      await page.locator('ujira-onboarding .heading').waitFor();
      await page.evaluate((next) => {
        document.body.dataset['mode'] = next;
        document.querySelector('ujira-onboarding')?.setAttribute('mode', next);
      }, mode);
      for (const step of STEPS) {
        if (step === 'review') {
          await page.locator('ujira-onboarding input.input').fill('Amara Eze');
          await page.locator('ujira-onboarding .primary').click();
          await page.locator('ujira-onboarding .primary').click();
          await page.locator('ujira-onboarding input.input').fill(WALLET);
          await page.locator('ujira-onboarding .primary').click();
        }
        await page.locator('ujira-onboarding .heading').waitFor();
        const path = join(folder, `embed-${step}-${String(width)}-${mode}.png`);
        await page.screenshot({ path, animations: 'disabled' });
        process.stdout.write(`${path}\n`);
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  await running.close();
}
