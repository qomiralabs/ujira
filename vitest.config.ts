// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { defineConfig } from 'vitest/config';

import { testProjects } from './scripts/workspace.ts';

export default defineConfig({
  test: {
    // Member projects are defined here rather than loaded from each member's
    // vitest.config, so code in a member cannot change what this run checks.
    projects: [
      ...testProjects(import.meta.dirname),
      { test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
    ],
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      include: [
        'packages/*/src/**/*.{ts,tsx,mts,cts}',
        'apps/*/src/**/*.{ts,tsx,mts,cts}',
        // Root scripts that the gate depends on.
        'scripts/check-workspace-scripts.ts',
        'scripts/gate.ts',
        'scripts/workspace.ts',
        // Pure helpers of the root scripts. The entry points only do I/O and
        // are exercised by running them.
        'scripts/license-policy.ts',
        'scripts/license-tree.ts',
        'scripts/lockfile.ts',
        'scripts/pnpm-command.ts',
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
