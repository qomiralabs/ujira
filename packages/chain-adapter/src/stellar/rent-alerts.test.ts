// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { InMemoryRentStore } from '../testing/rent-store.js';
import type { NativeAmount, PayoutId, TenantScope, Uuid } from '../types.js';

import { xlm } from './rent-model.js';
import type { PayoutRentCost } from './rent-model.js';
import { decodeRentSettings } from './rent-settings.js';
import recorded from './testnet-rent-settings.json' with { type: 'json' };
import { createRentWatch, utcDay } from './rent-watch.js';
import type { RentAlerts, RentMetrics } from './rent-watch.js';

const NETWORK = 'stellar:testnet';
const DAY = 86_400n;
// 2026-11-01T10:00:00Z
const NOW = 1_793_527_200n;
const SCOPE: TenantScope = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12' as Uuid,
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04' as Uuid,
};

const payoutId = (n: number): PayoutId => `0x${n.toString(16).padStart(64, '0')}` as PayoutId;

const cost = (stroops: bigint): PayoutRentCost => ({
  ttlLedgers: 535_680n,
  recordRent: xlm(NETWORK, stroops - 1_271n),
  ttlWrite: xlm(NETWORK, 1_271n),
  total: xlm(NETWORK, stroops),
});

interface Sent {
  kind: string;
  e: unknown;
}

function setup(budget = 1_000_000n) {
  const sent: Sent[] = [];
  const reported: Parameters<RentMetrics['payoutRent']>[0][] = [];
  const alerts: RentAlerts = {
    rentBudgetExceeded: (e) => sent.push({ kind: 'budget', e }),
    rentProjectionExceedsBalance: (e) => sent.push({ kind: 'projection', e }),
    rentSettingsChanged: (e) => sent.push({ kind: 'settings', e }),
  };
  const store = new InMemoryRentStore();
  const watch = createRentWatch({
    store,
    alerts,
    metrics: { payoutRent: (e) => reported.push(e) },
    dailyBudget: (network) => xlm(network, budget),
  });
  return { watch, store, sent, reported };
}

describe('rent alerts', () => {
  it('daily spend over budget', async () => {
    const { watch, sent } = setup(1_000_000n);
    for (const n of [1, 2]) {
      await watch.payoutRent({
        scope: SCOPE,
        payoutId: payoutId(n),
        cost: cost(442_160n),
        nowSeconds: NOW,
      });
    }
    expect(sent).toEqual([]);
    // The third takes the day to 1,326,480, over the 1,000,000 budget.
    await watch.payoutRent({
      scope: SCOPE,
      payoutId: payoutId(3),
      cost: cost(442_160n),
      nowSeconds: NOW,
    });
    expect(sent).toEqual([
      {
        kind: 'budget',
        e: {
          network: NETWORK,
          day: '2026-11-01',
          spent: xlm(NETWORK, 1_326_480n),
          budget: xlm(NETWORK, 1_000_000n),
        },
      },
    ]);
    // Once a day, however much more is spent.
    await watch.spend({
      key: 'extend:instance',
      amount: xlm(NETWORK, 5_000_000n),
      nowSeconds: NOW,
    });
    expect(sent).toHaveLength(1);
    // The next day starts again.
    await watch.spend({
      key: 'extend:next',
      amount: xlm(NETWORK, 2_000_000n),
      nowSeconds: NOW + DAY,
    });
    expect(sent.map((s) => s.kind)).toEqual(['budget', 'budget']);
  });

  it('projection over sponsor balance', async () => {
    const { watch, sent } = setup(100_000_000n);
    // 7 days of 1 XLM: 7 XLM over 7 days projects to 30 XLM.
    for (let back = 0n; back < 7n; back += 1n) {
      await watch.spend({
        key: `day:${String(back)}`,
        amount: xlm(NETWORK, 10_000_000n),
        nowSeconds: NOW - back * DAY,
      });
    }
    await watch.checkProjection({ sponsorBalance: xlm(NETWORK, 300_000_000n), nowSeconds: NOW });
    expect(sent).toEqual([]);
    await watch.checkProjection({ sponsorBalance: xlm(NETWORK, 299_999_999n), nowSeconds: NOW });
    expect(sent).toEqual([
      {
        kind: 'projection',
        e: {
          network: NETWORK,
          projected30Days: xlm(NETWORK, 300_000_000n),
          sponsorBalance: xlm(NETWORK, 299_999_999n),
        },
      },
    ]);
    // Once a day.
    await watch.checkProjection({ sponsorBalance: xlm(NETWORK, 1n), nowSeconds: NOW });
    expect(sent).toHaveLength(1);
  });

  it('a change in network rent settings alerts once', async () => {
    const { watch, sent } = setup();
    const settings = decodeRentSettings(NETWORK, 5_502_731n, recorded.entries);
    // The first reading is the baseline.
    await watch.checkSettings(settings);
    // The state size and the ledger move on their own; that is not a change.
    await watch.checkSettings({ ...settings, ledger: 5_502_795n, averageStateSizeBytes: 1n });
    expect(sent).toEqual([]);
    const raised = { ...settings, ledger: 5_600_000n, persistentRentRateDenominator: 607n };
    await watch.checkSettings(raised);
    await watch.checkSettings(raised);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'settings',
      e: { network: NETWORK, ledger: 5_600_000n },
    });
  });

  it('counts a retried payout once and reports it once, labelled with its tenant', async () => {
    const { watch, store, reported } = setup();
    const e = { scope: SCOPE, payoutId: payoutId(9), cost: cost(442_160n), nowSeconds: NOW };
    await watch.payoutRent(e);
    await watch.payoutRent(e);
    expect(await store.spendOn(NETWORK, utcDay(NOW))).toBe(442_160n);
    expect(reported).toEqual([
      {
        scope: SCOPE,
        network: NETWORK,
        payoutId: payoutId(9),
        ttlLedgers: 535_680n,
        rent: xlm(NETWORK, 442_160n) satisfies NativeAmount,
      },
    ]);
  });

  it('reads days in UTC', () => {
    expect(utcDay(NOW)).toBe('2026-11-01');
    expect(utcDay(NOW + 14n * 3_600n)).toBe('2026-11-02');
  });
});
