// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { checkFixtures } from './check.js';
import { generateFixtures } from './index.js';

describe('fixture generator', () => {
  it('every generated fixture parses with its schema, and the same seed gives the same data', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.boolean(), (seed, edge) => {
        const first = generateFixtures({ seed, payouts: 60, edge });
        expect(checkFixtures(first)).toEqual([]);
        expect(generateFixtures({ seed, payouts: 60, edge })).toEqual(first);
      }),
      { numRuns: 40 },
    );
  }, 60_000);

  it('different seeds give different data', () => {
    const a = generateFixtures({ seed: 1 });
    const b = generateFixtures({ seed: 2 });
    expect(a.payouts[0]?.id).not.toEqual(b.payouts[0]?.id);
  });
});
