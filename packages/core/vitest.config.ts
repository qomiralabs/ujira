// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ujira/core',
    include: ['src/**/*.test.ts'],
  },
});
