// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { deadLetters, type DeadLetter, type ProjectContext } from '@ujira/db';
import { adminQuery, jobsIn } from '@ujira/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { UnknownTaskError, replayDeadLetter } from './dead-letters.js';
import { RetryableJobError } from './errors.js';
import { onJobExhausted, tenantTask, type WorkerAlert } from './handlers.js';
import { startWorker } from './start.js';
import { PAYOUT_ADVANCE, enqueueTask } from './tasks.js';
import {
  helpersFor,
  newTenant,
  quiet,
  until,
  workerHarness,
  type WorkerHarness,
} from './testing/support.js';

const IDS = { payoutId: 'p1', mandateId: 'm1' };

let harness: WorkerHarness;
let tenant: ProjectContext;
let alerts: WorkerAlert[];

const alert = (fired: WorkerAlert): void => {
  alerts.push(fired);
};

async function openLetters(context = tenant): Promise<readonly DeadLetter[]> {
  const page = await harness.db
    .tenant(context)
    .transaction(async (tx) => deadLetters.open(tx, { limit: 100 }));
  return page.items;
}

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
});

afterEach(async () => {
  await adminQuery(harness.database.url, 'delete from graphile_worker._private_jobs');
});

afterAll(async () => {
  await harness.close();
});

// Each test has a tenant of its own, so a letter from one is not another's.
async function freshTenant(): Promise<void> {
  tenant = await newTenant(harness.db);
  alerts = [];
}

