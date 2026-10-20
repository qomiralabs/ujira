// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { parseQuery } from './contract.js';
import { FIXTURE_TIME_ZONE, overviewFixture, overviewFixtures } from './fixtures/index.js';
import {
  MAX_STATS_RANGE_DAYS,
  OTHER_SERIES_KEY,
  OverviewStats,
  OverviewStatsQuery,
} from './stats.js';

const stats = overviewFixture({ seed: 314 });

const clone = <T>(value: T): T => structuredClone(value);
const money = (amount: unknown, currency = 'USD'): unknown => ({ amount, currency, scale: 2 });

describe('overview stats', () => {
  it('a number amount, a decimal string and a scale mismatch are refused', () => {
    for (const bad of [1250, 12.5, '12.50', '1e3', '-1', '01']) {
      const s = clone(stats);
      s.current.kpis.paid = [money(bad) as never];
      expect(OverviewStats.safeParse(s).success, String(bad)).toBe(false);
    }
    const scale = clone(stats);
    scale.current.kpis.paid = [money('1250', 'USD') as never];
    (scale.current.kpis.paid[0] as { scale: number }).scale = 3;
    expect(OverviewStats.safeParse(scale).success).toBe(false);

    // Totals stay per currency, so two entries of one currency are refused
    // and no conversion into a single figure is possible.
    const dup = clone(stats);
    dup.current.kpis.paid = [money('100') as never, money('200') as never];
    expect(OverviewStats.safeParse(dup).success).toBe(false);
  });

  it('an unknown period, a reversed range and an over-long range are refused', () => {
    const from = '2026-09-01T00:00:00.000Z';
    expect(OverviewStatsQuery.safeParse({ period: 'day' }).success).toBe(true);
    expect(OverviewStatsQuery.safeParse({ period: 'quarter' }).success).toBe(false);
    expect(OverviewStatsQuery.safeParse({ period: 'DAY' }).success).toBe(false);
    expect(OverviewStatsQuery.safeParse({ from, to: '2026-09-30T00:00:00.000Z' }).success).toBe(
      true,
    );
    // Reversed, equal, and one day past the limit.
    expect(
      OverviewStatsQuery.safeParse({ from: '2026-09-30T00:00:00.000Z', to: from }).success,
    ).toBe(false);
    expect(OverviewStatsQuery.safeParse({ from, to: from }).success).toBe(false);
    const tooLong = new Date(Date.parse(from) + (MAX_STATS_RANGE_DAYS + 1) * 86_400_000);
    expect(OverviewStatsQuery.safeParse({ from, to: tooLong.toISOString() }).success).toBe(false);
    const atLimit = new Date(Date.parse(from) + MAX_STATS_RANGE_DAYS * 86_400_000);
    expect(OverviewStatsQuery.safeParse({ from, to: atLimit.toISOString() }).success).toBe(true);
    // One bound without the other cannot name a window.
    expect(OverviewStatsQuery.safeParse({ from }).success).toBe(false);
    expect(OverviewStatsQuery.safeParse({ to: from }).success).toBe(false);
  });

  it('refuses a time zone in the request as an unknown field', () => {
    // The boundary is the principal's, so a request cannot move it.
    const result = parseQuery('getOverviewStats', { period: 'day', tz: 'Africa/Lagos' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('INVALID_FILTER');
      expect(result.errors).toEqual([{ field: 'tz', code: 'unknown_field' }]);
    }
    // The response states the zone it used instead.
    expect(stats.timeZone.length).toBeGreaterThan(0);
  });

  it('a mandate with no spend parses with a null runway', () => {
    const noSpend = stats.mandates.find((m) => m.averageDailySpend.amount === '0');
    expect(noSpend).toBeDefined();
    expect(noSpend?.runwayDays).toBeNull();
    expect(OverviewStats.safeParse(stats).success).toBe(true);

    const s = clone(stats);
    const target = s.mandates.find((m) => m.averageDailySpend.amount === '0');
    if (target === undefined) throw new Error('fixture missing');
    // A number of days with nothing being spent cannot be derived.
    target.runwayDays = 30;
    expect(OverviewStats.safeParse(s).success).toBe(false);

    const negative = clone(stats);
    const spending = negative.mandates.find((m) => m.averageDailySpend.amount !== '0');
    if (spending === undefined) throw new Error('fixture missing');
    spending.runwayDays = -1;
    expect(OverviewStats.safeParse(negative).success).toBe(false);
  });

  it('the fixture set contains a fifth corridor grouped as Other', () => {
    const series = stats.volumeByCorridor;
    expect(series.length).toBe(5);
    expect(series[series.length - 1]?.key).toBe(OTHER_SERIES_KEY);
    expect(series.filter((s) => s.key !== OTHER_SERIES_KEY)).toHaveLength(4);
    // More corridors were paid than the chart draws, which is why the last
    // series exists at all.
    expect(stats.corridors.length).toBeGreaterThan(4);

    const s = clone(stats);
    // Other is collected last so a chart can stack it without reordering.
    s.volumeByCorridor = [...series].reverse();
    expect(OverviewStats.safeParse(s).success).toBe(false);
    // A sixth series, inserted before other so it is the cap that refuses
    // it and not the ordering rule.
    const sixth = clone(stats);
    const extra = { ...series[0], key: 'ZZ', label: 'Extra' };
    sixth.volumeByCorridor = [...series.slice(0, -1), extra, series[series.length - 1]] as never;
    expect(sixth.volumeByCorridor[sixth.volumeByCorridor.length - 1]?.key).toBe(OTHER_SERIES_KEY);
    expect(OverviewStats.safeParse(sixth).success).toBe(false);
  });

  it('keeps every series aligned to the one time axis', () => {
    expect(stats.buckets.length).toBeGreaterThan(1);
    for (const series of [...stats.volumeByCorridor, ...stats.volumeByStatus]) {
      expect(series.points).toHaveLength(stats.buckets.length);
    }
    // A window wider than the axis beneath it: the end still lines up, so
    // only the covering rule can refuse this one.
    const uncovered = clone(stats);
    uncovered.previous = null;
    uncovered.current.from = new Date(
      Date.parse(uncovered.buckets[0]?.from ?? '') - 86_400_000,
    ).toISOString();
    expect(uncovered.buckets[uncovered.buckets.length - 1]?.to).toBe(uncovered.current.to);
    expect(OverviewStats.safeParse(uncovered).success).toBe(false);

    const short = clone(stats);
    const first = short.volumeByCorridor[0];
    if (first === undefined) throw new Error('fixture missing');
    first.points = first.points.slice(0, -1);
    expect(OverviewStats.safeParse(short).success).toBe(false);

    const unordered = clone(stats);
    unordered.buckets = [...unordered.buckets].reverse();
    expect(OverviewStats.safeParse(unordered).success).toBe(false);
  });

  it('states the window it used and keeps the previous one earlier', () => {
    expect(Date.parse(stats.current.from)).toBeLessThan(Date.parse(stats.current.to));
    expect(stats.previous).not.toBeNull();
    if (stats.previous !== null) {
      expect(Date.parse(stats.previous.to)).toBeLessThanOrEqual(Date.parse(stats.current.from));
    }
    const overlapping = clone(stats);
    if (overlapping.previous !== null) {
      overlapping.previous.to = overlapping.current.to;
      expect(OverviewStats.safeParse(overlapping).success).toBe(false);
    }
    // A first ever period has no earlier window, which is null rather than
    // zeros that would read as a total collapse.
    const firstPeriod = clone(stats);
    firstPeriod.previous = null;
    expect(OverviewStats.safeParse(firstPeriod).success).toBe(true);
  });

  it('ties the median and the counted amounts to the completed count', () => {
    const empty = clone(stats);
    empty.current.kpis = {
      paid: [],
      completedCount: 0,
      medianSecondsToPaid: null,
      blockedCount: 3,
    };
    expect(OverviewStats.safeParse(empty).success).toBe(true);
    // Nothing paid means no median to report.
    const median = clone(empty);
    median.current.kpis.medianSecondsToPaid = 0;
    expect(OverviewStats.safeParse(median).success).toBe(false);
    // And a completed payout must have contributed an amount.
    const counted = clone(empty);
    counted.current.kpis.completedCount = 2;
    expect(OverviewStats.safeParse(counted).success).toBe(false);
  });

  // The schema cannot check this, because it does not know the zone's rules,
  // so without this reader a fixture can declare one zone and draw another's
  // boundaries. That is what it was doing: edges at UTC midnight, an hour
  // off local midnight in the zone it named.
  it('puts every window boundary at local midnight in the zone it declares', () => {
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: FIXTURE_TIME_ZONE,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    for (const [name, fixture] of Object.entries(overviewFixtures())) {
      expect(fixture.timeZone, name).toBe(FIXTURE_TIME_ZONE);
      const edges = [
        fixture.current.from,
        fixture.current.to,
        ...(fixture.previous === null ? [] : [fixture.previous.from, fixture.previous.to]),
        ...fixture.buckets.flatMap((b) => [b.from, b.to]),
      ];
      for (const edge of edges) {
        expect(local.format(new Date(edge)), `${name} ${edge}`).toBe('00:00');
      }
    }
    // And the zone is not UTC, so a boundary-crossing test has something to
    // cross: in Lagos a local midnight edge is 23:00 the day before in UTC.
    expect(FIXTURE_TIME_ZONE).not.toBe('UTC');
    expect(stats.buckets[0]?.from.endsWith('23:00:00.000Z')).toBe(true);
  });

  it('refuses a missing median when payouts completed, so null means one thing', () => {
    const s = clone(stats);
    expect(s.current.kpis.completedCount).toBeGreaterThan(0);
    s.current.kpis.medianSecondsToPaid = null;
    expect(OverviewStats.safeParse(s).success).toBe(false);
    // Both directions, so null carries exactly one meaning: nothing was paid.
    const empty = clone(stats);
    empty.current.kpis = {
      paid: [],
      completedCount: 0,
      medianSecondsToPaid: null,
      blockedCount: 0,
    };
    expect(OverviewStats.safeParse(empty).success).toBe(true);
  });

  it('holds the corridor breakdown to the same money rules as the KPIs', () => {
    const base = clone(stats);
    const corridor = base.corridors[0];
    if (corridor === undefined) throw new Error('fixture missing');
    const at = (c: typeof base.corridors) => {
      const s = clone(base);
      s.corridors = c;
      return OverviewStats.safeParse(s).success;
    };
    // Two entries of one currency, so no total can be read off it.
    expect(at([{ ...corridor, paid: [money('100') as never, money('200') as never] }])).toBe(false);
    // Currencies sorted, so two responses list the same money in one order.
    expect(
      at([{ ...corridor, paid: [money('100', 'USD') as never, money('200', 'COP') as never] }]),
    ).toBe(false);
    expect(
      at([{ ...corridor, paid: [money('200', 'COP') as never, money('100', 'USD') as never] }]),
    ).toBe(true);
    // A count with no amount, and an amount with no count.
    expect(at([{ ...corridor, paid: [], count: 5 }])).toBe(false);
    expect(at([{ ...corridor, paid: [money('0') as never], count: 5 }])).toBe(false);
    expect(at([{ ...corridor, paid: [money('100') as never], count: 0 }])).toBe(false);
    // Nothing paid in a corridor is zero in both.
    expect(at([{ ...corridor, paid: [], count: 0 }])).toBe(true);
  });

  it('keeps the time axis over the window it sits beside', () => {
    const shifted = clone(stats);
    // Every bucket moved far later, leaving the order and per-bucket rules
    // intact: a chart sharing no dates with the numbers above it.
    shifted.buckets = shifted.buckets.map((b) => ({
      from: new Date(Date.parse(b.from) + 400 * 86_400_000).toISOString(),
      to: new Date(Date.parse(b.to) + 400 * 86_400_000).toISOString(),
    }));
    expect(OverviewStats.safeParse(shifted).success).toBe(false);

    const earlier = clone(stats);
    earlier.buckets = earlier.buckets.map((b) => ({
      from: new Date(Date.parse(b.from) - 400 * 86_400_000).toISOString(),
      to: new Date(Date.parse(b.to) - 400 * 86_400_000).toISOString(),
    }));
    expect(OverviewStats.safeParse(earlier).success).toBe(false);

    // The axis ends where the current window ends and starts no later than
    // it begins, which the fixture already does.
    const last = stats.buckets[stats.buckets.length - 1];
    expect(last?.to).toBe(stats.current.to);
    expect(Date.parse(stats.buckets[0]?.from ?? '')).toBeLessThanOrEqual(
      Date.parse(stats.current.from),
    );
    const short = clone(stats);
    // An axis that stops before the current window closes.
    short.buckets = short.buckets.slice(0, -1);
    short.volumeByCorridor = short.volumeByCorridor.map((x) => ({
      ...x,
      points: x.points.slice(0, -1),
    }));
    short.volumeByStatus = short.volumeByStatus.map((x) => ({
      ...x,
      points: x.points.slice(0, -1),
    }));
    expect(OverviewStats.safeParse(short).success).toBe(false);
  });

  it('is scoped to one principal and project', () => {
    expect(stats.principalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stats.projectId).toMatch(/^[0-9a-f-]{36}$/);
    const s = clone(stats) as Record<string, unknown>;
    delete s['projectId'];
    expect(OverviewStats.safeParse(s).success).toBe(false);
  });
});
