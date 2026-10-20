// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A real Postgres for tests. One container for the whole run, migrated once
// into a template database, and a fresh database per test file cloned from
// that template. Cloning is a file copy inside the server, so a file pays
// for the migrations once between them all rather than once each.
//
// Vitest runs test files in separate workers, so the container is started by
// a global setup and its address is handed to the workers through an
// environment variable. Each file asks for its own database by name.

import { createHash, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

// Pinned, and the same image the payouts spike already uses, so a run needs
// no new pull.
export const POSTGRES_IMAGE = 'postgres:17.6';

// The template every test database is cloned from.
export const TEMPLATE_DATABASE = 'ujira_template';

// The key the global setup publishes the admin URL under, read in a test
// file with vitest's `inject`.
export const ADMIN_URL_KEY = 'dbAdminUrl';

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

// Replaces the database in a URL, keeping host, port and credentials.
export function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
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

// Double quotes an identifier. Test database names are derived from a file
// path, so this is belt and braces rather than the only defence.
export function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `refused: an identifier of ${String(name.length)} characters is not a plain lower case name`,
    );
  }
  return `"${name}"`;
}

// A short, stable, valid database name for a test file. Postgres allows 63
// bytes, so a long path is hashed rather than truncated, which would make
// two files in the same folder collide.
export function databaseNameFor(testPath: string): string {
  const slug = testPath
    .replace(/^.*packages\//, '')
    .replace(/\.test\.ts$/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .slice(0, 36)
    .replace(/^_+|_+$/g, '');
  const digest = createHash('sha256').update(testPath).digest('hex').slice(0, 10);
  return `t_${slug}_${digest}`;
}

export interface TestDatabase {
  readonly url: string;
  readonly name: string;
  readonly drop: () => Promise<void>;
}

// A fresh database for one test file, cloned from the migrated template.
// The admin URL comes from the global setup through `inject`.
export async function createTestDatabase(
  adminUrl: string,
  testPath: string,
): Promise<TestDatabase> {
  if (adminUrl === '') {
    throw new Error(
      'the database tests need the global setup that starts the container; no admin URL was provided',
    );
  }
  const name = databaseNameFor(testPath);
  await withClient(adminUrl, async (client) => {
    await client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);
    await client.query(
      `create database ${quoteIdentifier(name)} template ${quoteIdentifier(TEMPLATE_DATABASE)}`,
    );
  });
  return {
    name,
    url: withDatabase(adminUrl, name),
    drop: async () => {
      await withClient(adminUrl, async (client) => {
        await client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);
      });
    },
  };
}

// A unique suffix for rows a test invents, so two tests in one file cannot
// collide on a natural key.
export function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}
