// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/*',
      { extends: true, test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
    ],
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      include: [
        'packages/*/src/**/*.{ts,tsx,mts,cts}',
        'apps/*/src/**/*.{ts,tsx,mts,cts}',
        // Pure helpers of the root scripts. The entry points only do I/O and
        // are exercised by running them.
        'scripts/embedded-metadata.ts',
        'scripts/invisible-characters.ts',
        'scripts/license-policy.ts',
        'scripts/license-tree.ts',
        'scripts/lockfile.ts',
        'scripts/pnpm-command.ts',
        'scripts/strict-json.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
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
