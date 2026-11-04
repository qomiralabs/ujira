// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Enqueueing through the repository, and running what it queued on a real worker
// pool as ujira_worker, so order is proved by what runs and not by a query.

import { randomUUID } from 'node:crypto';

import { Logger, runOnce } from 'graphile-worker';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { jobQueue, type JobIds } from './repositories/jobs.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { queuedJobs } from './testing/jobs-fixture.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let tenant: ProjectContext;
let other: ProjectContext;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const newTenant = async (): Promise<ProjectContext> =>
  db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database);
  tenant = await newTenant();
  other = await newTenant();
});

afterEach(async () => {
  await admin.query('delete from graphile_worker._private_jobs');
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('jobQueue.enqueue', () => {
  it('three jobs enqueued in one transaction keep FIFO order', async () => {
    await db.tenant(tenant).transaction(async (tx) => {
      for (const n of ['1', '2', '3']) {
        await jobQueue.enqueue(tx, {
          task: 'test:order',
          ids: { n },
          queueName: 'mandate:order',
        });
      }
    });
    const ran: unknown[] = [];
    // A run ends as soon as it finds nothing it can claim, and the queue stays
    // locked until the last job's completion lands, so one run can stop early.
    // Order is the claim here, so it runs until the jobs are gone.
    for (let run = 0; run < 10 && (await queuedJobs(admin)).length > 0; run += 1) {
      await runOnce({
        connectionString: roleUrl(roleUrls, 'ujira_worker', database.name),
        concurrency: 1,
        noHandleSignals: true,
        logger: new Logger(() => () => undefined),
        preset: { worker: { completeJobBatchDelay: 0, failJobBatchDelay: 0 } },
        taskList: {
          'test:order': (payload) => {
            ran.push((payload as { n: string }).n);
          },
        },
      });
    }
    expect(ran).toEqual(['1', '2', '3']);
    expect(await queuedJobs(admin)).toEqual([]);
  });

  it('ids with principalId are refused', async () => {
    // The type refuses this too; job-spec.test-d.ts holds that. This is the
    // database refusing an untyped caller.
    const ids = { principalId: other.principalId } as unknown as JobIds;
    const refused = db
      .tenant(tenant)
      .transaction(async (tx) => jobQueue.enqueue(tx, { task: 'test:tenant', ids }));
    expect(await codeOf(refused)).toBe('22023');
    expect(await queuedJobs(admin)).toEqual([]);
  });

  it('a dotted task from an untyped caller is refused', async () => {
    const refused = db.tenant(tenant).transaction(async (tx) =>
      jobQueue.enqueue(tx, {
        task: 'payout.advance' as unknown as `${string}:${string}`,
        ids: {},
      }),
    );
    expect(await codeOf(refused)).toBe('22023');
  });

  it('takes the tenant from the transaction, and returns the job id', async () => {
    const id = await db
      .tenant(tenant)
      .transaction(async (tx) => jobQueue.enqueue(tx, { task: 'test:tenant', ids: { a: 'b' } }));
    const [job] = await queuedJobs(admin);
    expect(BigInt(job?.id ?? '0')).toBe(id);
    expect(job?.payload).toEqual({
      a: 'b',
      principalId: tenant.principalId,
      projectId: tenant.projectId,
    });
  });

  it('commits and rolls back with the transaction', async () => {
    const failed = db.tenant(tenant).transaction(async (tx) => {
      await jobQueue.enqueue(tx, { task: 'test:tenant', ids: {} });
      throw new Error('the write beside it failed');
    });
    await expect(failed).rejects.toThrow('the write beside it failed');
    expect(await queuedJobs(admin)).toEqual([]);
  });

  it('leaves out what the caller left out, and uses the defaults', async () => {
    await db
      .tenant(tenant)
      .transaction(async (tx) => jobQueue.enqueue(tx, { task: 'test:tenant', ids: {} }));
    const [job] = await queuedJobs(admin);
    expect(job?.key).toBeNull();
    expect(job?.queue_name).toBeNull();
    expect(job?.max_attempts).toBe(5);
  });

  it('passes every option through, with the tenant in front of the names', async () => {
    const runAt = new Date(Date.now() + 86_400_000);
    await db.tenant(tenant).transaction(async (tx) =>
      jobQueue.enqueue(tx, {
        task: 'test:tenant',
        ids: {},
        jobKey: 'k1',
        queueName: 'q1',
        runAt,
        maxAttempts: 7,
        keyMode: 'preserve_run_at',
      }),
    );
    const [job] = await queuedJobs(admin);
    const prefix = `${tenant.principalId}:${tenant.projectId}:`;
    expect(job?.key).toBe(`${prefix}k1`);
    expect(job?.queue_name).toBe(`${prefix}q1`);
    expect(job?.run_at).toEqual(runAt);
    expect(job?.max_attempts).toBe(7);
  });

  it('a principal scope drops the project from the names, not from the payload', async () => {
    await db.tenant(tenant).transaction(async (tx) =>
      jobQueue.enqueue(tx, {
        task: 'test:tenant',
        ids: {},
        queueName: 'recheck',
        scope: 'principal',
      }),
    );
    const [job] = await queuedJobs(admin);
    expect(job?.queue_name).toBe(`${tenant.principalId}:*:recheck`);
    expect(job?.payload['projectId']).toBe(tenant.projectId);
  });

  it('a principal wide read only transaction cannot enqueue', async () => {
    const refused = db
      .principal(tenant, 'app')
      .transaction(async (tx) => jobQueue.enqueue(tx, { task: 'test:tenant', ids: {} }));
    expect(await codeOf(refused)).toBe('UJ001');
  });
});
