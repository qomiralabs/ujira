// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The part of the test harness that runs inside the test workers: naming a
// database, cloning one from the migrated template and dropping it again.
// Starting the container lives in container.ts, because only that runs in
// the global setup where coverage cannot see it.
//
// Cloning is a file copy inside the server, so a file pays for the
// migrations once between them all rather than once each.
//
// Vitest runs test files in separate workers, so the container is started by
// a global setup and its address is handed to the workers by the test
// runner. Each file asks for its own database by name.

import { createHash } from 'node:crypto';

import pg from 'pg';

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

// The template every test database is cloned from.
export const TEMPLATE_DATABASE = 'ujira_template';

// The key the global setup publishes the admin URL under, read in a test
// file with vitest's `inject`.
export const ADMIN_URL_KEY = 'dbAdminUrl';

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
