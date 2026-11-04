// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { workerPools, type ProjectContext } from '@ujira/db';
import { adminQuery, jobsIn } from '@ujira/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { unlockStale } from './crons.js';
import type { WorkerAlert } from './handlers.js';
import { startWorker } from './start.js';
import { enqueueTask, type TenantTask } from './tasks.js';
import {
  helpersFor,
  newTenant,
  quiet,
  startPoolProcess,
  until,
  workerHarness,
  type WorkerHarness,
} from './testing/support.js';

// The task the pool in the child process runs.
const SLOW: TenantTask = {
  name: 'test:slow',
  ids: ['n'],
  jobKey: (ids) => `slow:${ids['n'] ?? ''}`,
  queueName: () => 'mandate:stale',
};

let harness: WorkerHarness;
let tenant: ProjectContext;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  tenant = await newTenant(harness.db);
});

afterEach(async () => {
  await adminQuery(harness.database.url, 'delete from graphile_worker._private_jobs');
});

afterAll(async () => {
  await harness.close();
});

async function enqueueTwo(): Promise<void> {
  await harness.db.tenant(tenant).transaction(async (tx) => {
    await enqueueTask(tx, SLOW, { n: '1' });
    await enqueueTask(tx, SLOW, { n: '2' });
  });
}

async function ageLocks(): Promise<void> {
  for (const table of ['_private_jobs', '_private_job_queues']) {
    await adminQuery(
      harness.database.url,
      `update graphile_worker.${table} set locked_at = now() - interval '3 minutes'
        where locked_by is not null`,
    );
  }
}

async function runCron(alerts: WorkerAlert[] = []): Promise<WorkerAlert[]> {
  const task = unlockStale({
    db: harness.db,
    alert: (fired) => {
      alerts.push(fired);
    },
  });
  await task({}, helpersFor('1'));
  return alerts;
}

describe('jobs:unlock_stale', () => {
  it("a killed pool's lock is released and the queue resumes", async () => {
    await enqueueTwo();
    const pool = startPoolProcess(harness.loginUrl('ujira_worker'), 'hang');
    const poolId = await pool.poolId();
    await pool.printed('started');
    pool.child.kill('SIGKILL');
    await pool.exited;

    // The dead pool still holds its job and the whole queue.
    const locked = await adminQuery<{ locked_by: string }>(
      harness.database.url,
      'select locked_by from graphile_worker._private_job_queues where locked_by is not null',
    );
    expect(locked).toEqual([{ locked_by: poolId }]);

    // A lock this young is left alone, heartbeat or not: a pool that has just
    // started can hold one before its first beat lands.
    expect(await runCron()).toEqual([]);
    expect(
      await adminQuery(
        harness.database.url,
        'select 1 from graphile_worker._private_job_queues where locked_by is not null',
      ),
    ).toHaveLength(1);

    await ageLocks();
    expect(await runCron()).toEqual([{ kind: 'locks_released', pools: [poolId] }]);

    // Both jobs run now, the one it died holding and the one queued behind it.
    const ran: string[] = [];
    const worker = await startWorker({
      db: harness.db,
      alert: () => undefined,
      logger: quiet,
      crontabEnabled: false,
      handlers: {
        tenantTasks: [
          {
            task: SLOW,
            work: (job) => {
              ran.push(job.ids['n'] ?? '');
              return Promise.resolve();
            },
          },
        ],
      },
    });
    try {
      await until('the queue to resume', async () => {
        return (await jobsIn(harness.database.url)).length === 0;
      });
    } finally {
      await worker.stop();
    }
    expect([...ran].sort()).toEqual(['1', '2']);
  });

  it('a pool still beating keeps its lock, however old', async () => {
    await enqueueTwo();
    await adminQuery(
      harness.database.url,
      `update graphile_worker._private_jobs set locked_by = 'pool-alive', locked_at = now()`,
    );
    await ageLocks();
    await harness.db.unscoped(async (tx) => workerPools.beat(tx, 'pool-alive'), 'worker');
    expect(await runCron()).toEqual([]);
    const held = await adminQuery(
      harness.database.url,
      `select 1 from graphile_worker._private_jobs where locked_by = 'pool-alive'`,
    );
    expect(held).toHaveLength(2);
    await harness.db.unscoped(async (tx) => workerPools.forget(tx, 'pool-alive'), 'worker');
  });

  it('a pool that stopped beating loses its lock', async () => {
    await enqueueTwo();
    await adminQuery(
      harness.database.url,
      `update graphile_worker._private_jobs set locked_by = 'pool-silent', locked_at = now()`,
    );
    await ageLocks();
    await harness.db.unscoped(async (tx) => workerPools.beat(tx, 'pool-silent'), 'worker');
    await adminQuery(
      harness.database.url,
      `update ujira_jobs.worker_heartbeats set last_seen_at = now() - interval '3 minutes'`,
    );
    expect(await runCron()).toEqual([{ kind: 'locks_released', pools: ['pool-silent'] }]);
    await harness.db.unscoped(async (tx) => workerPools.forget(tx, 'pool-silent'), 'worker');
  });

  it('clears away the row of a pool long gone', async () => {
    await harness.db.unscoped(async (tx) => workerPools.beat(tx, 'pool-gone'), 'worker');
    await adminQuery(
      harness.database.url,
      `update ujira_jobs.worker_heartbeats set last_seen_at = now() - interval '2 days'`,
    );
    await runCron();
    expect(
      await adminQuery(harness.database.url, 'select 1 from ujira_jobs.worker_heartbeats'),
    ).toEqual([]);
  });
});
