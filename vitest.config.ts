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
      },
    },
  },
});
