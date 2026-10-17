// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Throwaway harness for the Graphile Worker spike. It talks to Postgres with
// pg directly because the db package does not exist yet; the shipped code
// reaches the queue only through the repository's enqueue.

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { run, runMigrations, type Runner, type TaskList } from 'graphile-worker';
import pg from 'pg';
import { z } from 'zod';

export const POSTGRES_IMAGE = 'postgres:17.6';
const SQL_DIR = join(import.meta.dirname, 'sql');
const ROLES = ['ujira_migrator', 'ujira_app', 'ujira_worker'] as const;
type LoginRole = (typeof ROLES)[number];

export interface Tenant {
  readonly principalId: string;
  readonly projectId: string;
}

export const TENANT_A: Tenant = {
  principalId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
};
export const TENANT_B: Tenant = {
  principalId: '33333333-3333-4333-8333-333333333333',
  projectId: '44444444-4444-4444-8444-444444444444',
};

// Jobs carry ids only. The tenant is re-validated before a handler opens a
// tenant transaction, so a hand edited job row cannot widen access.
export const jobPayload = z
  .object({ principalId: z.uuid(), projectId: z.uuid() })
  .catchall(z.string().max(200));
export type JobPayload = z.infer<typeof jobPayload>;

export interface SpikeDb {
  readonly container: StartedPostgreSqlContainer;
  url(role: LoginRole | 'admin', database?: string): string;
  close(): Promise<void>;
}

async function sql(name: string): Promise<string> {
  return readFile(join(SQL_DIR, name), 'utf8');
}

async function exec(connectionString: string, text: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

/** Starts Postgres, creates the roles, and runs every deploy step in order. */
export async function startSpikeDb(): Promise<SpikeDb> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const passwords = new Map<LoginRole, string>(
    ROLES.map((role) => [role, randomBytes(18).toString('base64url')]),
  );
  const base = new URL(container.getConnectionUri());
  const url = (role: LoginRole | 'admin', database = 'ujira'): string => {
    const u = new URL(base);
    if (role !== 'admin') {
      u.username = role;
      u.password = passwordOf(role);
    }
    u.pathname = `/${database}`;
    return u.toString();
  };
  const passwordOf = (role: LoginRole): string => {
    const value = passwords.get(role);
    if (value === undefined) throw new Error(`no password for ${role}`);
    return value;
  };

  const admin = new pg.Client({ connectionString: url('admin', base.pathname.slice(1)) });
  await admin.connect();
  try {
    await admin.query('create role ujira_owner nologin');
    const lit = (role: LoginRole): string => admin.escapeLiteral(passwordOf(role));
    await admin.query(
      `create role ujira_migrator login password ${lit('ujira_migrator')} in role ujira_owner`,
    );
    await admin.query(`create role ujira_app login nobypassrls password ${lit('ujira_app')}`);
    await admin.query(`create role ujira_worker login nobypassrls password ${lit('ujira_worker')}`);
    await admin.query('create database ujira');
  } finally {
    await admin.end();
  }

  await exec(url('admin'), await sql('01-bootstrap.sql'));
  await exec(url('ujira_migrator'), await sql('02-app-schema.sql'));
  // The deploy step. Same code path as `graphile-worker --schema-only`.
  await runMigrations({ connectionString: url('ujira_worker') });
  await exec(url('ujira_worker'), await sql('03-enqueue.sql'));

  return {
    container,
    url,
    close: async () => {
      await container.stop();
    },
  };
}

/** Opens a transaction scoped to one project, the way the repository will. */
export async function tenantTx<T>(
  pool: pg.Pool,
  tenant: Tenant,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      "select set_config('ujira.principal_id', $1, true), set_config('ujira.project_id', $2, true)",
      [tenant.principalId, tenant.projectId],
    );
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export interface EnqueueOptions {
  readonly jobKey?: string;
  readonly queue?: string;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
}

export async function enqueue(
  client: pg.PoolClient,
  task: string,
  ids: Readonly<Record<string, string>>,
  options: EnqueueOptions = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    'select ujira_jobs.enqueue($1, $2::jsonb, $3, $4, $5, $6)::text as id',
    [
      task,
      JSON.stringify(ids),
      options.jobKey ?? null,
      options.queue ?? null,
      options.runAt ?? null,
      options.maxAttempts ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('enqueue returned no job');
  return row.id;
}

/**
 * Starts a worker pool as ujira_worker. Completions are batched on purpose:
 * in 0.18.0 the unbatched path does not wait for the completion write, so a
 * job that finishes during shutdown stays locked for four hours.
 */
export async function startWorker(
  db: SpikeDb,
  taskList: TaskList,
  concurrency = 4,
  database = 'ujira',
): Promise<Runner> {
  return run({
    connectionString: db.url('ujira_worker', database),
    concurrency,
    noHandleSignals: true,
    pollInterval: 100,
    preset: { worker: { completeJobBatchDelay: 0, failJobBatchDelay: 0 } },
    taskList,
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until the check passes or the deadline is reached. */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15000,
  what: () => string = () => 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what()}`);
    }
    await sleep(25);
  }
}
