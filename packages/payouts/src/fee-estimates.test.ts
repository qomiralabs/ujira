// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import {
  FEE_ESTIMATE_OPS,
  FeeEstimateInputError,
  computeFeeEstimates,
  feeEstimateWindow,
  percentile95,
  refreshFeeEstimates,
} from './fee-estimates.js';
import type { FeeEstimateOp, FeeEstimateRow, SubmissionFee } from './fee-estimates.js';

const NOW = new Date('2026-11-02T09:30:00Z');
const OPTIONS = { now: NOW, sampleMinimum: 5 };
const HOUR = 3_600_000;
// Inside the window: the window ends at midnight of the run's day.
const LANDED = new Date('2026-11-01T12:00:00Z');

function submission(overrides: Partial<SubmissionFee> = {}): SubmissionFee {
  return {
    network: 'stellar:testnet',
    op: 'execute',
    legCount: 1,
    itemCount: 1,
    state: 'landed',
    landedAt: LANDED,
    resourceFeeStroops: 1_000n,
    rentStroops: 400n,
    inclusionFeeStroops: 100n,
    ...overrides,
  };
}

// The reference computation, written the long way: sort ascending, then take
// the value at position ceil(0.95 * n), counting from 1.
function referenceP95(values: readonly number[]): bigint {
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.ceil(sorted.length * 0.95);
  return BigInt(sorted[position - 1] ?? -1);
}

describe('percentile95', () => {
  it('takes the nearest rank', () => {
    expect(percentile95([5n])).toBe(5n);
    expect(percentile95([1n, 2n])).toBe(2n);
    const twenty = Array.from({ length: 20 }, (_, i) => BigInt(i + 1));
    // Position 19 of 20.
    expect(percentile95(twenty)).toBe(19n);
    const hundred = Array.from({ length: 100 }, (_, i) => BigInt(100 - i));
    expect(percentile95(hundred)).toBe(95n);
    expect(percentile95([3n, 1n, 2n, 2n])).toBe(3n);
  });

  it('refuses an empty list', () => {
    expect(() => percentile95([])).toThrow(FeeEstimateInputError);
  });
});

describe('the estimate window', () => {
  it('is the 7 days before midnight UTC of the day', () => {
    expect(feeEstimateWindow(NOW)).toEqual({
      start: new Date('2026-10-26T00:00:00Z'),
      end: new Date('2026-11-02T00:00:00Z'),
    });
  });
});

