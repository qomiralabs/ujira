// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Database } from '@ujira/db';
import { parseCrontab, type Task } from 'graphile-worker';
import { describe, expect, it } from 'vitest';

import { WorkerConfigError } from './errors.js';
import { WORKER_SETTINGS, workerPreset } from './settings.js';
import { buildTaskList, unwiredTasks } from './start.js';

const db = {} as unknown as Database;
const alert = (): void => undefined;
const work = (): Promise<void> => Promise.resolve();

describe('worker settings', () => {
  it('completeJobBatchDelay and failJobBatchDelay are 0', () => {
    expect(WORKER_SETTINGS.completeJobBatchDelay).toBe(0);
    expect(WORKER_SETTINGS.failJobBatchDelay).toBe(0);
    const { worker } = workerPreset(3);
    expect(worker.completeJobBatchDelay).toBe(0);
    expect(worker.failJobBatchDelay).toBe(0);
  });

  it('gives a running job 5 s to finish, and leaves the local queue off', () => {
    expect(WORKER_SETTINGS.gracefulShutdownAbortTimeout).toBe(5_000);
    expect(WORKER_SETTINGS.localQueue.size).toBe(-1);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(WORKER_SETTINGS)).toBe(true);
    expect(Object.isFrozen(WORKER_SETTINGS.localQueue)).toBe(true);
  });

  it('takes the concurrency it is given', () => {
    expect(workerPreset(7).worker.concurrentJobs).toBe(7);
  });
});

describe('the task list', () => {
  it('always frees stale locks, and registers nothing else without a handler', () => {
    const { taskList, crontab } = buildTaskList({ db, alert, handlers: {} });
    expect(Object.keys(taskList)).toEqual(['jobs:unlock_stale']);
    expect(crontab).toBe('* * * * * jobs:unlock_stale');
  });

  it('registers each task with a handler, and schedules the crons that feed them', () => {
    const { taskList, crontab } = buildTaskList({
      db,
      alert,
      handlers: {
        payoutAdvance: work,
        batchAdvance: work,
        mandateReconcile: work,
        indexerScan: work,
      },
    });
    expect(Object.keys(taskList).sort()).toEqual([
      'batch:advance',
      'indexer:scan',
      'jobs:unlock_stale',
      'mandate:reconcile',
      'payout:advance',
      'reconcile:sweep',
    ]);
    // Every line is one the library's own parser accepts.
    expect(
      parseCrontab(crontab)
        .map((item) => item.task)
        .sort(),
    ).toEqual(['indexer:scan', 'jobs:unlock_stale', 'reconcile:sweep']);
  });

  it('registers and schedules the sweep that closes open chain submissions', () => {
    const { taskList, crontab } = buildTaskList({
      db,
      alert,
      handlers: { submissionSweepers: [{ reconcileUnresolved: () => Promise.resolve([]) }] },
    });
    expect(Object.keys(taskList)).toContain('submissions:reconcile');
    expect(parseCrontab(crontab).map((item) => item.task)).toContain('submissions:reconcile');
  });

  it('registers the TTL keep-alive under a colon name, and schedules its fan-out', () => {
    const { taskList, crontab, tenantTasks } = buildTaskList({
      db,
      alert,
      handlers: { ttlKeepAlive: { run: work, networks: ['stellar:testnet'] } },
    });
    expect(Object.keys(taskList)).toContain('ttl:keep_alive');
    expect(Object.keys(taskList)).toContain('ttl:sweep');
    expect(tenantTasks.map((task) => task.name)).toContain('ttl:keep_alive');
    expect(parseCrontab(crontab).map((item) => item.task)).toContain('ttl:sweep');
  });

  it('names every expected task that has no handler', () => {
    expect(unwiredTasks({})).toEqual([
      'payout:advance',
      'batch:advance',
      'mandate:reconcile',
      'indexer:scan',
      'submissions:reconcile',
      'ttl:keep_alive',
    ]);
    expect(
      unwiredTasks({
        submissionSweepers: [],
        ttlKeepAlive: { run: work, networks: [] },
      }),
    ).toEqual(['payout:advance', 'batch:advance', 'mandate:reconcile', 'indexer:scan']);
  });

  it('takes tasks from other packages, with their cron lines', () => {
    const plugin: Task = () => undefined;
    const { taskList, crontab } = buildTaskList({
      db,
      alert,
      handlers: {
        plugins: { 'receipt:issue': plugin },
        crontab: ['0 3 * * * payouts:refresh_fee_estimates'],
      },
    });
    expect(taskList['receipt:issue']).toBe(plugin);
    expect(crontab).toContain('payouts:refresh_fee_estimates');
  });

  it('refuses a task name with a dot at startup, since no job of it could ever run', () => {
    expect(() =>
      buildTaskList({
        db,
        alert,
        handlers: { plugins: { 'some_package.some_task': () => undefined } },
      }),
    ).toThrow(WorkerConfigError);
  });
});
