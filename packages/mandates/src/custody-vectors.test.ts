// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandates package's custody rule, held to the cases the signer's copy is held to.

import { describe, expect, it } from 'vitest';

import { CUSTODY_VECTORS, allowsManagedAgent } from './index.js';

describe('the custody rule', () => {
  it.each(CUSTODY_VECTORS)('seats %j are allowed: $allowed', ({ seats, allowed }) => {
    expect(seats.every(allowsManagedAgent)).toBe(allowed);
  });
});