describe('computeFeeEstimates', () => {
  it('p95 resource fee, rent and inclusion fee over seeded submissions match the reference computation for each op and leg count', () => {
    const submissions: SubmissionFee[] = [];
    const resource = new Map<string, number[]>();
    const rent = new Map<string, number[]>();
    const inclusion = new Map<string, number[]>();
    FEE_ESTIMATE_OPS.forEach((op, opIndex) => {
      for (let legCount = 1; legCount <= 4; legCount += 1) {
        const key = `${op} ${String(legCount)}`;
        const [a, b, c] = [[] as number[], [] as number[], [] as number[]];
        for (let n = 0; n < 40; n += 1) {
          // Scrambled by a stride that shares no factor with 97, so the order
          // of arrival says nothing about the order of the values.
          const scrambled = ((n * 37) % 97) + 1;
          const fee = 1_000 + scrambled * (opIndex + 1) * legCount;
          const rentPart = Math.floor(fee / 3);
          const included = 100 + scrambled;
          a.push(fee);
          b.push(rentPart);
          c.push(included);
          submissions.push(
            submission({
              op,
              legCount,
              resourceFeeStroops: BigInt(fee),
              rentStroops: BigInt(rentPart),
              inclusionFeeStroops: BigInt(included),
            }),
          );
        }
        resource.set(key, a);
        rent.set(key, b);
        inclusion.set(key, c);
      }
    });

    const { rows, sparse } = computeFeeEstimates(submissions, OPTIONS);
    expect(sparse).toEqual([]);
    expect(rows).toHaveLength(FEE_ESTIMATE_OPS.length * 4);
    for (const row of rows) {
      const key = `${row.op} ${String(row.legCount)}`;
      expect(row.p95ResourceFeeStroops, key).toBe(referenceP95(resource.get(key) ?? []));
      expect(row.p95RentStroops, key).toBe(referenceP95(rent.get(key) ?? []));
      expect(row.p95InclusionFeeStroops, key).toBe(referenceP95(inclusion.get(key) ?? []));
      expect(row.p95RentStroops, key).toBeLessThanOrEqual(row.p95ResourceFeeStroops);
      expect(row.sampleCount, key).toBe(40);
    }
  });

  it('a 10-item execute_batch contributes its fee divided by 10', () => {
    const batch = (resource: bigint): SubmissionFee =>
      submission({
        op: 'execute_batch',
        itemCount: 10,
        resourceFeeStroops: resource,
        rentStroops: resource / 2n,
        inclusionFeeStroops: 1_000n,
      });
    const { rows } = computeFeeEstimates(
      Array.from({ length: 5 }, () => batch(10_000n)),
      OPTIONS,
    );
    expect(rows[0]).toMatchObject({
      op: 'execute_batch',
      p95ResourceFeeStroops: 1_000n,
      p95RentStroops: 500n,
      p95InclusionFeeStroops: 100n,
    });
  });

  it('rounds a batch share up, so the estimate never comes in short', () => {
    const { rows } = computeFeeEstimates(
      Array.from({ length: 5 }, () =>
        submission({
          op: 'request_batch',
          itemCount: 3,
          resourceFeeStroops: 10n,
          rentStroops: 10n,
          inclusionFeeStroops: 10n,
        }),
      ),
      OPTIONS,
    );
    expect(rows[0]?.p95ResourceFeeStroops).toBe(4n);
  });

  it('failed, unknown, simulated and 8-day-old submissions are ignored', () => {
    const counted = Array.from({ length: 5 }, () => submission());
    const ignored = [
      submission({ state: 'failed', resourceFeeStroops: 999_999n }),
      submission({ state: 'unknown', resourceFeeStroops: 999_999n }),
      submission({ state: 'simulated', resourceFeeStroops: 999_999n }),
      submission({ landedAt: null, resourceFeeStroops: 999_999n }),
      // 8 days before the window's end.
      submission({ landedAt: new Date('2026-10-25T00:00:00Z'), resourceFeeStroops: 999_999n }),
      // The run's own day, which the window leaves out.
      submission({ landedAt: new Date('2026-11-02T00:00:00Z'), resourceFeeStroops: 999_999n }),
    ];
    const { rows } = computeFeeEstimates([...counted, ...ignored], OPTIONS);
    expect(rows[0]).toMatchObject({ p95ResourceFeeStroops: 1_000n, sampleCount: 5 });
  });

  it('counts the first instant of the window and not the last', () => {
    const at = (time: string): SubmissionFee => submission({ landedAt: new Date(time) });
    const start = Array.from({ length: 5 }, () => at('2026-10-26T00:00:00Z'));
    expect(computeFeeEstimates(start, OPTIONS).rows).toHaveLength(1);
    const end = Array.from({ length: 5 }, () => at('2026-11-02T00:00:00Z'));
    expect(computeFeeEstimates(end, OPTIONS).rows).toHaveLength(0);
  });

  it('refuses a landed submission with impossible amounts rather than average it in', () => {
    for (const bad of [
      submission({ rentStroops: 2_000n }),
      submission({ resourceFeeStroops: -1n, rentStroops: -1n }),
      submission({ inclusionFeeStroops: -1n }),
      submission({ itemCount: 0 }),
      submission({ itemCount: 1.5 }),
    ]) {
      expect(() => computeFeeEstimates([bad], OPTIONS)).toThrow(FeeEstimateInputError);
    }
  });
});

interface Stored {
  rows: FeeEstimateRow[];
  alerts: unknown[];
  written: FeeEstimateRow[][];
}

function ports(stored: Stored, submissions: readonly SubmissionFee[]) {
  return {
    submissionsBetween: () => Promise.resolve(submissions),
    currentEstimates: () => Promise.resolve(stored.rows),
    writeEstimates: (rows: readonly FeeEstimateRow[]) => {
      stored.written.push([...rows]);
      const keep = stored.rows.filter(
        (old) => !rows.some((r) => r.op === old.op && r.legCount === old.legCount),
      );
      stored.rows = [...keep, ...rows];
      return Promise.resolve();
    },
    alertSparse: (e: unknown) => {
      stored.alerts.push(e);
    },
  };
}

describe('sparse data', () => {
  it('below the sample minimum the old row stays and one alert fires', async () => {
    const op: FeeEstimateOp = 'approve';
    const old: FeeEstimateRow = {
      network: 'stellar:testnet',
      op,
      legCount: 1,
      p95ResourceFeeStroops: 777n,
      p95RentStroops: 7n,
      p95InclusionFeeStroops: 77n,
      sampleCount: 50,
      windowStart: new Date(NOW.getTime() - 200 * HOUR),
      windowEnd: new Date(NOW.getTime() - 32 * HOUR),
      computedAt: new Date(NOW.getTime() - 32 * HOUR),
    };
    const stored: Stored = { rows: [old], alerts: [], written: [] };
    const few = Array.from({ length: 4 }, () => submission({ op }));
    const output = await refreshFeeEstimates(ports(stored, few), OPTIONS);

    expect(stored.rows).toEqual([old]);
    expect(stored.written).toEqual([[]]);
    expect(stored.alerts).toEqual([
      { network: 'stellar:testnet', op, legCount: 1, sampleCount: 4 },
    ]);
    expect(output).toMatchObject({ written: 0, kept: 1, replaced: [] });
  });
});
