// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import {
  InternalError,
  RateUnavailableError,
  createUncoveredBudget,
  monthOf,
} from '@ujira/chain-adapter';
import type { NetworkId, NetworksConfig, UnixSeconds, XlmRate } from '@ujira/chain-adapter';
import { createMemorySponsorshipLedger } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { networkFeeEstimator } from './fee-estimates.js';
import type { FeeEstimateRow } from './fee-estimates.js';
import { breakEvenMinimum, networkShortfall, shortfallAccounting } from './shortfall.js';

const NETWORK: NetworkId = 'stellar:pubnet';
const OPTS = { correlationId: 'shortfall-test' };

const ROW: FeeEstimateRow = {
  network: NETWORK,
  op: 'execute',
  legCount: 1,
  // With the 12 percent margin: 1,000,000 + 112,000.
  p95ResourceFeeStroops: 892_858n,
  p95RentStroops: 400_000n,
  p95InclusionFeeStroops: 100_000n,
  sampleCount: 25,
  windowStart: new Date('2026-10-26T00:00:00Z'),
  windowEnd: new Date('2026-11-02T00:00:00Z'),
  computedAt: new Date('2026-11-02T00:00:00Z'),
};

const RATE: XlmRate = {
  base: 'XLM',
  quote: 'USDC',
  // 0.17 USDC per XLM.
  numerator: 17n,
  denominator: 100n,
  source: 'stellar_dex',
  observedAt: 1_800_000_000n as UnixSeconds,
};

const estimateNetworkFee = networkFeeEstimator({ lookup: () => Promise.resolve(ROW) });
const payout = (takeUsdcMinor: bigint) => ({
  network: NETWORK,
  op: 'execute' as const,
  legCount: 1,
  takeUsdcMinor,
});
const ports = { estimateNetworkFee, xlmRate: () => Promise.resolve(RATE) };

describe('networkShortfall', () => {
  // resource 892,858 * 1.12 = 1,000,000.96, up to 1,000,001; inclusion 100,000
  // * 1.12 = 112,000. Cost 1,112,001 stroops. At 0.17: 189,040.17, up to 189,041.
  const COST_STROOPS = 1_112_001n;
  const COST_USDC = 189_041n;

  it('counts the resource fee and the inclusion share, without counting rent twice', async () => {
    const result = await networkShortfall(payout(0n), ports, OPTS);
    expect(result).toMatchObject({
      status: 'measured',
      covered: false,
      costStroops: COST_STROOPS,
      costUsdcMinor: COST_USDC,
      shortfallUsdcMinor: COST_USDC,
      shortfallStroops: COST_STROOPS,
    });
  });

  it('is zero in both units once the take covers the cost, exactly at the edge', async () => {
    const covered = await networkShortfall(payout(COST_USDC), ports, OPTS);
    expect(covered).toMatchObject({
      covered: true,
      shortfallUsdcMinor: 0n,
      shortfallStroops: 0n,
    });
    const short = await networkShortfall(payout(COST_USDC - 1n), ports, OPTS);
    expect(short).toMatchObject({ covered: false, shortfallUsdcMinor: 1n });
    if (short.status !== 'measured') throw new Error('expected a measurement');
    expect(short.shortfallStroops).toBeGreaterThan(0n);
  });

  it('RATE_UNAVAILABLE treats the payout as not covered by the take', async () => {
    const result = await networkShortfall(
      payout(10_000_000_000n),
      { estimateNetworkFee, xlmRate: () => Promise.reject(new RateUnavailableError()) },
      OPTS,
    );
    expect(result).toEqual({
      status: 'rate_unavailable',
      covered: false,
      costStroops: COST_STROOPS,
    });
  });

  it('does not hide any other failure behind not covered', async () => {
    const failure = new InternalError();
    await expect(
      networkShortfall(
        payout(0n),
        { estimateNetworkFee, xlmRate: () => Promise.reject(failure) },
        OPTS,
      ),
    ).rejects.toBe(failure);
  });

  it('falls back to the simulation when there is no estimate, through the estimator', async () => {
    const fromSimulation = networkFeeEstimator({ lookup: () => Promise.resolve(undefined) });
    const result = await networkShortfall(
      {
        ...payout(0n),
        simulation: { resourceFeeStroops: 100n, rentStroops: 10n, inclusionFeeStroops: 100n },
      },
      { estimateNetworkFee: fromSimulation, xlmRate: () => Promise.resolve(RATE) },
      OPTS,
    );
    // 112 + 112.
    expect(result.costStroops).toBe(224n);
  });
});

