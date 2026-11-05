// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Database, ProjectContext } from '@ujira/db';
import { adminQuery, jobsIn } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reconcileSweep } from './crons.js';
import { SWEEP_PAGE_SIZE } from './settings.js';
import {
  helpersFor,
  newInstance,
  newTenant,
  workerHarness,
  type WorkerHarness,
} from './testing/support.js';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
});

afterAll(async () => {
  await harness.close();
});

describe('reconcile:sweep', () => {
  it('one tenant transaction per target, zero cross-tenant rows', async () => {
    const tenants = [await newTenant(harness.db), await newTenant(harness.db)];
    const tenantOf = new Map<string, ProjectContext>();
    for (const tenant of tenants) {
      for (let count = 0; count < 3; count += 1) {
        tenantOf.set(await newInstance(harness.db, tenant), tenant);
      }
    }

    const opened: ProjectContext[] = [];
    const spied: Database = {
      ...harness.db,
      tenant: (context) => {
        opened.push(context);
        return harness.db.tenant(context);
      },
    };
    // A small page, so the sweep has to follow the key across pages.
    await reconcileSweep({ db: spied, pageSize: 4 })({}, helpersFor('1'));

    expect(opened).toHaveLength(tenantOf.size);

    const jobs = await jobsIn(harness.database.url);
    expect(jobs).toHaveLength(tenantOf.size);
    const seen = new Set<string>();
    for (const job of jobs) {
      expect(job.task_identifier).toBe('mandate:reconcile');
      const instance = String(job.payload['mandateInstanceId']);
      seen.add(instance);
      // Each job is filed under the tenant that owns its instance.
      expect({
        principalId: job.payload['principalId'],
        projectId: job.payload['projectId'],
      }).toEqual(tenantOf.get(instance));
    }
    expect(seen.size).toBe(tenantOf.size);

    // And the database agrees, reading each job against the table itself.
    const crossTenant = await adminQuery(
      harness.database.url,
      `select j.id
         from graphile_worker._private_jobs as j
         left join ujira.mandate_instances as i
           on i.id = (j.payload->>'mandateInstanceId')::uuid
          and i.principal_id = (j.payload->>'principalId')::uuid
          and i.project_id = (j.payload->>'projectId')::uuid
        where i.id is null`,
    );
    expect(crossTenant).toEqual([]);
  });

  it('sweeping again replaces each job, so the queue does not grow', async () => {
    const before = (await jobsIn(harness.database.url)).length;
    await reconcileSweep({ db: harness.db, pageSize: SWEEP_PAGE_SIZE })({}, helpersFor('2'));
    expect((await jobsIn(harness.database.url)).length).toBe(before);
  });

  it('the app login still cannot scan what the function reads for it', async () => {
    await expect(
      adminQuery(harness.loginUrl('ujira_app'), 'select id from ujira.mandate_instances'),
    ).rejects.toMatchObject({ code: 'UJ001' });
  });

  it('stops when the pool is shutting down', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      reconcileSweep({ db: harness.db })({}, helpersFor('3', controller.signal)),
    ).rejects.toThrow();
  });
});
