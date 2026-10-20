// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The overview numbers: what no list endpoint gives directly. These are a
// business record rather than a view, so the window a response was computed
// over travels with it: the reporting time zone comes from the principal and
// a request cannot override it.

import { z } from 'zod';

import { CountryCode, NetworkId, Timestamp, Uuid, tenantFields } from './common.js';
import { PayoutStatus } from './enums.js';
import { Money, TokenAmount, minorUnitsOf } from './money.js';

export const STATS_PERIODS = Object.freeze(['day', 'week', 'month'] as const);
export const StatsPeriod = z.enum(STATS_PERIODS);
export type StatsPeriod = z.infer<typeof StatsPeriod>;

/**
 * The longest range a single request may ask for. A year of daily buckets is
 * the widest chart the overview draws, and the bound keeps the response and
 * the query behind it bounded whatever the period.
 */
export const MAX_STATS_RANGE_DAYS = 366;
const MAX_RANGE_MS = MAX_STATS_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** The key a series carries when it holds everything outside the top entries. */
export const OTHER_SERIES_KEY = 'other';

/** At most four named series plus `other`. */
export const MAX_STATS_SERIES = 5;

/**
 * Rules every list of per-currency totals in a stats response obeys, written
 * here once because three shapes carry such a list and a rule kept in one of
 * them is a rule the other two quietly lack.
 */
function checkMoneyList(amounts: readonly Money[], ctx: z.RefinementCtx, path: string): void {
  const currencies = amounts.map((m) => m.currency);
  if (new Set(currencies).size !== currencies.length) {
    ctx.addIssue({ code: 'custom', path: [path], message: 'one entry per currency' });
  }
  if ([...currencies].sort().join() !== currencies.join()) {
    ctx.addIssue({ code: 'custom', path: [path], message: 'currencies must be sorted' });
  }
}

/**
 * A count and the money behind it agree: nothing counted means nothing paid,
 * and an amount means at least one payout produced it.
 */
function checkCountAgainstAmounts(
  count: number,
  amounts: readonly Money[],
  ctx: z.RefinementCtx,
  path: string,
): void {
  const total = amounts.reduce<bigint>((acc, m) => acc + (minorUnitsOf(m.amount) ?? 0n), 0n);
  if (count > 0 && total === 0n) {
    ctx.addIssue({ code: 'custom', path: [path], message: 'a counted total has an amount' });
  }
  if (count === 0 && total > 0n) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      message: 'an amount came from at least one payout',
    });
  }
}

export const StatsWindow = z
  .strictObject({ from: Timestamp, to: Timestamp })
  .refine((w) => Date.parse(w.from) < Date.parse(w.to), {
    message: 'from must be before to',
    path: ['from'],
  });

export const OverviewKpis = z
  .strictObject({
    /** One entry per currency, never converted into a single total. */
    paid: z.array(Money).max(24),
    completedCount: z.number().int().min(0),
    /**
     * Null exactly when nothing was paid in the window, never zero, which
     * would read as instant, and never absent for a window that did pay.
     */
    medianSecondsToPaid: z.number().int().min(0).nullable(),
    blockedCount: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    checkMoneyList(value.paid, ctx, 'paid');
    checkCountAgainstAmounts(value.completedCount, value.paid, ctx, 'paid');
    // Both directions, so the absence carries one meaning only: nothing was
    // paid. A completed payout always has a duration, so a median exists.
    if ((value.medianSecondsToPaid === null) !== (value.completedCount === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['medianSecondsToPaid'],
        message: 'a median is present exactly when a payout completed',
      });
    }
  });
export type OverviewKpis = z.infer<typeof OverviewKpis>;

export const StatsPoint = z.strictObject({
  amount: Money,
  count: z.number().int().min(0),
});

/**
 * One line of a chart. `points` has one entry per bucket, in the same order,
 * so the response states the time axis once and a missing bucket cannot
 * shift a series.
 */
export const StatsSeries = z
  .strictObject({
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    points: z.array(StatsPoint).max(400),
  })
  .superRefine((value, ctx) => {
    const currencies = new Set(value.points.map((p) => p.amount.currency));
    if (currencies.size > 1) {
      ctx.addIssue({ code: 'custom', path: ['points'], message: 'one currency per series' });
    }
    for (const [i, point] of value.points.entries()) {
      // A bucket with no payouts is zero in both, never an amount with no
      // count or a count with no amount.
      const amount = minorUnitsOf(point.amount.amount);
      if (amount === undefined) continue;
      if (amount === 0n && point.count > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['points', i, 'amount'],
          message: 'a counted bucket has an amount',
        });
      }
      if (amount > 0n && point.count === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['points', i, 'count'],
          message: 'an amount came from at least one payout',
        });
      }
    }
  });
export type StatsSeries = z.infer<typeof StatsSeries>;

export const MandateRunway = z
  .strictObject({
    mandateId: Uuid,
    instanceId: Uuid,
    network: NetworkId,
    balance: TokenAmount,
    committed: TokenAmount,
    /** Averaged over the last 30 days, in the instance's settlement token. */
    averageDailySpend: TokenAmount,
    /** Null when there has been no spend, so the days left are unknown. */
    runwayDays: z.number().int().min(0).nullable(),
  })
  .superRefine((value, ctx) => {
    for (const field of ['balance', 'committed', 'averageDailySpend'] as const) {
      if (value[field].network !== value.network) {
        ctx.addIssue({
          code: 'custom',
          path: [field, 'network'],
          message: 'the amount is on the mandate network',
        });
      }
    }
    const spend = minorUnitsOf(value.averageDailySpend.amount);
    if (spend === undefined) return;
    // No spend means no rate to divide by, so the days left are unknown
    // rather than infinite.
    if (spend === 0n && value.runwayDays !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['runwayDays'],
        message: 'no runway without spend',
      });
    }
  });
