// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Running balances under real contention: many transactions writing the same
// accounts at once, with entries listed in different orders, so a writer that
// locked accounts in the order it was given would deadlock here.

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { ledger } from './repositories/ledger.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { deposit, ledgerFixture, postEvent, type LedgerFixture } from './testing/ledger-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const WRITERS = 32;
const FIRST_USE_INSTANCES = 40;
const FIRST_USE_WRITERS = 4;

let database: TestDatabase;
let db: Database;
let fixture: LedgerFixture;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  fixture = await ledgerFixture(db);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('ledger under concurrency', () => {
  // The first journals on an instance open its accounts. Writers listing their
  // entries in opposite orders once opened them in opposite orders, and each
  // waited on the other's uncommitted account row. The window is narrow, so
  // this races first use on many fresh instances.
  it('first use from writers listing entries in opposite orders never deadlocks', async () => {
    const instances = await Promise.all(
      Array.from({ length: FIRST_USE_INSTANCES }, async () => ledgerFixture(db)),
    );
    const results = await Promise.all(
      instances.flatMap((instance) =>
        Array.from({ length: FIRST_USE_WRITERS }, async (_, index) => {
          const entries = deposit(1n);
          return postEvent(db, instance, index % 2 === 0 ? entries : [...entries].reverse());
        }),
      ),
    );
    expect(results.every((result) => result.created)).toBe(true);
  });

  it('32 writers on one account leave no gaps and exact balances', async () => {
    const amounts = Array.from({ length: WRITERS }, (_, index) => BigInt(index + 1));
    const results = await Promise.all(
      amounts.map(async (amount, index) => {
        const entries = deposit(amount);
        // Half list their entries the other way round.
        return postEvent(db, fixture, index % 2 === 0 ? entries : [...entries].reverse());
      }),
    );
    expect(results.every((result) => result.created)).toBe(true);

    const session = db.tenant(fixture.tenant);
    const accounts = await session.transaction(async (tx) =>
      ledger.accounts(tx, fixture.instanceId),
    );
    const total = amounts.reduce((sum, amount) => sum + amount, 0n);
    const byKind = new Map(accounts.map((account) => [account.kind, account]));
    expect(byKind.get('balance')?.balance.amount).toBe(total);
    expect(byKind.get('external')?.balance.amount).toBe(-total);

    for (const account of accounts) {
      expect(account.lastSeq, account.kind).toBe(BigInt(WRITERS));
      const page = await session.transaction(async (tx) =>
        ledger.entries(tx, account.id, { limit: 100 }),
      );
      // Every sequence number once, in order, and each balance exactly the sum
      // of the entries up to it.
      expect(page.items.map((entry) => entry.accountSeq)).toEqual(
        amounts.map((_, index) => BigInt(index + 1)),
      );
      let running = 0n;
      for (const entry of page.items) {
        running += entry.amount;
        expect(entry.balanceAfter).toBe(running);
      }
      expect(running).toBe(account.balance.amount);
    }
  });
});
