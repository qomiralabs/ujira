// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the worker's tests share: the real logins, a tenant with a deployed mandate,
// and a real pool in a child process.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  createDatabase,
  entryPoints,
  loadDatabaseConfig,
  mandateInstances,
  mandates,
  type Database,
  type ProjectContext,
} from '@ujira/db';
import { harnessDatabase, type HarnessDatabase } from '@ujira/db/testing';
import { Logger, type JobHelpers } from 'graphile-worker';

import { WORKER_SETTINGS } from '../settings.js';

export const quiet = new Logger(() => () => undefined);

export interface WorkerHarness extends HarnessDatabase {
  // The app login for handlers, the worker login for the queue, as in production.
  readonly db: Database;
  readonly close: () => Promise<void>;
}

export async function workerHarness(testPath: string): Promise<WorkerHarness> {
  const harness = await harnessDatabase(testPath);
  const db = createDatabase(
    loadDatabaseConfig({
      UJIRA_DB_APP_URL: harness.loginUrl('ujira_app'),
      UJIRA_DB_READER_URL: harness.loginUrl('ujira_reader'),
      UJIRA_DB_WORKER_URL: harness.loginUrl('ujira_worker'),
      UJIRA_DB_MIGRATION_URL: harness.database.url,
      UJIRA_DB_TLS: 'off',
    }),
  );
  return {
    ...harness,
    db,
    close: async () => {
      await db.close();
      await harness.database.drop();
    },
  };
}

export async function newTenant(db: Database): Promise<ProjectContext> {
  return db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
}

export async function newInstance(db: Database, tenant: ProjectContext): Promise<string> {
  return db.tenant(tenant).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: 'Payroll' });
    const instance = await mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
    return instance.id;
  });
}

// Waits for something a pool does on its own time, and fails rather than hangs.
export async function until(
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// Just what a handler reads from the library's helpers, for calling one directly.
export function helpersFor(
  jobId: string,
  signal: AbortSignal = new AbortController().signal,
): JobHelpers {
  return { abortSignal: signal, job: { id: jobId } } as unknown as JobHelpers;
}

export interface PoolProcess {
  readonly child: ChildProcess;
  // Resolves when the pool has printed this line.
  readonly printed: (line: string) => Promise<void>;
  readonly poolId: () => Promise<string>;
  // Resolves when the process has gone.
  readonly exited: Promise<void>;
}

export function startPoolProcess(connectionString: string, mode: 'finish' | 'hang'): PoolProcess {
  const script = fileURLToPath(new URL('./pool-process.ts', import.meta.url));
  const child = spawn(
    process.execPath,
    [script, connectionString, JSON.stringify(WORKER_SETTINGS), mode],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  let gone = false;
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => {
      gone = true;
      resolve();
    });
  });
  const printed = async (line: string): Promise<void> => {
    await until(`the pool to print ${line}`, () => {
      if (gone && !output.split('\n').some((seen) => seen.startsWith(line))) {
        throw new Error(`the pool exited before printing ${line}: ${errors.slice(-400)}`);
      }
      return Promise.resolve(output.split('\n').some((seen) => seen.startsWith(line)));
    });
  };
  return {
    child,
    printed,
    exited,
    poolId: async () => {
      await printed('pool ');
      const line = output.split('\n').find((seen) => seen.startsWith('pool '));
      if (line === undefined) throw new Error('the pool printed no id');
      return line.slice('pool '.length);
    },
  };
}
