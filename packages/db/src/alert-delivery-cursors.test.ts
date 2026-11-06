// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where the delivery of mandate alerts has reached. It reads and moves through two
// functions only the indexer's login may call, and it never moves back.

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { alertDeliveryCursors } from './repositories/ops.js';
import type { Schema } from './schema.generated.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// The indexer's login, which the two functions are granted to.
function asIndexer<T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> {
  return db.unscoped(work, 'indexer');
}

describe('alert delivery cursors', () => {
  it('start at zero, and are kept per sink', async () => {
    expect(await asIndexer(async (tx) => alertDeliveryCursors.read(tx, 'first_sink'))).toBe(0n);
    await asIndexer(async (tx) => alertDeliveryCursors.advance(tx, 'first_sink', 5n));
    expect(await asIndexer(async (tx) => alertDeliveryCursors.read(tx, 'first_sink'))).toBe(5n);
    expect(await asIndexer(async (tx) => alertDeliveryCursors.read(tx, 'second_sink'))).toBe(0n);
  });

  it('never move back, so a late or repeated delivery cannot tell operations again', async () => {
    await asIndexer(async (tx) => alertDeliveryCursors.advance(tx, 'forward_sink', 9n));
    await asIndexer(async (tx) => alertDeliveryCursors.advance(tx, 'forward_sink', 4n));
    expect(await asIndexer(async (tx) => alertDeliveryCursors.read(tx, 'forward_sink'))).toBe(9n);
  });

  it('refuse a sink name that is not a plain name', async () => {
    expect(
      await codeOf(asIndexer(async (tx) => alertDeliveryCursors.advance(tx, 'Not A Name', 1n))),
    ).toBe('23514');
  });

  it("are out of the app's reach, through the functions or the table", async () => {
    expect(await codeOf(db.unscoped(async (tx) => alertDeliveryCursors.read(tx, 'app_sink')))).toBe(
      '42501',
    );
    expect(
      await codeOf(db.unscoped(async (tx) => alertDeliveryCursors.advance(tx, 'app_sink', 1n))),
    ).toBe('42501');
    expect(
      await codeOf(
        db.unscoped(async (tx) => {
          await sql`select * from ops.alert_delivery_cursors`.execute(tx);
        }),
      ),
    ).toBe('42501');
  });
});
