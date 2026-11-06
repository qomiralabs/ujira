// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Starting a worker pool. The pool runs on the worker login's connection and
// handlers run on the app login's, so a queue query can never read a tenant's rows.
//
// A handler is passed in for each task a deployment can serve. A task with no
// handler is not registered, so its jobs wait rather than fail, and its cron is not
// scheduled. Work owned by other packages plugs in through `plugins`, with its own
// retries, or as a tenant task for the handler's curve.

import { EventEmitter } from 'node:events';

import { workerPools, type Database } from '@ujira/db';
import { RECEIPT_ISSUE_TASK } from '@ujira/receipts';
import { run, type Logger, type Task, type TaskList, type WorkerEvents } from 'graphile-worker';

import type { NetworkId } from '@ujira/chain-adapter';

import {
  indexerScan,
  indexerScanCron,
  type NetworkScan,
  reconcileSweep,
  submissionSweep,
  type SubmissionSweeper,
  ttlSweep,
  unlockStale,
} from './crons.js';
import { WorkerConfigError } from './errors.js';
import {
  onJobExhausted,
  tenantTask,
  type Alert,
  type HandlerDeps,
  type TenantWork,
} from './handlers.js';
import { DEFAULT_CONCURRENCY, HEARTBEAT_EVERY_MS, workerPreset } from './settings.js';
import {
  BATCH_ADVANCE,
  CANCEL_LAPSED,
  COMPLIANCE_RECHECK,
  MANDATE_RECONCILE,
  PAYOUT_ADVANCE,
  RELEASE_HELD,
  SYSTEM_TASKS,
  TENANT_TASKS,
  type TenantTask,
  TTL_KEEP_ALIVE,
} from './tasks.js';

export interface WorkerHandlers {
  readonly payoutAdvance?: TenantWork;
  readonly batchAdvance?: TenantWork;
  readonly mandateReconcile?: TenantWork;
  // Mirrors the chain's events, one scan per network. Nothing else flags a mandate.
  readonly indexerScans?: readonly NetworkScan[];
  // Closes the chain submissions still open, one sweeper per network.
  readonly submissionSweepers?: readonly SubmissionSweeper[];
  // The adapter's keep-alive task, and the networks to run it on.
  readonly ttlKeepAlive?: {
    readonly run: (payload: unknown) => Promise<void>;
    readonly networks: readonly NetworkId[];
  };
  // Other tenant tasks on the handler's curve, such as a recheck that runs one at
  // a time per principal.
  readonly tenantTasks?: readonly { readonly task: TenantTask; readonly work: TenantWork }[];
  // Tasks that keep their own retries, by name.
  readonly plugins?: Readonly<Record<string, Task>>;
  // Crontab lines for those tasks.
  readonly crontab?: readonly string[];
}

export interface StartWorkerOptions {
  // The app pool for handlers, and the worker login's pool for the queue.
  readonly db: Database;
  readonly handlers: WorkerHandlers;
  readonly alert: Alert;
  readonly concurrency?: number;
  readonly logger?: Logger;
  readonly crontabEnabled?: boolean;
}

export interface RunningWorker {
  // Finishes running jobs, within the grace, and takes this pool's heartbeat away.
  readonly stop: () => Promise<void>;
  // Settles when the pool has stopped, whatever stopped it.
  readonly done: Promise<void>;
}

// Dots are refused by the crontab parser and by the queue, so a task with one could
// never run. Better to fail at startup than to find out from an empty queue.
const TASK_NAME = /^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)+$/;

function checkedPlugins(plugins: Readonly<Record<string, Task>>): Readonly<Record<string, Task>> {
  for (const name of Object.keys(plugins)) {
    if (!TASK_NAME.test(name)) {
      throw new WorkerConfigError(`the task name ${name} must use colons, as in payout:advance`);
    }
  }
  return plugins;
}

