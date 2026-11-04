// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Starting the container and migrating the template. This is the only part
// of the harness that runs in the vitest global setup, in the main process,
// where the workers' coverage instrumentation cannot see it. It lives in its
// own file so the rest of the harness, which runs in the workers and is
// measured, is not excluded along with it.

import { randomBytes } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Logger, runMigrations as installWorkerSchema } from 'graphile-worker';
import pg from 'pg';

import {
  LOGIN_ROLES,
  PLATFORM_ROLES,
  TEMPLATE_DATABASE,
  quoteIdentifier,
  withDatabase,
} from './harness.js';
import { POSTGRES_IMAGE } from './image.js';

export interface StartedHarness {
  readonly adminUrl: string;
  // A login URL per role, pointing at the server's default database.
  readonly roleUrls: Readonly<Record<string, string>>;
  readonly stop: () => Promise<void>;
}

function adminUrlOf(container: StartedPostgreSqlContainer, database: string): string {
  const url = new URL('postgresql://host/db');
  url.hostname = container.getHost();
  url.port = String(container.getMappedPort(5432));
  url.username = container.getUsername();
  url.password = container.getPassword();
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// Starts the container and builds the template. Called once per run.
export async function startHarness(
  migrate: (url: string) => Promise<void>,
): Promise<StartedHarness> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const adminUrl = adminUrlOf(container, container.getDatabase());
  await withClient(adminUrl, async (client) => {
    await client.query(`create database ${quoteIdentifier(TEMPLATE_DATABASE)}`);
    // Supabase's API roles exist on the real server before any migration
    // runs, so they exist here too, and the grants test can show that the
    // migrations give them nothing.
    for (const role of PLATFORM_ROLES) {
      await client.query(`create role ${quoteIdentifier(role)} nologin`);
    }
  });
  await migrate(withDatabase(adminUrl, TEMPLATE_DATABASE));
  // The migrations create the login roles without passwords; production sets
  // them from the secret manager. Here each gets a random one for this run,
  // which never leaves the process.
  const roleUrls: Record<string, string> = {};
  await withClient(adminUrl, async (client) => {
    for (const role of LOGIN_ROLES) {
      const password = randomBytes(24).toString('hex');
      await client.query(`alter role ${quoteIdentifier(role)} login password '${password}'`);
      const url = new URL(adminUrl);
      url.username = role;
      url.password = password;
      roleUrls[role] = url.toString();
    }
  });
  // The deploy step installs the worker schema as the role that owns it, after
  // the migrations, so every test database starts from what production runs.
  const workerUrl = roleUrls['ujira_worker'];
  if (workerUrl === undefined) throw new Error('the migrations created no ujira_worker login');
  await installWorkerSchema({
    connectionString: withDatabase(workerUrl, TEMPLATE_DATABASE),
    logger: new Logger(() => () => undefined),
  });
  // A template cannot be cloned while anything is connected to it, and
  // nothing should write to it after this point either.
  await withClient(adminUrl, async (client) => {
    await client.query(
      `alter database ${quoteIdentifier(TEMPLATE_DATABASE)} with is_template true allow_connections false`,
    );
  });
  return {
    adminUrl,
    roleUrls,
    stop: async () => {
      await container.stop();
    },
  };
}
