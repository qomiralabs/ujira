// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { DatabaseConfigError } from '@ujira/db';
import { adminQuery, harnessDatabase, jobsIn, type HarnessDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkerConfigError } from './errors.js';
import type { WorkerAlert } from './handlers.js';
import {
  describeRefusal,
  processLogger,
  startWorkerProcess,
  writeAlert,
  type WorkerEnvironment,
} from './process.js';
import { WORKER_SCHEMA_REVISION } from './settings.js';
import { enqueueTask, type TenantTask } from './tasks.js';
import { newTenant, quiet, until, workerHarness, type WorkerHarness } from './testing/support.js';

const HEARTBEATS = 'select worker_id from ujira_jobs.worker_heartbeats';

function envFor(harness: HarnessDatabase): WorkerEnvironment {
  return {
    UJIRA_DB_APP_URL: harness.loginUrl('ujira_app'),
    UJIRA_DB_READER_URL: harness.loginUrl('ujira_reader'),
    UJIRA_DB_WORKER_URL: harness.loginUrl('ujira_worker'),
    UJIRA_DB_MIGRATION_URL: harness.database.url,
    UJIRA_DB_TLS: 'off',
  };
}

let harness: WorkerHarness;
let env: WorkerEnvironment;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  env = envFor(harness);
});

afterAll(async () => {
  await harness.close();
});

describe('starting', () => {
  it('runs on the real logins, beats, and takes its heartbeat away when it stops', async () => {
    const worker = await startWorkerProcess(env, { logger: quiet });
    try {
      await until(
        'the first beat',
        async () => (await adminQuery(harness.database.url, HEARTBEATS)).length === 1,
      );
    } finally {
      await worker.stop();
    }
    expect(await adminQuery(harness.database.url, HEARTBEATS)).toEqual([]);
  });

  it('says at startup which expected tasks have no handler', async () => {
    const lines: Readonly<Record<string, unknown>>[] = [];
    const worker = await startWorkerProcess(env, {
      logger: quiet,
      write: (line) => lines.push(line),
    });
    await worker.stop();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'worker_unwired', level: 'warning' });
    expect(lines[0]?.['tasks']).toContain('submissions:reconcile');
    expect(lines[0]?.['tasks']).toContain('ttl:keep_alive');
  });

  it('a stop mid-job finishes the job and keeps its completion', async () => {
    const SLOW: TenantTask = {
      name: 'test:stopping',
      ids: [],
      jobKey: () => 'stopping',
      queueName: () => 'mandate:stopping',
    };
    const tenant = await newTenant(harness.db);
    await harness.db.tenant(tenant).transaction(async (tx) => enqueueTask(tx, SLOW, {}));
    let started = false;
    let finished = false;
    const worker = await startWorkerProcess(env, {
      logger: quiet,
      handlers: {
        tenantTasks: [
          {
            task: SLOW,
            work: async () => {
              started = true;
              await sleep(1_000);
              finished = true;
            },
          },
        ],
      },
    });
    await until('the job to start', () => Promise.resolve(started));
    await worker.stop();
    expect(finished).toBe(true);
    expect(await jobsIn(harness.database.url)).toEqual([]);
  });
});

