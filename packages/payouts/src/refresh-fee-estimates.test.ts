// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import {
  REFRESH_FEE_ESTIMATES_JOB,
  onPayoutTtlDefaultsChanged,
  refreshFeeEstimates,
} from './fee-estimates.js';
import type { FeeEstimateRow, SubmissionFee } from './fee-estimates.js';

const NOW = new Date('2026-11-02T09:30:00Z');
const OPTIONS = { now: NOW, sampleMinimum: 5 };

function landed(resource: bigint): SubmissionFee {
  return {
    network: 'stellar:testnet',
    op: 'execute',
    legCount: 1,
    itemCount: 1,
    state: 'landed',
    landedAt: new Date('2026-11-01T12:00:00Z'),
    resourceFeeStroops: resource,
    rentStroops: resource / 2n,
    inclusionFeeStroops: 100n,
  };
}

function storeOf(initial: readonly FeeEstimateRow[] = []) {
  const state = { rows: [...initial], writes: 0, asked: [] as [Date, Date][] };
  const ports = (submissions: readonly SubmissionFee[]) => ({
    submissionsBetween: (start: Date, end: Date) => {
      state.asked.push([start, end]);
      return Promise.resolve(submissions);
    },
    currentEstimates: () => Promise.resolve(state.rows),
    writeEstimates: (rows: readonly FeeEstimateRow[]) => {
      state.writes += 1;
      state.rows = [...rows];
      return Promise.resolve();
    },
    alertSparse: () => undefined,
  });
  return { state, ports };
}

describe('the refresh job', () => {
  it('the job output lists the replaced values', async () => {
    const { state, ports } = storeOf();
    await refreshFeeEstimates(ports(Array.from({ length: 5 }, () => landed(1_000n))), OPTIONS);
    const output = await refreshFeeEstimates(
      ports(Array.from({ length: 5 }, () => landed(2_000n))),
      OPTIONS,
    );

    expect(output).toEqual({
      written: 1,
      kept: 0,
      replaced: [
        {
          network: 'stellar:testnet',
          op: 'execute',
          legCount: 1,
          previous: {
            p95ResourceFeeStroops: '1000',
            p95RentStroops: '500',
            p95InclusionFeeStroops: '100',
            sampleCount: 5,
          },
          current: {
            p95ResourceFeeStroops: '2000',
            p95RentStroops: '1000',
            p95InclusionFeeStroops: '100',
            sampleCount: 5,
          },
        },
      ],
    });
    // Job output is stored as JSON, which cannot hold a bigint.
    expect(() => JSON.stringify(output)).not.toThrow();
    expect(state.rows[0]?.p95ResourceFeeStroops).toBe(2_000n);
  });

  it('names no previous value for a combination seen for the first time', async () => {
    const { ports } = storeOf();
    const output = await refreshFeeEstimates(
      ports(Array.from({ length: 5 }, () => landed(1_000n))),
      OPTIONS,
    );
    expect(output.replaced[0]?.previous).toBeNull();
  });

  it('two runs on the same day leave the same rows', async () => {
    const submissions = Array.from({ length: 5 }, () => landed(1_000n));
    const morning = storeOf();
    await refreshFeeEstimates(morning.ports(submissions), OPTIONS);
    const first = morning.state.rows;
    await refreshFeeEstimates(morning.ports(submissions), {
      ...OPTIONS,
      now: new Date('2026-11-02T23:59:59Z'),
    });
    expect(morning.state.rows).toEqual(first);
    expect(morning.state.writes).toBe(2);
    // Both runs read the same window.
    expect(morning.state.asked[1]).toEqual(morning.state.asked[0]);
  });

  it('writes all its rows in one call', async () => {
    const { state, ports } = storeOf();
    const two: SubmissionFee[] = [
      ...Array.from({ length: 5 }, () => landed(1_000n)),
      ...Array.from({ length: 5 }, () => ({ ...landed(1_000n), legCount: 2 })),
    ];
    await refreshFeeEstimates(ports(two), OPTIONS);
    expect(state.writes).toBe(1);
    expect(state.rows).toHaveLength(2);
  });

  it('sends no alert when the write fails, so a retry does not repeat it', async () => {
    const alerts: unknown[] = [];
    const failing = {
      submissionsBetween: () => Promise.resolve([landed(1_000n)]),
      currentEstimates: () => Promise.resolve([]),
      writeEstimates: () => Promise.reject(new Error('the database is down')),
      alertSparse: (e: unknown) => alerts.push(e),
    };
    await expect(refreshFeeEstimates(failing, OPTIONS)).rejects.toThrow('the database is down');
    expect(alerts).toEqual([]);
  });
});

describe('the payout TTL defaults', () => {
  it('changing the payout_ttl_seconds defaults enqueues a refresh', async () => {
    const enqueued: string[] = [];
    const enqueue = (job: string) => {
      enqueued.push(job);
      return Promise.resolve();
    };
    const changed = await onPayoutTtlDefaultsChanged(
      { wallet: 3_600, bank: 86_400 },
      { wallet: 7_200, bank: 86_400 },
      enqueue,
    );
    expect(changed).toBe(true);
    expect(enqueued).toEqual([REFRESH_FEE_ESTIMATES_JOB]);
    expect(REFRESH_FEE_ESTIMATES_JOB).toBe('payouts:refresh_fee_estimates');
  });

  it('notices a default added or removed, and enqueues nothing when none changed', async () => {
    const enqueued: string[] = [];
    const enqueue = (job: string) => {
      enqueued.push(job);
      return Promise.resolve();
    };
    expect(await onPayoutTtlDefaultsChanged({ a: 1 }, { a: 1 }, enqueue)).toBe(false);
    expect(enqueued).toEqual([]);
    expect(await onPayoutTtlDefaultsChanged({ a: 1 }, { a: 1, b: 2 }, enqueue)).toBe(true);
    expect(await onPayoutTtlDefaultsChanged({ a: 1, b: 2 }, { a: 1 }, enqueue)).toBe(true);
    expect(enqueued).toHaveLength(2);
  });
});
