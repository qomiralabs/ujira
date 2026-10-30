// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Browser tests for the widget: theming, accessibility, the 320px layout and
// the time to interactive on a throttled connection. They run against the
// built file on a plain HTML page, the same way an integrator loads it.

import { defineConfig, devices } from '@playwright/test';

const PORT = 4178;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;
const inCi = process.env['CI'] === 'true';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: inCi,
  retries: 0,
  ...(inCi ? { workers: 1 } : {}),
  reporter: inCi ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Screenshots are compared per platform. Only the Linux baseline is
  // committed, and CI is the only thing that renders it: the job that
  // compares the image is the one that wrote it, so there is no second
  // source of truth for the same file. A run on any other platform writes
  // its own and is ignored.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  // Deliberately not an exact match. A layout that breaks at 320px moves
  // thousands of pixels, so one percent is far tighter than any real break
  // while absorbing the antialiasing noise between two machines. The
  // dashboard's suite takes exact match; that is its own call.
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Everything appears at rest, so a reading of a colour or a screenshot is
    // never caught mid transition. It is also how the widget behaves for
    // anyone who asks their system for less motion.
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tools/serve.ts ${String(PORT)}`,
    url: `${BASE_URL}/host.html`,
    reuseExistingServer: !inCi,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
