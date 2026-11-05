// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ujira/payouts',
    include: ['src/**/*.test.ts', 'spikes/**/*.test.ts'],
    // The worker's tests start a Postgres container and real worker pools.
    hookTimeout: 180000,
    testTimeout: 60000,
    globalSetup: ['../db/src/testing/global-setup.ts'],
  },
});
