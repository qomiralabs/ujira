// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@ujira/core', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@ujira/not-core');
  });
});
