// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Starting the container and migrating the template. This is the only part
// of the harness that runs in the vitest global setup, in the main process,
// where the workers' coverage instrumentation cannot see it. It lives in its
// own file so the rest of the harness, which runs in the workers and is
// measured, is not excluded along with it.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { TEMPLATE_DATABASE, quoteIdentifier, withDatabase } from './harness.js';
import { POSTGRES_IMAGE } from './image.js';

export interface StartedHarness {
  readonly adminUrl: string;
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
  });
  await migrate(withDatabase(adminUrl, TEMPLATE_DATABASE));
  // A template cannot be cloned while anything is connected to it, and
  // nothing should write to it after this point either.
  await withClient(adminUrl, async (client) => {
    await client.query(
      `alter database ${quoteIdentifier(TEMPLATE_DATABASE)} with is_template true allow_connections false`,
    );
  });
  return {
    adminUrl,
    stop: async () => {
      await container.stop();
    },
  };
}