describe('refusing to start', () => {
  it.each([
    ['zero', '0'],
    ['a word', 'lots'],
    ['a fraction', '1.5'],
    ['too many', '1000'],
  ])('a concurrency of %s', async (_name, value) => {
    await expect(
      startWorkerProcess({ ...env, UJIRA_WORKER_CONCURRENCY: value }),
    ).rejects.toBeInstanceOf(WorkerConfigError);
  });

  it('a concurrency that leaves no connection for the listener', async () => {
    await expect(
      startWorkerProcess({ ...env, UJIRA_WORKER_CONCURRENCY: '4', UJIRA_DB_WORKER_POOL_SIZE: '4' }),
    ).rejects.toThrow(/no connection for the queue's listener/);
  });

  it('a missing URL', async () => {
    await expect(
      startWorkerProcess({ ...env, UJIRA_DB_APP_URL: undefined }),
    ).rejects.toBeInstanceOf(DatabaseConfigError);
  });

  it('a transaction pooler URL for the worker, which delivers no notifications', async () => {
    await expect(
      startWorkerProcess({
        ...env,
        UJIRA_DB_WORKER_URL: 'postgresql://ujira_worker:secret@localhost:6543/db',
      }),
    ).rejects.toBeInstanceOf(DatabaseConfigError);
  });

  it('a worker URL on another login', async () => {
    await expect(
      startWorkerProcess({ ...env, UJIRA_DB_WORKER_URL: harness.loginUrl('ujira_indexer') }),
    ).rejects.toThrow('UJIRA_DB_WORKER_URL must log in as ujira_worker');
  });

  it('an app URL on another login', async () => {
    await expect(
      startWorkerProcess({ ...env, UJIRA_DB_APP_URL: harness.loginUrl('ujira_reader') }),
    ).rejects.toThrow('UJIRA_DB_APP_URL must log in as ujira_app');
  });

  describe('on a database of its own', () => {
    async function withClone(
      name: string,
      arrange: string,
      check: (clone: HarnessDatabase) => Promise<void>,
    ): Promise<void> {
      const clone = await harnessDatabase(`${import.meta.url}#${name}`);
      try {
        await adminQuery(clone.database.url, arrange);
        await check(clone);
      } finally {
        await clone.database.drop();
      }
    }

    it('a worker login that can reach tenant data', async () => {
      await withClone('reach', 'grant usage on schema ujira to ujira_worker', async (clone) => {
        await expect(startWorkerProcess(envFor(clone))).rejects.toThrow(
          'ujira_worker must hold no privilege on schema ujira',
        );
      });
    });

    it('a queue schema that was never installed', async () => {
      await withClone(
        'missing',
        `drop schema graphile_worker cascade; create schema graphile_worker authorization ujira_worker`,
        async (clone) => {
          await expect(startWorkerProcess(envFor(clone))).rejects.toThrow(
            /revision none .* run the worker install step first/,
          );
        },
      );
    });

    it('a queue schema behind the pinned version', async () => {
      await withClone(
        'behind',
        `delete from graphile_worker.migrations where id = (select max(id) from graphile_worker.migrations)`,
        async (clone) => {
          await expect(startWorkerProcess(envFor(clone))).rejects.toThrow(
            `revision ${String(WORKER_SCHEMA_REVISION - 1)} and this worker needs ${String(WORKER_SCHEMA_REVISION)}`,
          );
        },
      );
    });
  });

  it('the pinned revision is what the pinned library installs', async () => {
    const rows = await adminQuery<{ revision: number }>(
      harness.database.url,
      'select max(id)::int as revision from graphile_worker.migrations',
    );
    expect(rows).toEqual([{ revision: WORKER_SCHEMA_REVISION }]);
  });
});

describe('what it writes', () => {
  it('a refusal it wrote itself is quoted, and anything else is known by name', () => {
    expect(describeRefusal(new WorkerConfigError('a reason'))).toBe('a reason');
    expect(describeRefusal(new Error('postgresql://u:secret@host/db'))).toBe('Error');
    expect(describeRefusal('text')).toBe('unknown error');
  });

  it('an alert is one line of ids and codes', () => {
    const lines: Record<string, unknown>[] = [];
    const alert: WorkerAlert = { kind: 'job_exhausted', task: 'payout:advance', jobId: '7' };
    writeAlert(alert, (line) => lines.push({ ...line }));
    expect(lines[0]).toMatchObject({ level: 'error', event: 'worker_alert', ...alert });
  });

  it('a library error says which job and never what the error said', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = processLogger((line) => lines.push({ ...line }));
    const scoped = logger.scope({ taskIdentifier: 'payout:advance', jobId: '9' });
    scoped.error('Failed with error a@example.com');
    scoped.info('started');
    scoped.debug('noise');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'error', task: 'payout:advance', jobId: '9' });
    expect(JSON.stringify(lines[0])).not.toContain('example.com');
    expect(lines[1]).toMatchObject({ level: 'info', message: 'started' });
  });
});

// The built process, as a deployment runs it. CI builds before it tests, and a local
// run needs `pnpm --filter @ujira/payouts build` first.
describe('the built process', () => {
  const MAIN = fileURLToPath(new URL('../../dist/worker/main.js', import.meta.url));

  function run(environment: WorkerEnvironment) {
    const child = spawn(process.execPath, [MAIN], {
      env: { PATH: process.env['PATH'], ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exit = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => {
        resolve(code);
      });
    });
    return { child, exit, output: () => output };
  }

  it('is built', () => {
    expect(existsSync(MAIN)).toBe(true);
  });

  it('runs until a signal, then stops cleanly', async () => {
    const worker = run(env);
    try {
      await until(
        'the process to beat',
        async () => (await adminQuery(harness.database.url, HEARTBEATS)).length === 1,
      );
      worker.child.kill('SIGTERM');
      expect(await worker.exit).toBe(0);
    } finally {
      worker.child.kill('SIGKILL');
    }
    expect(await adminQuery(harness.database.url, HEARTBEATS)).toEqual([]);
  });

  it('exits non-zero on bad configuration, with no secret in what it prints', async () => {
    const worker = run({ ...env, UJIRA_DB_APP_URL: undefined });
    expect(await worker.exit).toBe(1);
    expect(worker.output()).toContain('UJIRA_DB_APP_URL is required');
    const password = new URL(harness.loginUrl('ujira_worker')).password;
    expect(password).not.toBe('');
    expect(worker.output()).not.toContain(password);
  });

  it('exits non-zero on the wrong login, with no secret in what it prints', async () => {
    const wrong = harness.loginUrl('ujira_indexer');
    const worker = run({ ...env, UJIRA_DB_WORKER_URL: wrong });
    expect(await worker.exit).toBe(1);
    expect(worker.output()).toContain('must log in as ujira_worker');
    expect(worker.output()).not.toContain(new URL(wrong).password);
  });
});
