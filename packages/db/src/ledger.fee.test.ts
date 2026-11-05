// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fee leaves the mandate alongside the payout, so the contract's spent figure holds
// both. The books keep them apart, so a fee is never mistaken for money paid out, and
// reconcile on paid_out + fee = spent.

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { ledger, type LedgerEntryInput } from './repositories/ledger.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  asIndexer,
  ledgerFixture,
  recordEvent,
  type LedgerFixture,
} from './testing/ledger-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let fixture: LedgerFixture;

async function post(entries: readonly LedgerEntryInput[], at: bigint) {
  await asIndexer(db, fixture.tenant, async (tx) => {
    const chainEventId = await recordEvent(tx, fixture.instanceId, at);
    await ledger.post(tx, { mandateInstanceId: fixture.instanceId, chainEventId, entries });
  });
}

async function state(spent: bigint, balance: bigint) {
  await asIndexer(db, fixture.tenant, async (tx) =>
    ledger.recordState(tx, {
      mandateInstanceId: fixture.instanceId,
      ledger: 10n,
      balance,
      pending: 0n,
      committed: 0n,
      spent,
    }),
  );
}

async function reconciliation() {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) => ledger.reconciliation(tx, fixture.instanceId));
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await ledgerFixture(db);
  await post(
    [
      { kind: 'external', amount: -100n },
      { kind: 'balance', amount: 100n },
    ],
    1n,
  );
  await post(
    [
      { kind: 'balance', amount: -60n },
      { kind: 'spent', amount: 50n },
      { kind: 'fee', amount: 10n },
    ],
    2n,
  );
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the fee account', () => {
  it('keeps the fee apart from what was paid out', async () => {
    const accounts = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => ledger.accounts(tx, fixture.instanceId));
    const kinds = new Map(accounts.map((account) => [account.kind, account.balance.amount]));
    expect(kinds.get('spent')).toBe(50n);
    expect(kinds.get('fee')).toBe(10n);
  });

  it('reconciles on paid_out + fee = spent', async () => {
    await state(60n, 40n);
    const result = await reconciliation();
    expect(result?.books).toMatchObject({ spent: 50n, fee: 10n, balance: 40n });
    expect(result?.state.spent).toBe(60n);
    expect(result?.matches).toBe(true);
  });

  it('shows a disagreement when the contract counts the fee differently', async () => {
    await state(50n, 40n);
    expect((await reconciliation())?.matches).toBe(false);
  });

  it('cannot go below zero', async () => {
    await expect(
      post(
        [
          { kind: 'fee', amount: -11n },
          { kind: 'balance', amount: 11n },
        ],
        3n,
      ),
    ).rejects.toMatchObject({ code: 'UJ011' });
  });
});
