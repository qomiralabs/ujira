// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import {
  FeeEstimateUnavailableError,
  NETWORK_FEE_MARGIN_BPS,
  networkFeeEstimator,
} from './fee-estimates.js';
import type { FeeEstimateRow } from './fee-estimates.js';

const ROW: FeeEstimateRow = {
  network: 'stellar:testnet',
  op: 'execute',
  legCount: 2,
  p95ResourceFeeStroops: 1_000n,
  p95RentStroops: 401n,
  p95InclusionFeeStroops: 1n,
  sampleCount: 25,
  windowStart: new Date('2026-10-26T00:00:00Z'),
  windowEnd: new Date('2026-11-02T00:00:00Z'),
  computedAt: new Date('2026-11-02T00:00:00Z'),
};

describe('estimateNetworkFee', () => {
  it('margin applied and rounded up, never down, with rent reported separately', async () => {
    const estimate = networkFeeEstimator({ lookup: () => Promise.resolve(ROW) });
    await expect(estimate('stellar:testnet', 'execute', 2)).resolves.toEqual({
      source: 'estimate',
      // 1000 * 1.12 is exact.
      resourceFeeStroops: 1_120n,
      // 401 * 1.12 is 449.12, and 1 * 1.12 is 1.12: both go up.
      rentStroops: 450n,
      inclusionFeeStroops: 2n,
    });
  });

  it('uses 12 percent unless told otherwise', async () => {
    expect(NETWORK_FEE_MARGIN_BPS).toBe(1_200n);
    const estimate = networkFeeEstimator({
      lookup: () => Promise.resolve(ROW),
      marginBps: 0n,
    });
    await expect(estimate('stellar:testnet', 'execute', 2)).resolves.toMatchObject({
      resourceFeeStroops: 1_000n,
      rentStroops: 401n,
    });
  });

  it('looks up the exact combination it was asked for', async () => {
    const asked: unknown[] = [];
    const estimate = networkFeeEstimator({
      lookup: (key) => {
        asked.push(key);
        return Promise.resolve(ROW);
      },
    });
    await estimate('stellar:pubnet', 'cancel_batch', 3);
    expect(asked).toEqual([{ network: 'stellar:pubnet', op: 'cancel_batch', legCount: 3 }]);
  });

  it('with no row, uses the request-time simulation fee plus the margin', async () => {
    const estimate = networkFeeEstimator({ lookup: () => Promise.resolve(undefined) });
    const simulated = await estimate('stellar:testnet', 'execute', 1, {
      resourceFeeStroops: 2_000n,
      rentStroops: 1_001n,
      inclusionFeeStroops: 100n,
    });
    expect(simulated).toEqual({
      source: 'simulation',
      resourceFeeStroops: 2_240n,
      // 1001 * 1.12 is 1121.12.
      rentStroops: 1_122n,
      inclusionFeeStroops: 112n,
    });
  });

  it('prefers a row to a simulation', async () => {
    const estimate = networkFeeEstimator({ lookup: () => Promise.resolve(ROW) });
    const result = await estimate('stellar:testnet', 'execute', 2, {
      resourceFeeStroops: 9n,
      rentStroops: 9n,
      inclusionFeeStroops: 9n,
    });
    expect(result.source).toBe('estimate');
  });

  it('with neither a row nor a simulation, says so rather than guessing', async () => {
    const estimate = networkFeeEstimator({ lookup: () => Promise.resolve(undefined) });
    await expect(estimate('stellar:testnet', 'execute', 1)).rejects.toThrow(
      FeeEstimateUnavailableError,
    );
  });
});
