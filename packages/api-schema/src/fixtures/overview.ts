// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Deterministic overview numbers for the screen to render against. The same
// seed always gives the same data. The set deliberately includes what the
// screen must handle and cannot otherwise see: a mandate with no spend and
// so no runway, a fifth corridor folded into one series, a period in which
// nothing happened, and a principal paying in more than one dollar currency.

import { SETTLEMENT_TOKENS, money, tokenAmount } from '@ujira/core';
import type { FiatCurrencyCode } from '@ujira/core';

import type { NetworkId } from '../common.js';
import { toWireMoney, toWireToken } from '../money.js';
import type { Money } from '../money.js';
import type { OverviewStats, StatsPeriod, StatsSeries } from '../stats.js';
import { OTHER_SERIES_KEY } from '../stats.js';
import { Rng } from './rng.js';

function settlementTokenOrThrow(): (typeof SETTLEMENT_TOKENS)[number] {
  const found = SETTLEMENT_TOKENS[0];
  if (found === undefined) throw new RangeError('no settlement token is configured');
  return found;
}
const TOKEN = settlementTokenOrThrow();

const DAY_MS = 86_400_000;
/** Fixed so a fixture never moves with the clock. */
const BASE_TIME = Date.parse('2026-09-15T00:00:00.000Z');

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A principal in Lagos, so a boundary-crossing test has a non-UTC zone to
 * assert against rather than one where every day starts at midnight UTC.
 */
export const FIXTURE_TIME_ZONE = 'Africa/Lagos';

// Corridors the fixture pays, more than a chart draws, which is what makes
// the collected series necessary.
const CORRIDORS: readonly (readonly [string, string])[] = [
  ['NG', 'Nigeria'],
  ['KE', 'Kenya'],
  ['PH', 'Philippines'],
  ['BR', 'Brazil'],
  ['CO', 'Colombia'],
  ['MX', 'Mexico'],
  ['IN', 'India'],
];

// A principal whose corridors share the dollar sign, so the screen has to
// print the code beside each amount.
const DOLLAR_CURRENCIES: readonly FiatCurrencyCode[] = ['USD', 'COP', 'MXN'];

const STATUS_SERIES = ['paid', 'delivering', 'pending_approval', 'blocked'] as const;

export interface OverviewFixtureOptions {
  readonly seed: number;
  readonly period?: StatsPeriod;
  /** Number of buckets on the time axis. */
  readonly buckets?: number;
  /** An empty period: no payouts, no spend, nothing to chart. */
  readonly zero?: boolean;
}

const BUCKET_DAYS: Readonly<Record<StatsPeriod, number>> = Object.freeze({
  day: 1,
  week: 7,
  month: 30,
});

function wireMoney(minor: bigint, currency: FiatCurrencyCode): Money {
  return toWireMoney(money(minor, currency));
}

function token(amount: bigint, network: NetworkId): OverviewStats['mandates'][number]['balance'] {
  return toWireToken(tokenAmount(amount, TOKEN.asset, TOKEN.chain), network);
}

/** One series over the axis, with its own currency and a zero bucket or two. */
function series(
  rng: Rng,
  key: string,
  label: string,
  bucketCount: number,
  currency: FiatCurrencyCode,
  zero: boolean,
): StatsSeries {
  const points = Array.from({ length: bucketCount }, (_, i) => {
    // A quiet bucket is zero in both the amount and the count.
    const quiet = zero || (i % 5 === 3 && rng.chance(60));
    if (quiet) return { amount: wireMoney(0n, currency), count: 0 };
    const count = rng.between(1, 40);
    return {
      amount: wireMoney(BigInt(count) * BigInt(rng.between(500, 50_000)), currency),
      count,
    };
  });
  return { key, label, points };
}

