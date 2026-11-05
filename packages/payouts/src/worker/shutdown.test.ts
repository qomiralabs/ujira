// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A real signal to a real process. With the library's default batch delays the
// completion is sent without being waited for, the process exits first, and the
// job stays locked, which is what these settings exist to prevent.

import { adminQuery, jobsIn } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueueTask, type TenantTask } from './tasks.js';
import {
  newTenant,
  startPoolProcess,
  workerHarness,
  type WorkerHarness,
} from './testing/support.js';

const SLOW: TenantTask = {
  name: 'test:slow',
  ids: [],
  jobKey: () => 'slow',
  queueName: () => 'mandate:shutdown',
};

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
});

afterAll(async () => {
  await harness.close();
});

describe('a graceful shutdown', () => {
  it('SIGTERM mid-job keeps the completion', async () => {
    const tenant = await newTenant(harness.db);
    await harness.db.tenant(tenant).transaction(async (tx) => enqueueTask(tx, SLOW, {}));

    const pool = startPoolProcess(harness.loginUrl('ujira_worker'), 'finish');
    try {
      await pool.printed('started');
      pool.child.kill('SIGTERM');
      await pool.exited;
    } finally {
      pool.child.kill('SIGKILL');
    }

    // The job really ran to its end after the signal, and its completion landed:
    // no job left behind, and the queue is free for the next.
    expect(await jobsIn(harness.database.url)).toEqual([]);
    const queues = await adminQuery<{ locked_by: string | null }>(
      harness.database.url,
      'select locked_by from graphile_worker._private_job_queues where locked_by is not null',
    );
    expect(queues).toEqual([]);
  });
});
