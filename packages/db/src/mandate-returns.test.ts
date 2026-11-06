// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for mandateReturns.book (repositories/returns.ts), CHAINOPS-SWEEP-001: a
 * swept event is booked once by its chain, transaction and index, however often it
 * is presented, and never into another tenant's books.
 */

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { ledger, type LedgerAccountKind } from './repositories/ledger.js';
import {
  SweepBookingConflictError,
  mandateReturns,
  type SweptEventInput,
} from './repositories/returns.js';
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

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

async function balances(
  fixture: LedgerFixture,
): Promise<Partial<Record<LedgerAccountKind, bigint>>> {
  const accounts = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => ledger.accounts(tx, fixture.instanceId));
  return Object.fromEntries(accounts.map((account) => [account.kind, account.balance.amount]));
}

function swept(fixture: LedgerFixture, over: Partial<SweptEventInput> = {}): SweptEventInput {
  return {
    mandateInstanceId: fixture.instanceId,
    chain: 'stellar',
    txHash: randomBytes(32),
    eventIndex: 2n,
    ledger: 10n,
    amount: 250n,
    finalizedAt: new Date(),
    ...over,
  };
}

const book = (fixture: LedgerFixture, input: SweptEventInput) =>
  asIndexer(db, fixture.tenant, (tx) => mandateReturns.book(tx, input));

describe('booking a returned balance', () => {
  it('a replayed swept event books one sweep', async () => {
    const fixture = await ledgerFixture(db);
    await postEvent(db, fixture, deposit(250n));
    const event = swept(fixture);
    expect(await book(fixture, event)).toBe('booked');
    expect(await balances(fixture)).toEqual({ balance: 0n, external: 0n });
    expect(await book(fixture, event)).toBe('duplicate');
    expect(await book(fixture, { ...event, txHash: Buffer.from(event.txHash) })).toBe('duplicate');
    expect(await balances(fixture)).toEqual({ balance: 0n, external: 0n });
  });

  it('never books into another tenant, nor on top of an event it cannot see', async () => {
    const mine = await ledgerFixture(db);
    const theirs = await ledgerFixture(db);
    await postEvent(db, mine, deposit(250n));
    await postEvent(db, theirs, deposit(250n));
    const event = swept(mine);
    expect(await book(mine, event)).toBe('booked');
    // The same chain event presented under the other tenant.
    await expect(
      book(theirs, { ...event, mandateInstanceId: theirs.instanceId }),
    ).rejects.toBeInstanceOf(SweepBookingConflictError);
    // And another tenant's instance cannot be booked against at all.
    await expect(book(theirs, swept(mine))).rejects.toThrow();
    expect(await balances(theirs)).toEqual({ balance: 250n, external: -250n });
  });

  it('refuses a sweep of nothing, or more than the books hold', async () => {
    const fixture = await ledgerFixture(db);
    await postEvent(db, fixture, deposit(100n));
    await expect(book(fixture, swept(fixture, { amount: 0n }))).rejects.toBeInstanceOf(RangeError);
    // A sweep the books cannot cover is a divergence to look at, never a negative balance.
    await expect(book(fixture, swept(fixture, { amount: 101n }))).rejects.toThrow();
    expect(await balances(fixture)).toEqual({ balance: 100n, external: -100n });
  });
});
