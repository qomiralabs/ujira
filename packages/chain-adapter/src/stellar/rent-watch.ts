// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Watches what rent costs, so a policy or price change never drains the fee
// sponsor unnoticed. Three alerts, each sent once per period:
//
// - the day's rent spend on a network passed its budget;
// - the next 30 days, projected from the last 7, cost more than the
//   sponsor holds;
// - the network's rent settings changed.
//
// Spend is recorded once per key, so a retried job never counts a payout
// twice. Storage is a port: the database adds its table later, and tests
// use the in-memory store from the testing entry.

import type { NetworkId } from '../networks.js';
import type { NativeAmount, PayoutId, TenantScope } from '../types.js';

import { xlm } from './rent-model.js';
import type { PayoutRentCost } from './rent-model.js';
import { rentSettingsFingerprint } from './rent-settings.js';
import type { SorobanRentSettings } from './rent-settings.js';

const SECONDS_PER_DAY = 86_400n;
const PROJECTION_DAYS = 30n;
const TRAILING_DAYS = 7n;

export type RentAlertKind = 'budget' | 'projection';

export interface RentSpendStore {
  /** Records a spend once per key. Returns false when the key was already recorded. */
  recordSpend(e: {
    readonly network: NetworkId;
    readonly key: string;
    /** The UTC day, YYYY-MM-DD. */
    readonly day: string;
    readonly stroops: bigint;
  }): Promise<boolean>;
  /** Total stroops recorded for the network on the UTC day. */
  spendOn(network: NetworkId, day: string): Promise<bigint>;
  /** Marks an alert sent for the period. Returns false when it already was. */
  markAlerted(network: NetworkId, kind: RentAlertKind, period: string): Promise<boolean>;
  settingsFingerprint(network: NetworkId): Promise<string | null>;
  saveSettingsFingerprint(network: NetworkId, fingerprint: string): Promise<void>;
}

export interface RentAlerts {
  rentBudgetExceeded(e: {
    readonly network: NetworkId;
    readonly day: string;
    readonly spent: NativeAmount;
    readonly budget: NativeAmount;
  }): void;
  rentProjectionExceedsBalance(e: {
    readonly network: NetworkId;
    readonly projected30Days: NativeAmount;
    readonly sponsorBalance: NativeAmount;
  }): void;
  rentSettingsChanged(e: {
    readonly network: NetworkId;
    readonly ledger: bigint;
    readonly previous: string;
    readonly current: string;
  }): void;
}

export interface RentMetrics {
  /** The rent part of the cost per payout, labelled with the payout's tenant. */
  payoutRent(e: {
    readonly scope: TenantScope;
    readonly network: NetworkId;
    readonly payoutId: PayoutId;
    readonly ttlLedgers: bigint;
    readonly rent: NativeAmount;
  }): void;
}

export interface RentWatchOptions {
  readonly store: RentSpendStore;
  readonly alerts: RentAlerts;
  readonly metrics: RentMetrics;
  /** The daily rent budget of each network, in stroops. */
  readonly dailyBudget: (network: NetworkId) => NativeAmount;
}

export interface RentWatch {
  /** Records a payout record's rent and reports it in the cost per payout metric. */
  payoutRent(e: {
    readonly scope: TenantScope;
    readonly payoutId: PayoutId;
    readonly cost: PayoutRentCost;
    readonly nowSeconds: bigint;
  }): Promise<void>;
  /** Records any other rent spend: an extension, a restore. `key` makes it count once. */
  spend(e: {
    readonly key: string;
    readonly amount: NativeAmount;
    readonly nowSeconds: bigint;
  }): Promise<void>;
  checkProjection(e: {
    readonly sponsorBalance: NativeAmount;
    readonly nowSeconds: bigint;
  }): Promise<void>;
  checkSettings(settings: SorobanRentSettings): Promise<void>;
}

/** The UTC day of a time, as YYYY-MM-DD. */
export function utcDay(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

export function createRentWatch(options: RentWatchOptions): RentWatch {
  const { store, alerts, metrics } = options;

  const checkBudget = async (network: NetworkId, day: string): Promise<void> => {
    const budget = options.dailyBudget(network);
    const spent = await store.spendOn(network, day);
    if (spent <= budget.amount) return;
    if (await store.markAlerted(network, 'budget', day)) {
      alerts.rentBudgetExceeded({ network, day, spent: xlm(network, spent), budget });
    }
  };

  const record = async (
    network: NetworkId,
    key: string,
    stroops: bigint,
    nowSeconds: bigint,
  ): Promise<boolean> => {
    const day = utcDay(nowSeconds);
    const added = await store.recordSpend({ network, key, day, stroops });
    if (added) await checkBudget(network, day);
    return added;
  };

  return {
    payoutRent: async ({ scope, payoutId, cost, nowSeconds }) => {
      const network = cost.total.network;
      const added = await record(network, `payout:${payoutId}`, cost.total.amount, nowSeconds);
      // Reported once, like the spend, so a retry does not count it twice.
      if (added) {
        metrics.payoutRent({
          scope,
          network,
          payoutId,
          ttlLedgers: cost.ttlLedgers,
          rent: cost.total,
        });
      }
    },

    spend: async ({ key, amount, nowSeconds }) => {
      await record(amount.network, key, amount.amount, nowSeconds);
    },

    checkProjection: async ({ sponsorBalance, nowSeconds }) => {
      const network = sponsorBalance.network;
      let trailing = 0n;
      for (let back = 0n; back < TRAILING_DAYS; back += 1n) {
        trailing += await store.spendOn(network, utcDay(nowSeconds - back * SECONDS_PER_DAY));
      }
      const projected = (trailing * PROJECTION_DAYS + TRAILING_DAYS - 1n) / TRAILING_DAYS;
      if (projected <= sponsorBalance.amount) return;
      if (await store.markAlerted(network, 'projection', utcDay(nowSeconds))) {
        alerts.rentProjectionExceedsBalance({
          network,
          projected30Days: xlm(network, projected),
          sponsorBalance,
        });
      }
    },

    checkSettings: async (settings) => {
      const current = rentSettingsFingerprint(settings);
      const previous = await store.settingsFingerprint(settings.network);
      if (previous === current) return;
      await store.saveSettingsFingerprint(settings.network, current);
      // The first reading is a baseline, not a change.
      if (previous !== null) {
        alerts.rentSettingsChanged({
          network: settings.network,
          ledger: settings.ledger,
          previous,
          current,
        });
      }
    },
  };
}
