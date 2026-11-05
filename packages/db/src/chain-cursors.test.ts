// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A restart of the indexer picks up from here. Only its login can reach a position,
// and only through the two functions.

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { chainCursors } from './repositories/ops.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const NETWORK = 'stellar:testnet';

let database: TestDatabase;
let db: Database;

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  return work.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );
}

const read = (network: string) =>
  db.unscoped(async (tx) => chainCursors.read(tx, network), 'worker');
const advance = (network: string, cursor: string) =>
  db.unscoped(async (tx) => chainCursors.advance(tx, network, cursor), 'worker');

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('chain cursors', () => {
  it('has no position before the first scan', async () => {
    expect(await read('stellar:never-scanned')).toBeNull();
  });

  it('reads back the last position written', async () => {
    await advance(NETWORK, 'stellar:v1:ledger:5');
    expect(await read(NETWORK)).toBe('stellar:v1:ledger:5');
    await advance(NETWORK, 'stellar:v1:cursor:0000000123-0000000001');
    expect(await read(NETWORK)).toBe('stellar:v1:cursor:0000000123-0000000001');
  });

  it('keeps one position per network', async () => {
    await advance('stellar:one', 'first');
    await advance('stellar:two', 'second');
    expect(await read('stellar:one')).toBe('first');
    expect(await read('stellar:two')).toBe('second');
  });

  it('refuses a network that is not in the stored format', async () => {
    expect(await codeOf(advance('Not A Network', 'first'))).toBe('23514');
  });

  it('is out of reach of the app login', async () => {
    expect(await codeOf(db.unscoped(async (tx) => chainCursors.read(tx, NETWORK)))).toBe('42501');
    expect(await codeOf(db.unscoped(async (tx) => chainCursors.advance(tx, NETWORK, 'x')))).toBe(
      '42501',
    );
  });
});
