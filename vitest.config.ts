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
        // The widget's own tests, plus the generator that turns the shared
        // tokens and the brand mark into the files it ships. The browser
        // tests live in e2e/ and run under Playwright, not here.
        '@ujira/embed': { include: ['src/**/*.test.ts', 'tokens/**/*.test.ts'] },
        // Component tests run in jsdom. The browser flows, visual snapshots
        // and accessibility checks are Playwright specs under e2e/.
        '@ujira/dashboard': {
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./src/test-setup.ts'],
        },
        // The Supabase spike runs against the staging project only when its
        // pooler URLs are in the environment, and skips everywhere else,
        // including in CI. The src tests start a Postgres container through
        // the global setup below, which needs a docker daemon: they fail
        // without one rather than skipping, so an empty run cannot look
        // like a passing one.
        '@ujira/db': {
          include: ['src/**/*.test.ts', 'spikes/**/*.test.ts'],
          hookTimeout: 180_000,
          testTimeout: 300_000,
          // One container for the whole run, migrated once into a template
          // database, with a fresh database cloned from it per test file.
          globalSetup: ['src/testing/global-setup.ts'],
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
        'scripts/page-performance.ts',
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
        // Generated from the migrations by scripts/db-types.ts, and types
        // only, so there is nothing in it to execute.
        'packages/db/src/schema.generated.ts',
        // These two are the only code here that runs in the vitest global
        // setup, in the main process, where the workers' coverage
        // instrumentation cannot see them: they report zero statements and
        // zero functions however well they work. The rest of the harness
        // runs in the workers and is measured, which is why the container
        // start was moved into its own file rather than excluding the whole
        // folder. Their behaviour is covered by harness.test.ts against a
        // real container. Named one by one on purpose: a pattern over the
        // folder would silently exclude the next file put there, which QA
        // confirmed by dropping an uncovered file in and watching it report
        // zero.
        'packages/db/src/testing/global-setup.ts',
        'packages/db/src/testing/container.ts',
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
        // Every row of every tenant passes through the database package, so
        // it carries 90 rather than the repository's 85. That is above the
        // default and below the 95 that core and the chain adapter carry,
        // because those two are the money and chain primitives. Three files
        // are left out of the measurement by the exclude list above: the
        // generated schema types, which are types only, and the two that
        // run in the global setup.
        'packages/db/src/**': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // The chain adapter is the only code that touches a chain, so it
        // carries the same bar.
        'packages/chain-adapter/src/**': {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
        // The router decides where every payout goes and which configuration
        // is live, so it carries the same bar as the adapter.
        'packages/router/src/**': {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
      },
    },
  },
});
