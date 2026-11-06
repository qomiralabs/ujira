// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { NetworkId, UnixSeconds, XlmRate } from '@ujira/chain-adapter';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { networkShortfall } from './shortfall.js';

const NETWORK: NetworkId = 'stellar:pubnet';
const amount = fc.bigInt({ min: 0n, max: 1_000_000_000_000n });
const positive = fc.bigInt({ min: 1n, max: 1_000_000_000_000_000n });

describe('networkShortfall properties', () => {
  it('shortfall is max(0, ceil-converted cost minus take)', async () => {
    await fc.assert(
      fc.asyncProperty(
        amount,
        amount,
        amount,
        positive,
        positive,
        async (resource, inclusion, take, numerator, denominator) => {
          const rate: XlmRate = {
            base: 'XLM',
            quote: 'USDC',
            numerator,
            denominator,
            source: 'stellar_dex',
            observedAt: 1_800_000_000n as UnixSeconds,
          };
          const result = await networkShortfall(
            { network: NETWORK, op: 'execute', legCount: 1, takeUsdcMinor: take },
            {
              estimateNetworkFee: () =>
                Promise.resolve({
                  source: 'estimate',
                  resourceFeeStroops: resource,
                  rentStroops: 0n,
                  inclusionFeeStroops: inclusion,
                }),
              xlmRate: () => Promise.resolve(rate),
            },
            { correlationId: 'property' },
          );
          if (result.status !== 'measured') throw new Error('expected a measurement');

          const cost = resource + inclusion;
          // Rounded up exactly once: the smallest whole number at or above the
          // exact value.
          expect(result.costUsdcMinor * denominator).toBeGreaterThanOrEqual(cost * numerator);
          expect((result.costUsdcMinor - 1n) * denominator).toBeLessThan(cost * numerator);

          const expected = result.costUsdcMinor > take ? result.costUsdcMinor - take : 0n;
          expect(result.shortfallUsdcMinor).toBe(expected);
          // The two units always agree on whether there is a shortfall.
          expect(result.shortfallStroops === 0n).toBe(result.shortfallUsdcMinor === 0n);
          expect(result.covered).toBe(result.shortfallUsdcMinor === 0n);
        },
      ),
      { numRuns: 300 },
    );
  });
});
