// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { NetworkId } from '@ujira/chain-adapter';
import type { Database } from '@ujira/db';
import { parseCrontab, type Task } from 'graphile-worker';
import { describe, expect, it, vi } from 'vitest';

import { JobPayloadError, WorkerConfigError } from './errors.js';
import { WORKER_SETTINGS, workerPreset } from './settings.js';
import { buildTaskList, unwiredTasks } from './start.js';
import { helpersFor } from './testing/support.js';

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
        indexerScans: [
          { network: 'stellar:testnet', scan: { step: () => Promise.resolve({ events: 0 }) } },
        ],
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

  describe('the indexer scan', () => {
    const NETWORK = 'stellar:testnet';
    const stepping = (pages: readonly number[]) => {
      let call = 0;
      const step = vi.fn(() => {
        call += 1;
        return Promise.resolve({ events: pages[call - 1] ?? 0 });
      });
      return { network: NETWORK as NetworkId, scan: { step } };
    };

    it('registers one, and gives each network its own serial cron line', () => {
      const other = { ...stepping([]), network: 'stellar:pubnet' as NetworkId };
      const { taskList, crontab } = buildTaskList({
        db,
        alert,
        handlers: { indexerScans: [stepping([]), other] },
      });
      expect(Object.keys(taskList)).toContain('indexer:scan');
      const lines = parseCrontab(crontab).filter((item) => item.task === 'indexer:scan');
      expect(lines.map((item) => item.payload)).toEqual([
        { network: NETWORK },
        { network: 'stellar:pubnet' },
      ]);
      expect(lines.map((item) => item.options.queueName)).toEqual([
        `indexer:scan:${NETWORK}`,
        'indexer:scan:stellar:pubnet',
      ]);
      expect(new Set(lines.map((item) => item.identifier)).size).toBe(2);
    });

    const run = async (
      scans: readonly ReturnType<typeof stepping>[],
      payload: unknown,
      signal = new AbortController().signal,
    ): Promise<void> => {
      const task = buildTaskList({ db, alert, handlers: { indexerScans: scans } }).taskList[
        'indexer:scan'
      ];
      await task?.(payload, helpersFor('7', signal));
    };

    it('reads pages until the chain has no more', async () => {
      const scan = stepping([5, 5, 0]);
      await run([scan], { network: NETWORK });
      expect(scan.scan.step).toHaveBeenCalledTimes(3);
      expect(scan.scan.step).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'indexer:scan:7' }),
      );
    });

    it('stops at its bound, leaving the rest for the next run', async () => {
      const scan = stepping(Array.from({ length: 50 }, () => 5));
      await run([scan], { network: NETWORK });
      expect(scan.scan.step).toHaveBeenCalledTimes(20);
    });

    it('stops when the worker is shutting down', async () => {
      const scan = stepping([5, 5]);
      const stopping = new AbortController();
      stopping.abort();
      await run([scan], { network: NETWORK }, stopping.signal);
      expect(scan.scan.step).not.toHaveBeenCalled();
    });

    it('fails so the queue retries, with the cursor left to the scan', async () => {
      const scan = {
        network: NETWORK as NetworkId,
        scan: { step: vi.fn(() => Promise.reject(new Error('node down'))) },
      };
      const task = buildTaskList({ db, alert, handlers: { indexerScans: [scan] } }).taskList[
        'indexer:scan'
      ];
      await expect(task?.({ network: NETWORK }, helpersFor('7'))).rejects.toThrow('node down');
    });

    it.each([
      ['a network with no scan', { network: 'stellar:pubnet' }],
      ['no network', {}],
      ['not an object', 'stellar:testnet'],
    ])('refuses %s', async (_label, payload) => {
      const scan = stepping([]);
      await expect(run([scan], payload)).rejects.toBeInstanceOf(JobPayloadError);
      expect(scan.scan.step).not.toHaveBeenCalled();
    });
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
      'payouts:release_held',
      'payouts:cancel_lapsed',
      'payouts:release_sweep',
      'payouts:cancel_lapsed_sweep',
      'receipt:issue',
    ]);
    expect(
      unwiredTasks({
        submissionSweepers: [],
        ttlKeepAlive: { run: work, networks: [] },
      }),
    ).toEqual([
      'payout:advance',
      'batch:advance',
      'mandate:reconcile',
      'indexer:scan',
      'payouts:release_held',
      'payouts:cancel_lapsed',
      'payouts:release_sweep',
      'payouts:cancel_lapsed_sweep',
      'receipt:issue',
    ]);
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
