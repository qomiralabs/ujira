// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The Postgres harness for another package's tests, as the entry
// @ujira/db/testing. Tests elsewhere cannot import the driver, so what they get
// here is URLs and rows. It points at source and is never built: nothing in
// production can reach it.
//
// Such a package names src/testing/global-setup.ts as its global setup, in the
// root vitest config, and each of its test files asks for a database of its own.

import pg from 'pg';
import { inject } from 'vitest';

// Brings the type of what the global setup provides into the importer's program.
import type {} from './global-setup.js';
import { createTestDatabase, roleUrl, type LoginRole, type TestDatabase } from './harness.js';
import { queuedJobs, type QueuedJob } from './jobs-fixture.js';

export type { LoginRole, QueuedJob, TestDatabase };

export interface HarnessDatabase {
  readonly database: TestDatabase;
  readonly loginUrl: (role: LoginRole) => string;
}

export async function harnessDatabase(testPath: string): Promise<HarnessDatabase> {
  const database = await createTestDatabase(inject('dbAdminUrl'), testPath);
  const urls = inject('dbRoleUrls');
  return { database, loginUrl: (role) => roleUrl(urls, role, database.name) };
}

// As the superuser, which row level security never applies to: for what a test
// has to arrange or inspect from outside.
export async function adminQuery<R extends pg.QueryResultRow>(
  url: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly R[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<R>(text, [...values])).rows;
  } finally {
    await client.end();
  }
}

export async function jobsIn(url: string): Promise<readonly QueuedJob[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await queuedJobs(client);
  } finally {
    await client.end();
  }
}
