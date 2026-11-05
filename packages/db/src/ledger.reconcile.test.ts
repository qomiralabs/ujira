// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { ledger } from './repositories/ledger.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  asIndexer,
  deposit,
  ledgerFixture,
  postEvent,
  type LedgerFixture,
} from './testing/ledger-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let fixture: LedgerFixture;

async function record(state: {
  ledger: bigint;
  balance: bigint;
  pending?: bigint;
  committed?: bigint;
  spent?: bigint;
}): Promise<boolean> {
  return asIndexer(db, fixture.tenant, async (tx) =>
    ledger.recordState(tx, {
      mandateInstanceId: fixture.instanceId,
      ledger: state.ledger,
      balance: state.balance,
      pending: state.pending ?? 0n,
      committed: state.committed ?? 0n,
      spent: state.spent ?? 0n,
    }),
  );
}

async function reconcile() {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) => ledger.reconciliation(tx, fixture.instanceId));
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

beforeEach(async () => {
  fixture = await ledgerFixture(db);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('reconciliation', () => {
  it('has nothing to say before a state is recorded', async () => {
    expect(await reconcile()).toBeUndefined();
  });

  it('matches when the books agree with state()', async () => {
    await postEvent(db, fixture, deposit(100n));
    await postEvent(db, fixture, [
      { kind: 'balance', amount: -30n },
      { kind: 'committed', amount: 30n },
    ]);
    expect(await record({ ledger: 10n, balance: 70n, committed: 30n })).toBe(true);
    expect(await reconcile()).toEqual({
      mandateInstanceId: fixture.instanceId,
      ledger: 10n,
      state: { balance: 70n, pending: 0n, committed: 30n, spent: 0n },
      books: { balance: 70n, pending: 0n, committed: 30n, spent: 0n, fee: 0n },
      matches: true,
    });
  });

  it('a fake state() mismatch is reported', async () => {
    await postEvent(db, fixture, deposit(100n));
    await record({ ledger: 10n, balance: 99n });
    const found = await reconcile();
    expect(found?.matches).toBe(false);
    expect(found?.state.balance).toBe(99n);
    expect(found?.books.balance).toBe(100n);
  });

  it('reports a figure the books have never heard of', async () => {
    await postEvent(db, fixture, deposit(100n));
    await record({ ledger: 10n, balance: 100n, spent: 1n });
    const found = await reconcile();
    expect(found?.matches).toBe(false);
    expect(found?.books.spent).toBe(0n);
  });

  it('compares against the latest ledger, whatever order they arrived in', async () => {
    await postEvent(db, fixture, deposit(100n));
    await record({ ledger: 20n, balance: 100n });
    await record({ ledger: 10n, balance: 1n });
    const found = await reconcile();
    expect(found?.ledger).toBe(20n);
    expect(found?.matches).toBe(true);
  });

  it('records one state per ledger', async () => {
    expect(await record({ ledger: 10n, balance: 1n })).toBe(true);
    expect(await record({ ledger: 10n, balance: 2n })).toBe(false);
    expect((await reconcile())?.state.balance).toBe(1n);
  });
});