/** The overview response for one project, built from a seed. */
export function overviewFixture(options: OverviewFixtureOptions): OverviewStats {
  const rng = new Rng(options.seed);
  const period = options.period ?? 'day';
  const zero = options.zero ?? false;
  const bucketCount = options.buckets ?? 14;
  const network: NetworkId = 'stellar:testnet';

  const span = BUCKET_DAYS[period] * DAY_MS;
  const currentTo = BASE_TIME;
  const currentFrom = currentTo - span;
  const axisFrom = currentTo - bucketCount * span;
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    from: iso(axisFrom + i * span),
    to: iso(axisFrom + (i + 1) * span),
  }));

  // Paid totals per currency, never summed into one figure.
  const paid = zero
    ? []
    : DOLLAR_CURRENCIES.map((currency) =>
        wireMoney(BigInt(rng.between(50_000, 5_000_000)), currency),
      ).sort((a, b) => (a.currency < b.currency ? -1 : 1));
  const completedCount = zero ? 0 : rng.between(12, 400);

  const previousPaid = zero
    ? []
    : DOLLAR_CURRENCIES.map((currency) =>
        wireMoney(BigInt(rng.between(50_000, 5_000_000)), currency),
      ).sort((a, b) => (a.currency < b.currency ? -1 : 1));
  const previousCompleted = zero ? 0 : rng.between(12, 400);

  // Four named corridors plus everything else collected last.
  const named = CORRIDORS.slice(0, 4);
  const volumeByCorridor: StatsSeries[] = [
    ...named.map(([code, label], i) =>
      series(
        rng,
        code,
        label,
        bucketCount,
        DOLLAR_CURRENCIES[i % DOLLAR_CURRENCIES.length] ?? 'USD',
        zero,
      ),
    ),
    series(rng, OTHER_SERIES_KEY, 'Other', bucketCount, 'USD', zero),
  ];
  const volumeByStatus: StatsSeries[] = STATUS_SERIES.map((status) =>
    series(rng, status, status.replace(/_/g, ' '), bucketCount, 'USD', zero),
  );

  const unit = 10_000_000n;
  const mandates = Array.from({ length: 4 }, (_, i) => {
    // The first mandate has never spent, so its runway is unknown rather
    // than a division by zero.
    const idle = i === 0 || zero;
    const spend = idle ? 0n : BigInt(rng.between(1, 400)) * unit;
    const balance = BigInt(rng.between(0, 20_000)) * unit;
    const committed = BigInt(rng.between(0, 500)) * unit;
    return {
      mandateId: rng.uuid(),
      instanceId: rng.uuid(),
      network,
      balance: token(balance, network),
      committed: token(committed, network),
      averageDailySpend: token(spend, network),
      runwayDays: spend === 0n ? null : Number(balance / spend),
    };
  });

  const corridors = CORRIDORS.map(([country, label], i) => ({
    country,
    label,
    paid: zero
      ? []
      : [
          wireMoney(
            BigInt(rng.between(10_000, 900_000)),
            DOLLAR_CURRENCIES[i % DOLLAR_CURRENCIES.length] ?? 'USD',
          ),
        ],
    count: zero ? 0 : rng.between(1, 120),
  }));

  return {
    principalId: rng.uuid(),
    projectId: rng.uuid(),
    period,
    timeZone: FIXTURE_TIME_ZONE,
    current: {
      from: iso(currentFrom),
      to: iso(currentTo),
      kpis: {
        paid,
        completedCount,
        medianSecondsToPaid: completedCount === 0 ? null : rng.between(40, 86_400),
        blockedCount: zero ? 0 : rng.between(0, 12),
      },
    },
    previous: {
      from: iso(currentFrom - span),
      to: iso(currentFrom),
      kpis: {
        paid: previousPaid,
        completedCount: previousCompleted,
        medianSecondsToPaid: previousCompleted === 0 ? null : rng.between(40, 86_400),
        blockedCount: zero ? 0 : rng.between(0, 12),
      },
    },
    buckets,
    volumeByCorridor,
    volumeByStatus,
    mandates,
    corridors,
    approvalsWaiting: zero ? 0 : rng.between(0, 9),
  };
}

/** The named cases the overview screen has to render. */
export function overviewFixtures(seed = 314): Readonly<Record<string, OverviewStats>> {
  return Object.freeze({
    daily: overviewFixture({ seed, period: 'day' }),
    weekly: overviewFixture({ seed: seed + 1, period: 'week', buckets: 12 }),
    monthly: overviewFixture({ seed: seed + 2, period: 'month', buckets: 12 }),
    // Nothing happened: every number is zero or absent, and the screen still
    // has to draw an axis.
    zero: overviewFixture({ seed: seed + 3, period: 'day', zero: true }),
  });
}