export type MandateRunway = z.infer<typeof MandateRunway>;

const seriesList = z.array(StatsSeries).max(MAX_STATS_SERIES);

export const CorridorBreakdown = z
  .strictObject({
    country: CountryCode,
    label: z.string().min(1).max(120),
    paid: z.array(Money).max(24),
    count: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    checkMoneyList(value.paid, ctx, 'paid');
    checkCountAgainstAmounts(value.count, value.paid, ctx, 'paid');
  });

const windowWithKpis = StatsWindow.safeExtend({ kpis: OverviewKpis });

export const OverviewStats = z
  .strictObject({
    ...tenantFields,
    period: StatsPeriod,
    /** The IANA zone the boundaries were taken in, from the principal. */
    timeZone: z.string().min(1).max(64),
    current: windowWithKpis,
    /** Null when no earlier window exists, never zeros, which would read as a collapse. */
    previous: windowWithKpis.nullable(),
    /** The shared time axis, oldest first. */
    buckets: z.array(StatsWindow).max(400),
    volumeByCorridor: seriesList,
    volumeByStatus: seriesList,
    mandates: z.array(MandateRunway).max(500),
    corridors: z.array(CorridorBreakdown).max(250),
    approvalsWaiting: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    // Buckets are oldest first and do not overlap, so a chart can plot them
    // in the order given.
    let last = Number.NEGATIVE_INFINITY;
    value.buckets.forEach((bucket, i) => {
      const from = Date.parse(bucket.from);
      if (from < last) {
        ctx.addIssue({
          code: 'custom',
          path: ['buckets', i, 'from'],
          message: 'buckets run oldest first and do not overlap',
        });
      }
      last = Date.parse(bucket.to);
    });

    // The axis is the shared one, so it has to cover the window the headline
    // numbers describe: it ends where that window ends and starts no later
    // than it begins. Without this a chart can share no dates with the
    // numbers above it and still pass every other rule.
    const firstBucket = value.buckets[0];
    const lastBucket = value.buckets[value.buckets.length - 1];
    if (firstBucket !== undefined && lastBucket !== undefined) {
      if (lastBucket.to !== value.current.to) {
        ctx.addIssue({
          code: 'custom',
          path: ['buckets'],
          message: 'the axis ends where the current window ends',
        });
      }
      if (Date.parse(firstBucket.from) > Date.parse(value.current.from)) {
        ctx.addIssue({
          code: 'custom',
          path: ['buckets'],
          message: 'the axis covers the current window',
        });
      }
    }

    for (const field of ['volumeByCorridor', 'volumeByStatus'] as const) {
      const series = value[field];
      series.forEach((line, i) => {
        if (line.points.length !== value.buckets.length) {
          ctx.addIssue({
            code: 'custom',
            path: [field, i, 'points'],
            message: 'one point per bucket',
          });
        }
      });
      const keys = series.map((line) => line.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'one series per key' });
      }
      // Everything outside the named series is collected last, so a chart
      // can stack it without reordering.
      const other = keys.indexOf(OTHER_SERIES_KEY);
      if (other !== -1 && other !== keys.length - 1) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'other comes last' });
      }
    }

    for (const [i, line] of value.volumeByStatus.entries()) {
      if (line.key !== OTHER_SERIES_KEY && !PayoutStatus.safeParse(line.key).success) {
        ctx.addIssue({
          code: 'custom',
          path: ['volumeByStatus', i, 'key'],
          message: 'a status series is keyed by a payout status',
        });
      }
    }
    for (const [i, line] of value.volumeByCorridor.entries()) {
      if (line.key !== OTHER_SERIES_KEY && !CountryCode.safeParse(line.key).success) {
        ctx.addIssue({
          code: 'custom',
          path: ['volumeByCorridor', i, 'key'],
          message: 'a corridor series is keyed by a country',
        });
      }
    }

    const countries = value.corridors.map((c) => c.country);
    if (new Set(countries).size !== countries.length) {
      ctx.addIssue({ code: 'custom', path: ['corridors'], message: 'one entry per country' });
    }

    if (value.previous !== null) {
      // The earlier window ends no later than the current one begins.
      if (Date.parse(value.previous.to) > Date.parse(value.current.from)) {
        ctx.addIssue({
          code: 'custom',
          path: ['previous', 'to'],
          message: 'the previous window ends before the current one starts',
        });
      }
    }

    const instances = value.mandates.map((m) => m.instanceId);
    if (new Set(instances).size !== instances.length) {
      ctx.addIssue({ code: 'custom', path: ['mandates'], message: 'one entry per instance' });
    }
  });
export type OverviewStats = z.infer<typeof OverviewStats>;

/**
 * The query. There is no time-zone parameter: the boundary comes from the
 * principal's reporting zone, so one carrying `tz` is refused as an unknown
 * field rather than silently ignored.
 */
export const OverviewStatsQuery = z
  .strictObject({
    period: StatsPeriod.optional(),
    from: Timestamp.optional(),
    to: Timestamp.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from === undefined || value.to === undefined) {
      if (value.from !== value.to) {
        ctx.addIssue({ code: 'custom', path: ['from'], message: 'invalid_value' });
      }
      return;
    }
    const from = Date.parse(value.from);
    const to = Date.parse(value.to);
    if (from >= to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'range_inverted' });
      return;
    }
    if (to - from > MAX_RANGE_MS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'invalid_value' });
    }
  });
export type OverviewStatsQuery = z.infer<typeof OverviewStatsQuery>;
