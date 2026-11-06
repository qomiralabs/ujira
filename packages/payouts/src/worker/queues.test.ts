// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// On real pools with room to run jobs side by side, so a job holds back only
// because its queue says so.

import { setTimeout as sleep } from 'node:timers/promises';

import { projects, type ProjectContext } from '@ujira/db';
import { adminQuery, jobsIn } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TenantWork } from './handlers.js';
import { startWorker, type WorkerHandlers } from './start.js';
import { PAYOUT_ADVANCE, enqueueTask, type TenantTask } from './tasks.js';
import { newTenant, quiet, until, workerHarness, type WorkerHarness } from './testing/support.js';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
});

afterAll(async () => {
  await harness.close();
});

interface Span {
  readonly group: string;
  readonly start: number;
  readonly end: number;
}

// Records when each job ran, grouped by what should keep it serial.
function recording(groupOf: (job: Parameters<TenantWork>[0]) => string, workMs = 150) {
  const spans: Span[] = [];
  const work: TenantWork = async (job) => {
    const start = Date.now();
    await sleep(workMs);
    spans.push({ group: groupOf(job), start, end: Date.now() });
  };
  return { spans, work };
}

function overlaps(spans: readonly Span[]): number {
  const sorted = [...spans].sort((left, right) => left.start - right.start);
  return sorted.filter((span, index) => {
    const previous = sorted[index - 1];
    return previous !== undefined && span.start < previous.end;
  }).length;
}

async function runUntilDrained(handlers: WorkerHandlers): Promise<void> {
  const worker = await startWorker({
    db: harness.db,
    alert: () => undefined,
    logger: quiet,
    crontabEnabled: false,
    concurrency: 3,
    handlers,
  });
  try {
    await until('the queue to drain', async () => {
      return (await jobsIn(harness.database.url)).length === 0;
    });
  } finally {
    await worker.stop();
  }
}

describe('per mandate queues', () => {
  it('two jobs for one mandate instance never overlap', async () => {
    const tenant = await newTenant(harness.db);
    await harness.db.tenant(tenant).transaction(async (tx) => {
      for (const payoutId of ['p1', 'p2', 'p3']) {
        await enqueueTask(tx, PAYOUT_ADVANCE, { payoutId, mandateId: 'one' });
      }
      for (const payoutId of ['p4', 'p5', 'p6']) {
        await enqueueTask(tx, PAYOUT_ADVANCE, { payoutId, mandateId: 'two' });
      }
    });
    // Longer than the 2 s poll: these jobs were queued before the pool started, so
    // no notification wakes it, and a worker that lost the first claim sleeps until
    // its next poll. Shorter jobs would all finish on one worker before it woke.
    const { spans, work } = recording((job) => job.ids['mandateId'] ?? '', 2_500);
    await runUntilDrained({ payoutAdvance: work });

    const of = (group: string): Span[] => spans.filter((span) => span.group === group);
    expect(of('one')).toHaveLength(3);
    expect(of('two')).toHaveLength(3);
    expect(overlaps(of('one'))).toBe(0);
    expect(overlaps(of('two'))).toBe(0);
    // Not vacuous: the pool could run jobs together, and did so across mandates.
    expect(overlaps(spans)).toBeGreaterThan(0);
  });
});

describe('per principal queues', () => {
  // The recheck of a principal's key rule reads everything that principal holds,
  // so an older reading must never land after a newer one.
  const RECHECK: TenantTask = {
    name: 'principal:recheck',
    ids: ['eventRef'],
    jobKey: (ids) => `recheck:${ids['eventRef'] ?? ''}`,
    queueName: () => 'recheck',
    scope: 'principal',
  };

  it('jobs of two projects of one principal run one at a time', async () => {
    const first = await newTenant(harness.db);
    const second: ProjectContext = {
      principalId: first.principalId,
      projectId: await harness.db
        .tenant(first)
        .transaction(async (tx) => projects.create(tx, { name: 'Second' })),
    };
    const other = await newTenant(harness.db);
    const contexts = [first, second, first, second, other, other];
    for (const [index, context] of contexts.entries()) {
      await harness.db
        .tenant(context)
        .transaction(async (tx) => enqueueTask(tx, RECHECK, { eventRef: `e${String(index)}` }));
    }
    const { spans, work } = recording((job) => job.context.principalId);
    await runUntilDrained({ tenantTasks: [{ task: RECHECK, work }] });

    expect(spans).toHaveLength(6);
    expect(overlaps(spans.filter((span) => span.group === first.principalId))).toBe(0);
    expect(overlaps(spans.filter((span) => span.group === other.principalId))).toBe(0);
  });
});

describe('heartbeats', () => {
  it('a running pool beats, and a stopped one takes its row away', async () => {
    const rows = async (): Promise<readonly { worker_id: string }[]> =>
      adminQuery(harness.database.url, 'select worker_id from ujira_jobs.worker_heartbeats');
    expect(await rows()).toEqual([]);
    const worker = await startWorker({
      db: harness.db,
      alert: () => undefined,
      logger: quiet,
      crontabEnabled: false,
      handlers: {},
    });
    try {
      await until('the first beat', async () => (await rows()).length === 1);
      expect((await rows())[0]?.worker_id).toMatch(/^pool-/);
    } finally {
      await worker.stop();
    }
    expect(await rows()).toEqual([]);
  });
});
