// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { SWEEP_GRACE_SECONDS } from './mandate-constants.js';
import { SPEC_CONSTANTS } from './testing/spec.js';

describe('mandate constants', () => {
  it('match the contract spec', () => {
    expect(SWEEP_GRACE_SECONDS).toBe(BigInt(SPEC_CONSTANTS['SWEEP_GRACE_SECONDS'] ?? -1));
  });
});
