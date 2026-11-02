// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import type { NetworksConfig } from '../config.js';
import { InvalidInputError, UnsupportedError } from '../errors.js';
import { networksConfig } from '../stellar/test-adapter.js';
import { accountFromSeed } from '../testing/address.js';
import { createMemorySponsorshipLedger } from '../testing/sponsorship-ledger.js';
import type { UnixSeconds } from '../types.js';
import { createUncoveredBudget, monthOf } from './policy.js';

const NETWORK = 'stellar:testnet' as const;
// 2027-01-31T23:59:59Z, the last second of a month.
const END_OF_MONTH = 1_801_439_999n;

function world(monthlyBudgetStroops: bigint) {
  const base = networksConfig({
    sponsor: accountFromSeed(new Uint8Array(32).fill(1)),
    channel: accountFromSeed(new Uint8Array(32).fill(2)),
  });
  const net = base[NETWORK];
  if (net === undefined) throw new Error('no network');
  const config: NetworksConfig = {
    ...base,
    [NETWORK]: { ...net, fees: { uncoveredNetworkCost: { monthlyBudgetStroops } } },
  };
  const clock = { now: END_OF_MONTH };
  const budget = createUncoveredBudget({
    ledger: createMemorySponsorshipLedger(),
    config: () => config,
    clock: { nowSeconds: () => clock.now as UnixSeconds },
  });
  return { budget, clock };
}

describe('the uncovered network cost budget', { timeout: 30_000 }, () => {
  it('shortfalls add up per network and month and reset at the UTC boundary', async () => {
    const { budget, clock } = world(100n);
    expect(monthOf(END_OF_MONTH as UnixSeconds)).toBe('2027-01');
    expect(await budget.record(NETWORK, 60n)).toBe(60n);
    expect(await budget.record(NETWORK, 40n)).toBe(100n);
    expect(await budget.spent(NETWORK)).toBe(100n);
    expect(await budget.spent('stellar:pubnet')).toBe(0n);
    expect(await budget.covers(NETWORK, 0n)).toBe(true);
    expect(await budget.covers(NETWORK, 1n)).toBe(false);

    clock.now += 1n;
    expect(monthOf(clock.now as UnixSeconds)).toBe('2027-02');
    expect(await budget.spent(NETWORK)).toBe(0n);
    expect(await budget.covers(NETWORK, 100n)).toBe(true);
    expect(await budget.covers(NETWORK, 101n)).toBe(false);
  });

  it('absorbs nothing until a budget is configured, and refuses a bad amount or an unknown network', async () => {
    const base = networksConfig({
      sponsor: accountFromSeed(new Uint8Array(32).fill(1)),
      channel: accountFromSeed(new Uint8Array(32).fill(2)),
    });
    expect(base[NETWORK]?.fees.uncoveredNetworkCost.monthlyBudgetStroops).toBe(0n);
    const { budget } = world(0n);
    expect(await budget.covers(NETWORK, 1n)).toBe(false);
    expect(() => budget.record(NETWORK, -1n)).toThrow(InvalidInputError);
    await expect(budget.covers('stellar:pubnet', 1n)).rejects.toBeInstanceOf(UnsupportedError);
  });
});
