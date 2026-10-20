// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

import { testProjects } from './scripts/workspace.ts';

// Outside node_modules and the checkout, so the test step can run on a
// read-only checkout. One folder per checkout path keeps worktrees apart.
const hash = createHash('sha256')
  .update(import.meta.dirname)
  .digest('hex')
  .slice(0, 12);
const CACHE_DIR = join(tmpdir(), `ujira-vitest-${hash}`);

export default defineConfig({
  cacheDir: CACHE_DIR,
  test: {
    // Transformed modules, by default node_modules/.vitest-cache.
    fsModuleCachePath: join(CACHE_DIR, 'modules'),
    // Member projects are defined here rather than loaded from each member's
    // vitest.config, so code in a member cannot change what this run checks.
    projects: [
      ...testProjects(import.meta.dirname, {
        // Component tests are .tsx; the one that renders picks jsdom with a
        // `@vitest-environment jsdom` comment. The token generator has its
        // own tests next to it.
        '@ujira/ui': { include: ['src/**/*.test.{ts,tsx}', 'tokens/**/*.test.ts'] },
        // Component tests run in jsdom. The browser flows, visual snapshots
        // and accessibility checks are Playwright specs under e2e/.
        '@ujira/dashboard': {
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./src/test-setup.ts'],
        },
        // The spike tests start a Postgres container and real worker pools.
        // The Supabase spike runs against the staging project only when its
        // pooler URLs are in the environment, and skips everywhere else.
        '@ujira/db': {
          include: ['src/**/*.test.ts', 'spikes/**/*.test.ts'],
          hookTimeout: 180_000,
          testTimeout: 300_000,
        },
        '@ujira/payouts': {
          include: ['src/**/*.test.ts', 'spikes/**/*.test.ts'],
          hookTimeout: 180_000,
          testTimeout: 60_000,
        },
      }),
      { extends: true, test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
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
        'scripts/bundle-budget.ts',
        'scripts/gate.ts',
        'scripts/workspace.ts',
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
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.test-d.ts',
        '**/*.d.ts',
        // Built only to prove the bundle budget fails; see the dashboard README.
        '**/*.fixture.tsx',
      ],
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
        // The chain adapter is the only code that touches a chain, so it
        // carries the same bar.
        'packages/chain-adapter/src/**': {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
      },
    },
  },
});
