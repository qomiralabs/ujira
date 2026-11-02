// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { defineConfig } from 'vitest/config';

// A full config rather than a project config so that running the package on
// its own with --coverage enforces the same bar as the root run. The root run
// takes coverage settings from the root config and ignores these.
export default defineConfig({
  test: {
    name: '@ujira/receipts',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx,mts,cts}'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: [['text', { skipFull: false }]],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
