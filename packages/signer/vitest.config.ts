// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// For runs from this folder, such as pnpm --filter @ujira/signer test. The
// root config defines this package's project for the repository run and
// carries the same coverage bar.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts'],
      reporter: ['text'],
      // The signer holds every key UJIRA signs with, so it carries the bar
      // the chain adapter and core carry.
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
