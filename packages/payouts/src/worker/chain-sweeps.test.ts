// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The two chain sweeps a worker runs. The adapter's own side of each is tested in
// the adapter, so these hold what the worker adds: that they run, on what, and under
// whose tenant.

import type { NetworkId } from '@ujira/chain-adapter';
import { jobPayloadProblems, type ProjectContext } from '@ujira/db';
import { adminQuery, jobsIn } from '@ujira/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { submissionSweep, ttlSweep, type SubmissionSweeper } from './crons.js';
import { SUBMISSION_SWEEP } from './settings.js';
import { startWorker } from './start.js';
import { TTL_KEEP_ALIVE, enqueueTask } from './tasks.js';
import {
  helpersFor,
  newInstance,
  newTenant,
  quiet,
  until,
  workerHarness,
  type WorkerHarness,
} from './testing/support.js';

const TESTNET: NetworkId = 'stellar:testnet';
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
});

afterEach(async () => {
  await adminQuery(harness.database.url, 'delete from graphile_worker._private_jobs');
});

afterAll(async () => {
  await harness.close();
});

describe('submissions:reconcile', () => {
  it('asks every network to reconcile, with the configured limits', async () => {
    const asked: unknown[] = [];
    const sweeper: SubmissionSweeper = {
      reconcileUnresolved: (sweep, opts) => {
        asked.push({ sweep, correlationId: opts.correlationId });
        return Promise.resolve([]);
      },
    };
    await submissionSweep([sweeper, sweeper])({}, helpersFor('7'));
    expect(asked).toEqual([
      { sweep: SUBMISSION_SWEEP, correlationId: 'submissions:reconcile:7' },
      { sweep: SUBMISSION_SWEEP, correlationId: 'submissions:reconcile:7' },
    ]);
  });

  it('one network failing still lets the others run, and fails the job', async () => {
    let healthy = 0;
    const failure = new Error('rpc down');
    await expect(
      submissionSweep([
        { reconcileUnresolved: () => Promise.reject(failure) },
        {
          reconcileUnresolved: () => {
            healthy += 1;
            return Promise.resolve([]);
          },
        },
      ])({}, helpersFor('8')),
    ).rejects.toBe(failure);
    expect(healthy).toBe(1);
  });
});

describe('ttl:keep_alive', () => {
  it('has a payload of ids', () => {
    expect(jobPayloadProblems({ [TTL_KEEP_ALIVE.name]: [...TTL_KEEP_ALIVE.ids, 'try'] })).toEqual(
      [],
    );
  });

  it('runs on a real pool, as a tenant job, with the fields the adapter parses', async () => {
    const tenant = await newTenant(harness.db);
    const ids = { network: TESTNET, mandateRef: CONTRACT };
    await harness.db.tenant(tenant).transaction(async (tx) => enqueueTask(tx, TTL_KEEP_ALIVE, ids));
    const ran: unknown[] = [];
    const worker = await startWorker({
      db: harness.db,
      alert: () => undefined,
      logger: quiet,
      crontabEnabled: false,
      handlers: {
        ttlKeepAlive: {
          networks: [TESTNET],
          run: (payload) => {
            ran.push(payload);
            return Promise.resolve();
          },
        },
      },
    });
    try {
      await until('the job to run', async () => (await jobsIn(harness.database.url)).length === 0);
    } finally {
      await worker.stop();
    }
    expect(ran).toEqual([{ ...tenant, ...ids }]);
  });
});

describe('ttl:sweep', () => {
  it('queues one job per instance, each under its own tenant, and repeats as a replace', async () => {
    const owners = new Map<string, ProjectContext>();
    for (const tenant of [await newTenant(harness.db), await newTenant(harness.db)]) {
      for (let count = 0; count < 2; count += 1) {
        owners.set(await newInstance(harness.db, tenant), tenant);
      }
    }
    const opened: ProjectContext[] = [];
    const db = {
      ...harness.db,
      tenant: (context: ProjectContext) => {
        opened.push(context);
        return harness.db.tenant(context);
      },
    };
    const sweep = ttlSweep({ db, networks: [TESTNET], pageSize: 3 });
    await sweep({}, helpersFor('1'));

    const total = (
      await adminQuery<{ count: string }>(
        harness.database.url,
        'select count(*)::text as count from ujira.mandate_instances',
      )
    )[0]?.count;
    const jobs = await jobsIn(harness.database.url);
    expect(String(jobs.length)).toBe(total);
    expect(opened.length).toBeGreaterThanOrEqual(owners.size);
    for (const job of jobs) {
      expect(job.task_identifier).toBe('ttl:keep_alive');
      expect(job.payload['network']).toBe(TESTNET);
      expect(Object.keys(job.payload).sort()).toEqual([
        'mandateRef',
        'network',
        'principalId',
        'projectId',
      ]);
    }
    // Each job is filed under the tenant that owns the contract it names.
    const crossTenant = await adminQuery(
      harness.database.url,
      `select j.id
         from graphile_worker._private_jobs as j
         left join ujira.mandate_instances as i
           on i.contract_address = j.payload->>'mandateRef'
          and i.principal_id = (j.payload->>'principalId')::uuid
          and i.project_id = (j.payload->>'projectId')::uuid
        where i.id is null`,
    );
    expect(crossTenant).toEqual([]);

    await sweep({}, helpersFor('2'));
    expect((await jobsIn(harness.database.url)).length).toBe(jobs.length);
  });

  it('leaves alone an instance on a chain with no network here', async () => {
    const tenant = await newTenant(harness.db);
    await newInstance(harness.db, tenant);
    await ttlSweep({ db: harness.db, networks: [] })({}, helpersFor('3'));
    expect(await jobsIn(harness.database.url)).toEqual([]);
  });

  it('stops when the pool is shutting down', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      ttlSweep({ db: harness.db, networks: [TESTNET] })({}, helpersFor('4', controller.signal)),
    ).rejects.toThrow();
  });
});
