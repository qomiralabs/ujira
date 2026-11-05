// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The worker as a process: the environment, the real pools and startWorker, with
// every check that can stop a bad deployment made before a single job is claimed.
//
// A misconfigured worker fails quietly otherwise. On the wrong login, a pool would
// run queue queries it should not be able to, or handlers would see no rows. On a
// schema that is missing or old, it would try to install or upgrade the queue itself,
// which is the deploy step's job.

import {
  createDatabase,
  DatabaseConfigError,
  DatabaseUnavailableError,
  loadDatabaseConfig,
  workerPools,
  type Database,
  type DatabaseEnvironment,
} from '@ujira/db';
import { Logger } from 'graphile-worker';
import { z } from 'zod';

import { WorkerConfigError } from './errors.js';
import type { WorkerAlert } from './handlers.js';
import { DEFAULT_CONCURRENCY, WORKER_SCHEMA_REVISION } from './settings.js';
import { startWorker, unwiredTasks, type RunningWorker, type WorkerHandlers } from './start.js';

export interface WorkerEnvironment extends DatabaseEnvironment {
  readonly UJIRA_WORKER_CONCURRENCY?: string | undefined;
}

const CONCURRENCY = z
  .string()
  .regex(/^[1-9][0-9]{0,2}$/)
  .transform(Number);

function readConcurrency(env: WorkerEnvironment): number {
  const raw = env.UJIRA_WORKER_CONCURRENCY;
  if (raw === undefined) return DEFAULT_CONCURRENCY;
  const parsed = CONCURRENCY.safeParse(raw);
  if (!parsed.success) {
    throw new WorkerConfigError('UJIRA_WORKER_CONCURRENCY must be a whole number from 1 to 999');
  }
  return parsed.data;
}

// A line per event, on stdout, with ids and codes only. Nothing else leaves here.
export function writeAlert(alert: WorkerAlert, write = writeLine): void {
  write({ time: new Date().toISOString(), level: 'error', event: 'worker_alert', ...alert });
}

// Said at every start, so a deployment missing a handler cannot pass for a whole one.
export function writeUnwired(tasks: readonly string[], write = writeLine): void {
  if (tasks.length === 0) return;
  write({ time: new Date().toISOString(), level: 'warning', event: 'worker_unwired', tasks });
}

function writeLine(line: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// The library's messages can quote an error, and an error can quote a row. Its error
// lines therefore say which job and no more, and the job row keeps the detail.
export function processLogger(write = writeLine): Logger {
  return new Logger((scope) => (level, message) => {
    if (level === 'debug') return;
    write({
      time: new Date().toISOString(),
      level,
      event: 'worker',
      ...(scope.taskIdentifier === undefined ? {} : { task: scope.taskIdentifier }),
      ...(scope.jobId === undefined ? {} : { jobId: scope.jobId }),
      ...(level === 'error' ? {} : { message }),
    });
  });
}

// Checked against the database, because a URL says nothing true about who it logs
// in as or what that login can reach.
async function refuseBadDeployment(db: Database): Promise<void> {
  const appLogin = await db.unscoped(async (tx) => workerPools.login(tx));
  if (appLogin !== 'ujira_app') {
    throw new WorkerConfigError('UJIRA_DB_APP_URL must log in as ujira_app');
  }
  const workerLogin = await db.unscoped(async (tx) => workerPools.login(tx), 'worker');
  if (workerLogin !== 'ujira_worker') {
    throw new WorkerConfigError('UJIRA_DB_WORKER_URL must log in as ujira_worker');
  }
  const queue = await db.unscoped(async (tx) => workerPools.queueState(tx), 'worker');
  if (queue.reachesTenantData) {
    throw new WorkerConfigError('ujira_worker must hold no privilege on schema ujira');
  }
  if (queue.schemaRevision !== WORKER_SCHEMA_REVISION) {
    throw new WorkerConfigError(
      `the queue schema is at revision ${String(queue.schemaRevision ?? 'none')} and this worker needs ${String(WORKER_SCHEMA_REVISION)}: run the worker install step first`,
    );
  }
}

export interface WorkerProcessOptions {
  readonly handlers?: WorkerHandlers;
  readonly alert?: (alert: WorkerAlert) => void;
  readonly logger?: Logger;
  // Where the startup report goes. Stdout unless a test is reading it.
  readonly write?: (line: Readonly<Record<string, unknown>>) => void;
}

export async function startWorkerProcess(
  env: WorkerEnvironment,
  options: WorkerProcessOptions = {},
): Promise<RunningWorker> {
  const concurrency = readConcurrency(env);
  const config = loadDatabaseConfig(env);
  // The queue's listener holds a connection for as long as the pool runs.
  if (concurrency >= config.worker.poolSize) {
    throw new WorkerConfigError(
      `a concurrency of ${String(concurrency)} leaves no connection for the queue's listener in a worker pool of ${String(config.worker.poolSize)}`,
    );
  }
  const db = createDatabase(config);
  let worker: RunningWorker;
  try {
    await refuseBadDeployment(db);
    const handlers = options.handlers ?? {};
    writeUnwired(unwiredTasks(handlers), options.write);
    worker = await startWorker({
      db,
      concurrency,
      handlers,
      alert: options.alert ?? writeAlert,
      logger: options.logger ?? processLogger(),
    });
  } catch (error) {
    await db.close();
    throw error;
  }
  const done = worker.done.finally(() => db.close());
  return {
    done,
    stop: async () => {
      await worker.stop();
      await done;
    },
  };
}

// What a refusal may print. Only these are written to be read: their messages never
// quote a URL. Anything else could, so it is known by name alone.
export function describeRefusal(error: unknown): string {
  if (
    error instanceof WorkerConfigError ||
    error instanceof DatabaseConfigError ||
    error instanceof DatabaseUnavailableError
  ) {
    return error.message;
  }
  return error instanceof Error ? error.name : 'unknown error';
}