describe('the handler curve', () => {
  it('a retryable failure enqueues the next try under the same key, and completes', async () => {
    await freshTenant();
    const now = Date.now();
    const task = tenantTask(
      PAYOUT_ADVANCE,
      () => Promise.reject(new RetryableJobError('RPC_UNAVAILABLE')),
      { db: harness.db, alert, now: () => now },
    );
    await task({ ...tenant, ...IDS, try: '3' }, helpersFor('1'));

    const [job, ...others] = await jobsIn(harness.database.url);
    expect(others).toEqual([]);
    expect(job?.payload).toMatchObject({ try: '4', payoutId: 'p1' });
    expect(job?.key).toBe(`${tenant.principalId}:${tenant.projectId}:payout:p1`);
    expect(job?.run_at).toEqual(new Date(now + 20_000));
    expect(await openLetters()).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('at try 12 it writes the dead letter and alerts, and queues nothing', async () => {
    await freshTenant();
    const task = tenantTask(
      PAYOUT_ADVANCE,
      () => Promise.reject(new RetryableJobError('RPC_UNAVAILABLE')),
      { db: harness.db, alert },
    );
    await task({ ...tenant, ...IDS, try: '12' }, helpersFor('41'));

    expect(await jobsIn(harness.database.url)).toEqual([]);
    const [letter, ...others] = await openLetters();
    expect(others).toEqual([]);
    expect(letter).toMatchObject({
      sourceJobId: 41n,
      task: 'payout:advance',
      ids: IDS,
      tries: 12,
      reason: 'RPC_UNAVAILABLE',
      replayedAt: null,
    });
    expect(alerts).toEqual([
      {
        kind: 'dead_letter',
        task: 'payout:advance',
        principalId: tenant.principalId,
        projectId: tenant.projectId,
        deadLetterId: letter?.id,
        reason: 'RPC_UNAVAILABLE',
      },
    ]);
  });

  it('a job that dies after writing its letter writes one row, and alerts again', async () => {
    await freshTenant();
    const job = { id: '42', task_identifier: 'payout:advance', payload: { ...tenant, ...IDS } };
    await onJobExhausted({ db: harness.db, alert }, job, new Error('crash'));
    await onJobExhausted({ db: harness.db, alert }, job, new Error('crash'));
    expect(await openLetters()).toHaveLength(1);
    expect(alerts).toHaveLength(2);
  });
});

describe('the net under it', () => {
  it('a job that throws until its attempts run out reaches the dead letters', async () => {
    await freshTenant();
    await harness.db
      .tenant(tenant)
      .transaction(async (tx) => enqueueTask(tx, PAYOUT_ADVANCE, IDS, { maxAttempts: 1 }));
    const worker = await startWorker({
      db: harness.db,
      alert,
      logger: quiet,
      crontabEnabled: false,
      handlers: { payoutAdvance: () => Promise.reject(new TypeError('a bug')) },
    });
    try {
      await until('the dead letter', async () => (await openLetters()).length === 1);
    } finally {
      await worker.stop();
    }
    const [letter] = await openLetters();
    expect(letter).toMatchObject({ task: 'payout:advance', reason: 'HANDLER_FAILED', tries: 1 });
    expect(alerts.map((fired) => fired.kind)).toEqual(['dead_letter']);
    // Out of attempts, it stays in the queue's table and is never claimed again.
    const [row] = await adminQuery<{ attempts: number; max_attempts: number }>(
      harness.database.url,
      'select attempts, max_attempts from graphile_worker._private_jobs',
    );
    expect(row).toEqual({ attempts: 1, max_attempts: 1 });
  });

  it('keeps a retryable code when the attempts ran out on one', async () => {
    await freshTenant();
    await onJobExhausted(
      { db: harness.db, alert },
      { id: '43', task_identifier: 'payout:advance', payload: { ...tenant, ...IDS } },
      new RetryableJobError('RPC_UNAVAILABLE'),
    );
    expect((await openLetters())[0]?.reason).toBe('RPC_UNAVAILABLE');
  });

  it('with no tenant to file it under, it still alerts', async () => {
    await freshTenant();
    await onJobExhausted(
      { db: harness.db, alert },
      { id: '44', task_identifier: 'payout:advance', payload: { garbled: true } },
      new Error('crash'),
    );
    await onJobExhausted(
      { db: harness.db, alert },
      { id: '45', task_identifier: 'receipt:issue', payload: {} },
      new Error('crash'),
    );
    expect(alerts).toEqual([
      { kind: 'job_exhausted', task: 'payout:advance', jobId: '44' },
      { kind: 'job_exhausted', task: 'receipt:issue', jobId: '45' },
    ]);
  });
});

describe('replay', () => {
  async function aLetter(): Promise<DeadLetter> {
    await freshTenant();
    await onJobExhausted(
      { db: harness.db, alert },
      { id: '50', task_identifier: 'payout:advance', payload: { ...tenant, ...IDS, try: '12' } },
      new RetryableJobError('RPC_UNAVAILABLE'),
    );
    const [letter] = await openLetters();
    if (letter === undefined) throw new Error('no letter');
    return letter;
  }

  it('puts the job back from the first try, and takes the letter off the open list', async () => {
    const letter = await aLetter();
    const jobId = await replayDeadLetter(harness.db, tenant, letter.id);
    expect(jobId).toBeDefined();

    const [job] = await jobsIn(harness.database.url);
    expect(job?.payload).toEqual({ ...tenant, ...IDS });
    expect(job?.key).toBe(`${tenant.principalId}:${tenant.projectId}:payout:p1`);
    expect(await openLetters()).toEqual([]);
  });

  it('a second replay makes no second job', async () => {
    const letter = await aLetter();
    await replayDeadLetter(harness.db, tenant, letter.id);
    expect(await replayDeadLetter(harness.db, tenant, letter.id)).toBeUndefined();
    expect(await jobsIn(harness.database.url)).toHaveLength(1);
  });

  it('another tenant cannot replay it, or tell it exists', async () => {
    const letter = await aLetter();
    const other = await newTenant(harness.db);
    expect(await replayDeadLetter(harness.db, other, letter.id)).toBeUndefined();
    expect(await jobsIn(harness.database.url)).toEqual([]);
    expect(await openLetters()).toHaveLength(1);
  });

  it('refuses a task nothing can run, and leaves the letter open', async () => {
    const letter = await aLetter();
    await expect(replayDeadLetter(harness.db, tenant, letter.id, [])).rejects.toBeInstanceOf(
      UnknownTaskError,
    );
    expect(await openLetters()).toHaveLength(1);
  });
});

describe('the row', () => {
  it.each([
    ['a message for a reason', { reason: 'the recipient a@example.com failed' }],
    ['a dotted task', { task: 'payout.advance' as `${string}:${string}` }],
    ['a tenant id in the ids', { ids: { principalId: 'x' } as never }],
  ])('refuses %s', async (_name, change) => {
    await freshTenant();
    await expect(
      harness.db.tenant(tenant).transaction(async (tx) =>
        deadLetters.record(tx, {
          sourceJobId: 60n,
          task: 'payout:advance',
          ids: IDS,
          tries: 1,
          reason: 'RPC_UNAVAILABLE',
          ...change,
        }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
