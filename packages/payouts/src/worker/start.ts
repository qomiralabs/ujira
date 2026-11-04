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
import { run, type Logger, type Task, type TaskList, type WorkerEvents } from 'graphile-worker';

import { reconcileSweep, unlockStale } from './crons.js';
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
  MANDATE_RECONCILE,
  PAYOUT_ADVANCE,
  SYSTEM_TASKS,
  TENANT_TASKS,
  type TenantTask,
} from './tasks.js';

export interface WorkerHandlers {
  readonly payoutAdvance?: TenantWork;
  readonly batchAdvance?: TenantWork;
  readonly mandateReconcile?: TenantWork;
  readonly indexerScan?: (signal: AbortSignal) => Promise<void>;
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
  const { indexerScan } = handlers;
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
  if (indexerScan !== undefined) {
    taskList[SYSTEM_TASKS.indexerScan] = async (_payload, helpers) => {
      await indexerScan(helpers.abortSignal);
    };
    crontab.push(`* * * * * ${SYSTEM_TASKS.indexerScan}`);
  }
  return {
    taskList,
    crontab: crontab.join('\n'),
    tenantTasks: [...TENANT_TASKS, ...(handlers.tenantTasks ?? []).map(({ task }) => task)],
  };
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