describe('breakEvenMinimum', () => {
  it('is ceil(cost x 10000 / take bps)', () => {
    expect(breakEvenMinimum(1_000n, 50n)).toBe(200_000n);
    expect(breakEvenMinimum(1_001n, 30n)).toBe(333_667n);
    expect(() => breakEvenMinimum(1n, 0n)).toThrow(RangeError);
  });
});

const JAN_31 = 1_801_439_999n; // 2027-01-31T23:59:59Z
const FEB_01 = 1_801_440_000n;

function accounting(monthlyBudgetStroops: bigint) {
  const clock = { now: JAN_31 };
  const nowSeconds = (): UnixSeconds => clock.now as UnixSeconds;
  const config = {
    [NETWORK]: { fees: { uncoveredNetworkCost: { monthlyBudgetStroops } } },
  } as unknown as NetworksConfig;
  const budget = createUncoveredBudget({
    ledger: createMemorySponsorshipLedger(),
    config: () => config,
    clock: { nowSeconds },
  });
  const alerts: unknown[] = [];
  const marked = new Set<string>();
  const books = shortfallAccounting({
    budget,
    month: () => monthOf(nowSeconds()),
    markBudgetAlert: (network, month) => {
      const key = `${network} ${month}`;
      if (marked.has(key)) return Promise.resolve(false);
      marked.add(key);
      return Promise.resolve(true);
    },
    alertBudgetSpent: (e) => alerts.push(e),
  });
  return { books, clock, alerts };
}

const minimumInput = (method: string) => ({
  network: NETWORK,
  method,
  floorUsdcMinor: 1_000n,
  takeBps: 50n,
  estimatedCostUsdcMinor: 1_000n,
  shortfallStroops: 10n,
});

describe('the monthly budget', () => {
  it("with the month's budget spent, breakEvenMinimum applies to wallet and mobile money only and resets next month", async () => {
    const { books, clock, alerts } = accounting(100n);

    // While the budget lasts, every method keeps its floor.
    expect(await books.minimum(minimumInput('stellar_wallet'))).toBe(1_000n);
    expect(await books.record(NETWORK, 100n)).toBe(100n);

    expect(await books.minimum(minimumInput('stellar_wallet'))).toBe(200_000n);
    expect(await books.minimum(minimumInput('mobile_money'))).toBe(200_000n);
    expect(await books.minimum(minimumInput('bank'))).toBe(1_000n);
    expect(await books.minimum(minimumInput('cash_pickup'))).toBe(1_000n);
    // Operations heard once, however many payouts asked.
    expect(alerts).toEqual([{ network: NETWORK, month: '2027-01' }]);

    clock.now = FEB_01;
    expect(await books.minimum(minimumInput('stellar_wallet'))).toBe(1_000n);
    expect(alerts).toHaveLength(1);
  });

  it('alerts once per month, so a second spent month alerts again', async () => {
    const { books, clock, alerts } = accounting(5n);
    await books.record(NETWORK, 5n);
    await books.minimum(minimumInput('stellar_wallet'));
    clock.now = FEB_01;
    await books.record(NETWORK, 5n);
    await books.minimum(minimumInput('mobile_money'));
    expect(alerts).toEqual([
      { network: NETWORK, month: '2027-01' },
      { network: NETWORK, month: '2027-02' },
    ]);
  });

  it('a payout that needs nothing from the budget keeps its floor when the budget is spent', async () => {
    const { books } = accounting(5n);
    await books.record(NETWORK, 5n);
    expect(await books.minimum({ ...minimumInput('stellar_wallet'), shortfallStroops: 0n })).toBe(
      1_000n,
    );
  });

  it('never lowers a floor already above break-even', async () => {
    const { books } = accounting(0n);
    expect(
      await books.minimum({ ...minimumInput('stellar_wallet'), floorUsdcMinor: 500_000n }),
    ).toBe(500_000n);
  });
});
