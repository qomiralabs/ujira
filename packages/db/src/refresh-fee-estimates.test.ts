// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A refresh writes all its rows in one transaction, through the repository, as
// ujira_ops, while the app role reads. The refresh job (in the payouts
// package) decides what the rows are; this file proves they arrive whole.

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadDatabaseConfig, type DatabaseEnvironment } from './config.js';
import { createDatabase, type Database } from './database.js';
import {
  feeEstimates,
  type FeeEstimate,
  type FeeEstimateOp,
} from './repositories/fee-estimates.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const OPS: readonly FeeEstimateOp[] = ['request', 'execute', 'approve', 'reject', 'cancel'];
const WINDOW_START = new Date('2026-10-25T00:00:00Z');
const WINDOW_END = new Date('2026-11-01T00:00:00Z');

function row(op: FeeEstimateOp, fee: bigint): FeeEstimate {
  return {
    network: 'stellar:testnet',
    op,
    legCount: 2,
    p95ResourceFeeStroops: fee,
    p95RentStroops: fee / 2n,
    p95InclusionFeeStroops: 100n,
    sampleCount: 25,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    computedAt: WINDOW_END,
  };
}

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  const environment: DatabaseEnvironment = {
    UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
    UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
    // The refresh writes as ujira_ops, the only role that may.
    UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_ops', database.name),
    UJIRA_DB_INDEXER_URL: roleUrl(roleUrls, 'ujira_ops', database.name),
    UJIRA_DB_MIGRATION_URL: database.url,
    UJIRA_DB_TLS: 'off',
    UJIRA_DB_APP_POOL_SIZE: '2',
    UJIRA_DB_STATEMENT_TIMEOUT_MS: '4000',
    UJIRA_DB_LOCK_TIMEOUT_MS: '2000',
  };
  db = createDatabase(loadDatabaseConfig(environment));
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

const writeAll = async (fee: bigint): Promise<void> =>
  db.unscoped(
    (tx) =>
      feeEstimates.upsertAll(
        tx,
        OPS.map((op) => row(op, fee)),
      ),
    'worker',
  );

const readFees = async (): Promise<bigint[]> =>
  db.unscoped(async (tx) =>
    (await feeEstimates.list(tx)).map((estimate) => estimate.p95ResourceFeeStroops),
  );

describe('refreshing fee estimates', () => {
  it('a concurrent reader sees either all old rows or all new rows', async () => {
    await writeAll(1_000n);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written: () => void = () => undefined;
    const allWritten = new Promise<void>((resolve) => {
      written = resolve;
    });

    // Hold the refresh open after every row is written and before it commits.
    const refresh = db.unscoped(async (tx) => {
      await feeEstimates.upsertAll(
        tx,
        OPS.map((op) => row(op, 2_000n)),
      );
      written();
      await held;
    }, 'worker');
    await allWritten;

    expect(await readFees()).toEqual(OPS.map(() => 1_000n));
    release();
    await refresh;
    expect(await readFees()).toEqual(OPS.map(() => 2_000n));
  });

  it('rolls every row back when the refresh fails partway', async () => {
    await writeAll(3_000n);
    const failing = db.unscoped(async (tx) => {
      await feeEstimates.upsertAll(
        tx,
        OPS.map((op) => row(op, 4_000n)),
      );
      throw new Error('the job failed after writing');
    }, 'worker');
    await expect(failing).rejects.toThrow('the job failed after writing');
    expect(await readFees()).toEqual(OPS.map(() => 3_000n));
  });

  it('replaces only the rows it is given, so a sparse combination keeps its row', async () => {
    await writeAll(5_000n);
    await db.unscoped((tx) => feeEstimates.upsertAll(tx, [row('execute', 6_000n)]), 'worker');
    const read = await db.unscoped((tx) => feeEstimates.list(tx));
    expect(read.find((estimate) => estimate.op === 'execute')?.p95ResourceFeeStroops).toBe(6_000n);
    expect(read.find((estimate) => estimate.op === 'approve')?.p95ResourceFeeStroops).toBe(5_000n);
  });

  it('reads one combination back whole, and answers undefined for one with no row', async () => {
    const key = { network: 'stellar:testnet', op: 'approve', legCount: 2 } as const;
    await writeAll(7_000n);
    const found = await db.unscoped((tx) => feeEstimates.get(tx, key));
    expect(found).toEqual(row('approve', 7_000n));
    const missing = await db.unscoped((tx) => feeEstimates.get(tx, { ...key, legCount: 4 }));
    expect(missing).toBeUndefined();
  });

  it('does nothing for an empty refresh', async () => {
    await writeAll(8_000n);
    await db.unscoped((tx) => feeEstimates.upsertAll(tx, []), 'worker');
    expect(await readFees()).toEqual(OPS.map(() => 8_000n));
  });
});
