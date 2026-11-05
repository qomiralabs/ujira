// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for feeCap (fee-cap.ts).
 *
 * - feeCap(total, bps) is floor(total * bps / 10000), computed without ever
 *   forming total * bps, in the total's own token.
 * - It matches a plain big integer reference on every total up to i128 and
 *   every rate from 0 to 100, and every case of the mandate spec's shared
 *   edge fixture.
 * - A rate outside 0 to 100, or not a whole number, throws
 *   InvalidFeeBpsError. A total of zero or less throws InvalidFeeTotalError.
 */

import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InvalidFeeBpsError,
  InvalidFeeTotalError,
  MAX_FEE_BPS,
  feeBps,
  feeCap,
  tokenAmount,
} from '../index.js';

const I128_MAX = 2n ** 127n - 1n;
const RUNS = { seed: 0xfee, numRuns: 2000 } as const;
// Long enough for a loaded runner, short enough to catch a hang.
const PROPERTY_TIMEOUT_MS = 30_000;

const usdc = (amount: bigint) => tokenAmount(amount, 'USDC', 'stellar');

// The plain form, which forms the product. Exact in bigint, so it is the
// reference the overflow-free form must equal.
const reference = (total: bigint, bps: bigint): bigint => (total * bps) / 10_000n;

interface EdgeCase {
  readonly total: string;
  readonly max_fee_bps: number;
  readonly fee_cap: string;
}

function edgeCases(): readonly EdgeCase[] {
  const path = new URL('../../../chain-adapter/spec/fixtures/fee-cap-edges.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { readonly cases: readonly EdgeCase[] };
  return parsed.cases;
}

describe('fee-cap', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('matches a big integer reference on every total and rate', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: I128_MAX }),
        fc.integer({ min: 0, max: MAX_FEE_BPS }),
        (total, bps) => {
          expect(feeCap(usdc(total), bps).amount).toBe(reference(total, BigInt(bps)));
        },
      ),
      RUNS,
    );
  });

  it('matches every case of the shared edge fixture from the mandate spec', () => {
    const cases = edgeCases().filter((c) => BigInt(c.total) > 0n);
    expect(cases.length).toBeGreaterThan(10);
    for (const c of cases) {
      expect(feeCap(usdc(BigInt(c.total)), c.max_fee_bps).amount, JSON.stringify(c)).toBe(
        BigInt(c.fee_cap),
      );
    }
  });

  it('never exceeds the rate and keeps the token', () => {
    const fee = feeCap(usdc(123_456n), 100);
    expect(fee.amount).toBe(1_234n);
    expect(fee.asset).toBe('USDC');
    expect(fee.chain).toBe('stellar');
    expect(fee.scale).toBe(7);
    expect(feeCap(usdc(9_999n), 1).amount).toBe(0n);
    expect(feeCap(usdc(I128_MAX), 100).amount).toBe(reference(I128_MAX, 100n));
  });

  it.each([-1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses a rate of %s', (bps) => {
    expect(() => feeCap(usdc(1n), bps)).toThrow(InvalidFeeBpsError);
    expect(() => feeBps(bps)).toThrow(InvalidFeeBpsError);
  });

  it('refuses a total of zero or less', () => {
    expect(() => feeCap(usdc(0n), 50)).toThrow(InvalidFeeTotalError);
    expect(() => feeCap(usdc(-1n), 50)).toThrow(InvalidFeeTotalError);
  });

  it('has stable codes', () => {
    expect(new InvalidFeeBpsError().code).toBe('INVALID_FEE_BPS');
    expect(new InvalidFeeTotalError().code).toBe('INVALID_FEE_TOTAL');
  });
});
