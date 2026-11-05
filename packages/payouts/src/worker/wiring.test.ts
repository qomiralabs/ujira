// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The worker with every handler registered, on a real pool and a real Postgres, against
// the fake chain: one payout from its request to its receipt, with nothing called by hand.

import type { TenantScope } from '@ujira/chain-adapter';
import { adminQuery } from '@ujira/db/testing';
import type { ReceiptIssueStore, StoredReceipt } from '@ujira/receipts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueueAdvance } from '../engine/advance.js';
import { databasePaidPayout } from '../engine/paid-payout.js';
import { engineWorld, ONE_USDC, seedTenant, TENANT, usdc } from '../engine/testing/world.js';
import { startWorkerProcess } from './process.js';
import { buildTaskList, startWorker, unwiredTasks } from './start.js';
import { SYSTEM_TASKS } from './tasks.js';
import { quiet, until, workerHarness, type WorkerHarness } from './testing/support.js';
import {
  MISSING_STORES,
  productionParts,
  workerHandlers,
  WorkerStoresMissingError,
  type WorkerParts,
} from './wiring.js';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  await seedTenant(harness);
});

afterAll(async () => {
  await harness.close();
});

// The receipts table is not merged (#64), so the test keeps its rows here, keyed as that
// table's unique constraint would.
function memoryReceipts(): ReceiptIssueStore & { readonly rows: StoredReceipt[] } {
  const rows: StoredReceipt[] = [];
  const mine = (scope: TenantScope, payoutId: string) =>
    rows.filter(
      (row) =>
        row.payoutId === payoutId &&
        row.receipt.principalId === scope.principalId &&
        row.receipt.projectId === scope.projectId,
    );
  return {
    rows,
    latest: (scope, payoutId) => Promise.resolve(mine(scope, payoutId).at(-1) ?? null),
    insert: (scope, stored) => {
      if (
        mine(scope, stored.payoutId).some((r) => r.receipt.revision === stored.receipt.revision)
      ) {
        return Promise.resolve('conflict');
      }
      rows.push(stored);
      return Promise.resolve('inserted');
    },
  };
}

async function parts() {
  const world = await engineWorld(harness);
  const receipts = memoryReceipts();
  const blocked: string[] = [];
  const scans: string[] = [];
  const kept: unknown[] = [];
  const swept: string[] = [];
  const wired: WorkerParts = {
    engine: world.deps,
    receipts: {
      store: receipts,
      paidPayout: databasePaidPayout(harness.db, world.deps.adapters),
      adapter: (network) => world.deps.adapters.get(network),
      alerts: { receiptBlocked: (alert) => blocked.push(alert.reason) },
      clock: { nowSeconds: () => world.h.world.net.now() },
      chainTimeoutMs: 5_000,
    },
    indexerScans: [
      {
        network: 'stellar:testnet',
        scan: {
          step: () => {
            scans.push('step');
            return Promise.resolve({ events: 0 });
          },
        },
      },
    ],
    submissionSweepers: [
      {
        reconcileUnresolved: () => {
          swept.push('sweep');
          return Promise.resolve([]);
        },
      },
    ],
    ttlKeepAlive: {
      run: (payload) => {
        kept.push(payload);
        return Promise.resolve();
      },
      networks: ['stellar:testnet'],
    },
  };
  return { world, receipts, wired, blocked };
}

describe('the worker with every handler', () => {
  it('registers every task a deployment runs, and names what is not built', async () => {
    const { wired } = await parts();
    const handlers = workerHandlers(wired);
    // The one task nothing handles yet, until #598.
    expect(unwiredTasks(handlers)).toEqual(['mandate:reconcile']);
    const { taskList } = buildTaskList({ db: harness.db, alert: () => undefined, handlers });
    expect(Object.keys(taskList).sort()).toEqual(
      [
        'batch:advance',
        'indexer:scan',
        'jobs:unlock_stale',
        'payout:advance',
        'payouts:cancel_lapsed',
        SYSTEM_TASKS.lapsedSweep,
        'payouts:release_held',
        SYSTEM_TASKS.releaseSweep,
        'receipt:issue',
        'submissions:reconcile',
        'ttl:keep_alive',
        'ttl:sweep',
      ].sort(),
    );
  });

  it('moves one payout from its request to its receipt', async () => {
    const { world, receipts, wired, blocked } = await parts();
    const before = await world.balanceOfRecipient();
    const payout = await world.payout('end-to-end', usdc(3n * ONE_USDC));
    await harness.db.tenant(TENANT).transaction(async (tx) => {
      await enqueueAdvance(tx, payout);
    });
    const worker = await startWorker({
      db: harness.db,
      alert: () => undefined,
      logger: quiet,
      crontabEnabled: false,
      concurrency: 2,
      handlers: workerHandlers(wired),
    });
    try {
      await until(
        'the receipt',
        async () => {
          // The chain moves on while the worker waits, so the payout can reach final.
          await world.h.advance(6n);
          return receipts.rows.length > 0;
        },
        90_000,
      );
    } catch (error) {
      // Where it stopped, so a failure says more than that it timed out.
      const jobs = await adminQuery<{ task: string; attempts: number; last_error: string | null }>(
        harness.database.url,
        `select t.identifier as task, j.attempts, j.last_error from graphile_worker._private_jobs j
           join graphile_worker._private_tasks t on t.id = j.task_id`,
      );
      throw new Error(
        `${(error as Error).message}: payout ${(await world.read(payout.id)).status}, alerts ${JSON.stringify(blocked)}, jobs ${JSON.stringify(jobs).slice(0, 1_500)}`,
        { cause: error },
      );
    } finally {
      await worker.stop();
    }
    expect((await world.read(payout.id)).status).toBe('paid');
    expect((await world.balanceOfRecipient()) - before).toBe(3n * ONE_USDC);
    const [stored] = receipts.rows;
    expect(stored?.payoutId).toBe(payout.id);
    expect(stored?.receipt).toMatchObject({
      principalId: TENANT.principalId,
      projectId: TENANT.projectId,
      revision: 1,
    });
    expect(receipts.rows).toHaveLength(1);
  }, 120_000);
});

describe('a deployment', () => {
  it('refuses to start, naming each store it lacks', () => {
    expect(() => productionParts()).toThrow(WorkerStoresMissingError);
    try {
      productionParts();
    } catch (error) {
      const message = (error as Error).message;
      for (const { issue } of MISSING_STORES) expect(message).toContain(`#${String(issue)}`);
    }
    expect(MISSING_STORES.map(({ issue }) => issue).sort()).toEqual(
      [370, 377, 423, 591, 64].sort(),
    );
  });

  it('says so from the process, before a job is claimed', async () => {
    let refused: unknown;
    try {
      await startWorkerProcess(
        {
          UJIRA_DB_APP_URL: harness.loginUrl('ujira_app'),
          UJIRA_DB_READER_URL: harness.loginUrl('ujira_reader'),
          UJIRA_DB_WORKER_URL: harness.loginUrl('ujira_worker'),
          UJIRA_DB_MIGRATION_URL: harness.database.url,
          UJIRA_DB_TLS: 'off',
        },
        { handlers: workerHandlers(productionParts()) },
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(WorkerStoresMissingError);
  });
});