export function buildTaskList(options: StartWorkerOptions): {
  readonly taskList: TaskList;
  readonly crontab: string;
  readonly tenantTasks: readonly TenantTask[];
} {
  const { handlers } = options;
  const deps: HandlerDeps = { db: options.db, alert: options.alert };
  const tenant = [
    ...(handlers.payoutAdvance === undefined
      ? []
      : [{ task: PAYOUT_ADVANCE, work: handlers.payoutAdvance }]),
    ...(handlers.batchAdvance === undefined
      ? []
      : [{ task: BATCH_ADVANCE, work: handlers.batchAdvance }]),
    ...(handlers.mandateReconcile === undefined
      ? []
      : [{ task: MANDATE_RECONCILE, work: handlers.mandateReconcile }]),
    ...(handlers.tenantTasks ?? []),
  ];
  const { indexerScans, ttlKeepAlive, submissionSweepers } = handlers;
  if (ttlKeepAlive !== undefined) {
    const { run: keepAlive } = ttlKeepAlive;
    tenant.push({
      task: TTL_KEEP_ALIVE,
      work: async (job) => keepAlive({ ...job.context, ...job.ids }),
    });
  }
  const taskList: Record<string, Task> = {
    ...checkedPlugins(handlers.plugins ?? {}),
    [SYSTEM_TASKS.unlockStale]: unlockStale(deps),
    ...Object.fromEntries(
      tenant.map(({ task, work }) => [task.name, tenantTask(task, work, deps)]),
    ),
  };
  // Every minute, so a killed pool's queue is back about three minutes after it died.
  const crontab = [`* * * * * ${SYSTEM_TASKS.unlockStale}`, ...(handlers.crontab ?? [])];
  if (handlers.mandateReconcile !== undefined) {
    taskList[SYSTEM_TASKS.reconcileSweep] = reconcileSweep(deps);
    crontab.push(`*/5 * * * * ${SYSTEM_TASKS.reconcileSweep}`);
  }
  if (submissionSweepers !== undefined) {
    taskList[SYSTEM_TASKS.submissionSweep] = submissionSweep(submissionSweepers);
    crontab.push(`* * * * * ${SYSTEM_TASKS.submissionSweep}`);
  }
  if (ttlKeepAlive !== undefined) {
    taskList[SYSTEM_TASKS.ttlSweep] = ttlSweep({
      db: options.db,
      networks: ttlKeepAlive.networks,
    });
    // Entries live for weeks, and each step is claimed per ledger window, so an
    // hourly look is plenty, and a missed one costs nothing.
    crontab.push(`0 * * * * ${SYSTEM_TASKS.ttlSweep}`);
  }
  if (indexerScans !== undefined) {
    taskList[SYSTEM_TASKS.indexerScan] = indexerScan(indexerScans);
    crontab.push(...indexerScans.map(({ network }) => indexerScanCron(network)));
  }
  return {
    taskList,
    crontab: crontab.join('\n'),
    tenantTasks: [...TENANT_TASKS, ...(handlers.tenantTasks ?? []).map(({ task }) => task)],
  };
}

// What a deployment is expected to run and this one has no handler for. A missing
// handler is not an error, because each lands with its own issue, but it must not be
// silent: an open submission that nothing sweeps never closes and never alerts.
export function unwiredTasks(handlers: WorkerHandlers): readonly string[] {
  const expected: readonly (readonly [string, boolean])[] = [
    [PAYOUT_ADVANCE.name, handlers.payoutAdvance !== undefined],
    [BATCH_ADVANCE.name, handlers.batchAdvance !== undefined],
    [MANDATE_RECONCILE.name, handlers.mandateReconcile !== undefined],
    [SYSTEM_TASKS.indexerScan, handlers.indexerScans !== undefined],
    [SYSTEM_TASKS.submissionSweep, handlers.submissionSweepers !== undefined],
    [TTL_KEEP_ALIVE.name, handlers.ttlKeepAlive !== undefined],
    ...[RELEASE_HELD, CANCEL_LAPSED, COMPLIANCE_RECHECK].map((task): readonly [string, boolean] => [
      task.name,
      handlers.tenantTasks?.some((wired) => wired.task.name === task.name) === true,
    ]),
    ...[SYSTEM_TASKS.releaseSweep, SYSTEM_TASKS.lapsedSweep, RECEIPT_ISSUE_TASK].map(
      (name): readonly [string, boolean] => [name, handlers.plugins?.[name] !== undefined],
    ),
  ];
  return expected.filter(([, wired]) => !wired).map(([name]) => name);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

export async function startWorker(options: StartWorkerOptions): Promise<RunningWorker> {
  const { db, alert } = options;
  const { taskList, crontab, tenantTasks } = buildTaskList(options);
  const events: WorkerEvents = new EventEmitter();
  const deps: HandlerDeps = { db, alert };
  const inFlight = new Set<Promise<void>>();
  const track = (operation: string, work: Promise<void>): void => {
    // A fault here cannot throw anywhere useful, since it runs from an event or a
    // timer, so it is told to whoever is watching.
    const tracked = work
      .catch((error: unknown) => {
        alert({ kind: 'worker_fault', operation, error: describe(error) });
      })
      .finally(() => {
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  };

  let poolId: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const beat = async (id: string): Promise<void> => {
    await db.unscoped(async (tx) => workerPools.beat(tx, id), 'worker');
  };
  events.on('pool:create', ({ workerPool }) => {
    const { id } = workerPool;
    poolId = id;
    track('heartbeat', beat(id));
    heartbeat = setInterval(() => {
      track('heartbeat', beat(id));
    }, HEARTBEAT_EVERY_MS);
    // A timer must not be what keeps a process alive after its pool has stopped.
    heartbeat.unref();
  });
  events.on('job:failed', ({ job, error }) => {
    track('dead_letter', onJobExhausted(deps, job, error, tenantTasks));
  });

  const runner = await run({
    pgPool: db.workerPool(),
    taskList,
    crontab: options.crontabEnabled === false ? '' : crontab,
    events,
    // The library's handler kills the process again once it has shut down, which
    // can be before this file has taken the heartbeat away. Whoever runs this owns
    // signals, and calls stop.
    noHandleSignals: true,
    preset: workerPreset(options.concurrency ?? DEFAULT_CONCURRENCY),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  let finished: Promise<void> | undefined;
  const finish = async (): Promise<void> => {
    clearInterval(heartbeat);
    await Promise.all(inFlight);
    if (poolId !== undefined) {
      const id = poolId;
      await db.unscoped(async (tx) => workerPools.forget(tx, id), 'worker');
    }
  };
  const done = runner.promise.finally(() => {
    finished ??= finish();
    return finished;
  });
  return {
    stop: async () => {
      await runner.stop('stop requested');
      await done;
    },
    done,
  };
}
