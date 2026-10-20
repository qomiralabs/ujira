// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs every story of the built catalogue in a real browser: axe in light
// and dark, the keyboard focus ring, and visual snapshots. Build the
// catalogue first with `pnpm --filter @ujira/ui build-storybook`.

import { defineConfig, devices } from '@playwright/test';

const PORT = 6007;
const inCi = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: 'e2e',
  // One file per snapshot name, with no platform suffix: snapshots are only
  // taken on Linux, inside the pinned Playwright container.
  snapshotPathTemplate: '{testDir}/__snapshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: inCi,
  retries: 0,
  reporter: inCi ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'retain-on-failure',
  },
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 640 } },
    },
  ],
  webServer: {
    command: 'node e2e/serve.ts',
    env: { CATALOGUE_PORT: String(PORT) },
    url: `http://127.0.0.1:${String(PORT)}/iframe.html`,
    reuseExistingServer: !inCi,
    stdout: 'ignore',
  },
});
