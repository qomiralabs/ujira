// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RouteLeg } from '@ujira/router';

import { splitLegs, type LegShare } from './plan.js';
import { usdc } from './testing/usdc.js';

const main = (raw: bigint): RouteLeg => ({
  method: 'stellar_wallet',
  currency: 'USDC',
  amount: usdc(raw),
});

const shares = (weights: readonly bigint[]): readonly LegShare[] =>
  weights.map((weight, index) => ({
    method: index === 0 ? 'stellar_wallet' : 'bank',
    currency: index === 0 ? 'USDC' : 'NGN',
    weight,
  }));

const weights = fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 2, maxLength: 4 });
const total = fc.bigInt({ min: 1n, max: 1_000_000_000_000_000n });

describe('leg allocation', () => {
  it('legs always sum to the total, in any split', () => {
    fc.assert(
      fc.property(total, weights, (raw, split) => {
        const legs = splitLegs(usdc(raw), shares(split), main(raw));
        expect(legs.reduce((sum, leg) => sum + leg.amount.amount, 0n)).toBe(raw);
        for (const leg of legs) expect(leg.amount.amount).toBeGreaterThan(0n);
      }),
    );
  });

  it('the remainder is on the first leg, and no other leg is more than its share', () => {
    fc.assert(
      fc.property(total, weights, (raw, split) => {
        const legs = splitLegs(usdc(raw), shares(split), main(raw));
        if (legs.length < 2) return;
        const sum = split.reduce((all, weight) => all + weight, 0n);
        for (const [index, leg] of legs.entries()) {
          if (index === 0) continue;
          expect(leg.amount.amount).toBe((raw * (split[index] ?? 0n)) / sum);
        }
      }),
    );
  });

  it('a split with a leg of nothing does not stand', () => {
    const legs = splitLegs(usdc(1n), shares([1n, 1n]), main(1n));
    expect(legs.map((leg) => leg.amount.amount)).toEqual([1n]);
    expect(legs[0]?.method).toBe('stellar_wallet');
  });

  it('with no split, the main method takes it all', () => {
    expect(splitLegs(usdc(5n), [], main(5n)).map((leg) => leg.amount.amount)).toEqual([5n]);
    expect(splitLegs(usdc(5n), shares([1n]), main(5n))).toHaveLength(1);
  });
});
