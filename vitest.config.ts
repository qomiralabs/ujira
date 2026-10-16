// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx,mts,cts}', 'apps/*/src/**/*.{ts,tsx,mts,cts}'],
      exclude: ['**/*.test.*', '**/*.d.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
        // Money and other core primitives sit under every payout, so they
        // carry a stricter bar than the rest of the repo.
        'packages/core/src/**': {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
      },
    },
  },
});
