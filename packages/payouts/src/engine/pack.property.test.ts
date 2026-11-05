// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { packExecutes, packRequests, transfersOf } from './pack.js';

const item = fc.record({
  legs: fc.integer({ min: 1, max: 4 }),
  fee: fc.bigInt({ min: 0n, max: 1_000n }),
});

describe('packing', () => {
  it('every packed execute batch has at most 18 transfers and 10 items', () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 200 }), (items) => {
        const packs = packExecutes(items, (one) => one);
        for (const pack of packs) {
          expect(pack.length).toBeGreaterThan(0);
          expect(pack.length).toBeLessThanOrEqual(10);
          expect(pack.reduce((sum, one) => sum + transfersOf(one), 0)).toBeLessThanOrEqual(18);
        }
        expect(packs.flat()).toEqual(items);
      }),
    );
  });

  it('every request batch has at most 10 items, and none is lost', () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 200 }), (items) => {
        const packs = packRequests(items);
        for (const pack of packs) expect(pack.length).toBeLessThanOrEqual(10);
        expect(packs.flat()).toEqual(items);
      }),
    );
  });
});
