// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { defineConfig, devices } from '@playwright/test';

const PORT = 3200;
const CI = process.env['CI'] === 'true';

// Runs against the production build, so build first. Visual baselines are
// rendered on Linux, the platform CI runs on; see the README for refreshing
// them from macOS or Windows.
export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{platform}{ext}',
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  ...(CI ? { workers: 2 } : {}),
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: 'retain-on-failure',
  },
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node node_modules/next/dist/bin/next start --port ${String(PORT)}`,
    cwd: import.meta.dirname,
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: !CI,
    env: { NEXT_TELEMETRY_DISABLED: '1' },
  },
});
