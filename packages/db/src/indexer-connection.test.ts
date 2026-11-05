// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The indexer writes the mirror of what happened on chain under a tenant
// context, as ujira_indexer. It has its own pool and login, so the worker's
// login, which holds no rights on tenant tables, never has to stand in for it.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;

const currentUser = sql<{ name: string }>`select current_user as name`;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the indexer connection', () => {
  it('logs in as ujira_indexer', async () => {
    const result = await db.unscoped(async (tx) => currentUser.execute(tx), 'indexer');
    expect(result.rows[0]?.name).toBe('ujira_indexer');
  });

  it('opens a tenant transaction as ujira_indexer', async () => {
    const context = { principalId: randomUUID(), projectId: randomUUID(), scope: 'project' };
    const result = await db.withTenant('indexer', context as never, async (tx) =>
      currentUser.execute(tx),
    );
    expect(result.rows[0]?.name).toBe('ujira_indexer');
  });

  it('is not the login the worker pool uses', async () => {
    const result = await db.unscoped(async (tx) => currentUser.execute(tx), 'worker');
    expect(result.rows[0]?.name).not.toBe('ujira_indexer');
  });
});
