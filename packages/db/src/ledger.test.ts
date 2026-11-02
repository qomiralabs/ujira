// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { I128_MAX } from '@ujira/core';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { ledger, type LedgerAccountKind } from './repositories/ledger.js';
import type { Schema } from './schema.generated.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  asIndexer,
  deposit,
  ledgerFixture,
  postEvent,
  recordEvent,
  type LedgerFixture,
} from './testing/ledger-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let fixture: LedgerFixture;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function balances(): Promise<Partial<Record<LedgerAccountKind, bigint>>> {
  const accounts = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => ledger.accounts(tx, fixture.instanceId));
  return Object.fromEntries(accounts.map((account) => [account.kind, account.balance.amount]));
}

async function asAdmin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
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

describe('journals', () => {
  it('posts a balanced journal and keeps every running balance', async () => {
    await postEvent(db, fixture, deposit(100n));
    await postEvent(db, fixture, [
      { kind: 'balance', amount: -40n },
      { kind: 'committed', amount: 40n },
    ]);
    expect(await balances()).toEqual({ external: -100n, balance: 60n, committed: 40n });
  });

  it('unbalanced journal raises UJ003 at commit', async () => {
    const attempt = postEvent(db, fixture, [
      { kind: 'external', amount: -100n },
      { kind: 'balance', amount: 99n },
    ]);
    expect(await codeOf(attempt)).toBe('UJ003');
    // Nothing of it survived, including the event in the same transaction.
    expect(await balances()).toEqual({});
  });

  it('refuses a journal with no entries at commit', async () => {
    expect(await codeOf(postEvent(db, fixture, []))).toBe('UJ003');
  });

  it('the same chain event posts once', async () => {
    const { first, again } = await asIndexer(db, fixture.tenant, async (tx) => {
      const chainEventId = await recordEvent(tx, fixture.instanceId);
      const input = {
        mandateInstanceId: fixture.instanceId,
        chainEventId,
        entries: deposit(100n),
      };
      return { first: await ledger.post(tx, input), again: await ledger.post(tx, input) };
    });
    expect(first.created).toBe(true);
    expect(again).toEqual({ created: false, journalId: first.journalId });
    expect(await balances()).toEqual({ external: -100n, balance: 100n });
  });

  it('refuses an entry that would take an account past zero', async () => {
    await postEvent(db, fixture, deposit(10n));
    const overdrawn = postEvent(db, fixture, [
      { kind: 'balance', amount: -11n },
      { kind: 'spent', amount: 11n },
    ]);
    expect(await codeOf(overdrawn)).toBe('UJ011');
    const backwards = postEvent(db, fixture, [
      { kind: 'external', amount: 11n },
      { kind: 'balance', amount: -11n },
    ]);
    expect(await codeOf(backwards)).toBe('UJ011');
    expect(await balances()).toEqual({ external: -10n, balance: 10n });
  });

  it('holds the widest amount exactly, and refuses to run past it', async () => {
    await postEvent(db, fixture, deposit(I128_MAX));
    expect(await balances()).toEqual({ external: -I128_MAX, balance: I128_MAX });
    // One more does not fit the amount domain. It fails rather than rounds.
    expect(await codeOf(postEvent(db, fixture, deposit(1n)))).toBe('23514');
  });

  it('pages the entries of an account in sequence', async () => {
    for (const amount of [1n, 2n, 3n]) await postEvent(db, fixture, deposit(amount));
    const session = db.tenant(fixture.tenant);
    const accounts = await session.transaction(async (tx) =>
      ledger.accounts(tx, fixture.instanceId),
    );
    const balance = accounts.find((account) => account.kind === 'balance');
    const accountId = balance?.id ?? '';
    expect(balance?.lastSeq).toBe(3n);
    const first = await session.transaction(async (tx) =>
      ledger.entries(tx, accountId, { limit: 2 }),
    );
    expect(first.items.map((entry) => entry.accountSeq)).toEqual([1n, 2n]);
    expect(first.items.map((entry) => entry.balanceAfter)).toEqual([1n, 3n]);
    expect(first.next).toBe('2');
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) =>
      ledger.entries(tx, accountId, { limit: 2, after }),
    );
    expect(rest.items.map((entry) => entry.amount)).toEqual([3n]);
    expect(rest.next).toBeNull();
    await expect(
      session.transaction(async (tx) =>
        ledger.entries(tx, accountId, { limit: 2, after: 'nonsense' }),
      ),
    ).rejects.toThrow('after is not a key this list returned');
  });
});

describe('reversals', () => {
  it('undoes a journal once, with a new journal, and never edits the first', async () => {
    const posted = await postEvent(db, fixture, deposit(100n));
    const journalId = posted.journalId ?? '';
    const reversed = await asIndexer(db, fixture.tenant, async (tx) =>
      ledger.reverse(tx, journalId),
    );
    expect(reversed?.created).toBe(true);
    expect(await balances()).toEqual({ external: 0n, balance: 0n });
    const again = await asIndexer(db, fixture.tenant, async (tx) => ledger.reverse(tx, journalId));
    expect(again).toEqual({ created: false, journalId: reversed?.journalId });
    expect(await balances()).toEqual({ external: 0n, balance: 0n });
    const entries = await asAdmin(async (client) =>
      client.query<{ count: string }>(
        'select count(*)::text as count from ujira.ledger_entries where journal_id = $1',
        [journalId],
      ),
    );
    expect(entries.rows[0]?.count).toBe('2');
  });

  it('finds nothing to reverse for a journal it cannot see', async () => {
    expect(
      await asIndexer(db, fixture.tenant, async (tx) =>
        ledger.reverse(tx, '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12'),
      ),
    ).toBeUndefined();
  });
});

describe('who can change a balance', () => {
  it('refuses the indexer and the app any direct change to an account', async () => {
    await postEvent(db, fixture, deposit(100n));
    const change = async (tx: Kysely<Schema>): Promise<void> => {
      await sql`update ujira.ledger_accounts set balance = 1000000`.execute(tx);
    };
    expect(await codeOf(asIndexer(db, fixture.tenant, change))).toBe('42501');
    expect(await codeOf(db.tenant(fixture.tenant).transaction(change))).toBe('42501');
    expect(await balances()).toEqual({ external: -100n, balance: 100n });
  });

  it('refuses the owner too, so a balance always equals the sum of its entries', async () => {
    await postEvent(db, fixture, deposit(100n));
    await asAdmin(async (client) => {
      await client.query('begin');
      await client.query('set local role ujira_owner');
      expect(await codeOf(client.query('update ujira.ledger_accounts set balance = 5'))).toBe(
        'UJ002',
      );
      await client.query('rollback');
      await client.query('begin');
      await client.query('set local role ujira_owner');
      expect(await codeOf(client.query('delete from ujira.ledger_accounts'))).toBe('UJ002');
      await client.query('rollback');
    });
  });

  it('opens a new account at zero whatever the insert says', async () => {
    const { rows } = await asAdmin(async (client) =>
      client.query<{ balance: string; last_seq: string }>(
        `insert into ujira.ledger_accounts
           (principal_id, project_id, mandate_instance_id, kind, chain, asset, scale, balance, last_seq)
         values ($1, $2, $3, 'pending', 'stellar', 'USDC', 7, 999, 7)
         returning balance, last_seq`,
        [fixture.tenant.principalId, fixture.tenant.projectId, fixture.instanceId],
      ),
    );
    expect(rows).toEqual([{ balance: '0', last_seq: '0' }]);
  });
});
