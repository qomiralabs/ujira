// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What is kept and for how long, run as the retention login itself.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabase, type Database } from './database.js';
import { securityEvents } from './repositories/ops.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let retention: Database;

async function eventsAged(ages: readonly string[]): Promise<void> {
  for (const age of ages) {
    await admin.query(
      `insert into ops.security_events (kind, token_prefix, occurred_at)
       values ('token_invalid', $1, now() - $2::interval)`,
      [`ujk_test_${age.replace(/[^a-z0-9]/g, '')}`, age],
    );
  }
}

async function remaining(): Promise<string[]> {
  const found = await admin.query<{ prefix: string }>(
    'select token_prefix as prefix from ops.security_events order by occurred_at desc',
  );
  return found.rows.map((row) => row.prefix);
}

async function deleteExpired(batchSize: number): Promise<number> {
  return retention.unscoped(async (tx) => securityEvents.deleteExpired(tx, batchSize), 'worker');
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  // The pool that logs in as the retention role, which has none of its own yet.
  retention = createDatabase(
    loadDatabaseConfig({
      UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
      UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
      UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_retention', database.name),
      UJIRA_DB_INDEXER_URL: roleUrl(roleUrls, 'ujira_indexer', database.name),
      UJIRA_DB_MIGRATION_URL: database.url,
      UJIRA_DB_TLS: 'off',
    }),
  );
});

beforeEach(async () => {
  await admin.query('delete from ops.security_events');
});

afterAll(async () => {
  await retention.close();
  await admin.end();
  await database.drop();
});

describe('security events', () => {
  it('security events older than 90 days are deleted', async () => {
    await eventsAged(['91 days', '200 days', '89 days', '1 hour']);
    expect(await deleteExpired(1000)).toBe(2);
    expect(await remaining()).toEqual(['ujk_test_1hour', 'ujk_test_89days']);
  });

  it('keeps an event just inside the 90 days', async () => {
    await eventsAged(['89 days 23 hours']);
    expect(await deleteExpired(1000)).toBe(0);
    expect(await remaining()).toHaveLength(1);
  });

  it('removes one batch at a time, oldest first, so a job can loop', async () => {
    await eventsAged(['100 days', '300 days', '200 days']);
    expect(await deleteExpired(2)).toBe(2);
    expect(await remaining()).toEqual(['ujk_test_100days']);
    expect(await deleteExpired(2)).toBe(1);
    expect(await deleteExpired(2)).toBe(0);
  });

  it.each([0, -1, 10_001])('refuses a batch of %i', async (batchSize) => {
    await expect(deleteExpired(batchSize)).rejects.toMatchObject({ code: '22023' });
  });

  it('the retention role can do this and nothing else with the table', async () => {
    await eventsAged(['1 hour']);
    const client = new pg.Client({
      connectionString: roleUrl(roleUrls, 'ujira_retention', database.name),
    });
    await client.connect();
    try {
      await expect(client.query('delete from ops.security_events')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.end();
    }
    expect(await remaining()).toHaveLength(1);
  });
});
