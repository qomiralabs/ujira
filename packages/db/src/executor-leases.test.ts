// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Two jobs on one account would race its sequence. A fresh lease id on every lease means
// a job that outlived its lease can no longer write anything.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { executors } from './repositories/ops.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const NETWORK = 'stellar:testnet';

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

async function lease(leaseSeconds = 30) {
  return db.unscoped(async (tx) => executors.leaseFenced(tx, { network: NETWORK, leaseSeconds }));
}

async function release(
  held: { accountRef: string; leaseId: string },
  sequenceReached: bigint,
): Promise<boolean> {
  return db.unscoped(async (tx) =>
    executors.releaseFenced(tx, {
      network: NETWORK,
      accountRef: held.accountRef,
      leaseId: held.leaseId,
      sequenceReached,
    }),
  );
}

async function expireLeases(): Promise<void> {
  await admin.query(`update ops.executor_accounts set lease_expires_at = now() - interval '1 second'
                      where lease_expires_at is not null`);
}

async function sequenceOf(accountRef: string): Promise<string | undefined> {
  const rows = await admin.query<{ next_sequence: string }>(
    'select next_sequence from ops.executor_accounts where account_ref = $1',
    [accountRef],
  );
  return rows.rows[0]?.next_sequence;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

beforeEach(async () => {
  await admin.query('delete from ops.executor_accounts');
  await admin.query(
    `insert into ops.executor_accounts (network, account_ref, key_id, next_sequence)
     values ($1, 'GONE', 'key-one', 100)`,
    [NETWORK],
  );
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('executor leases', () => {
  it('a release with a lease id that was taken over updates nothing', async () => {
    const first = await lease();
    if (first === undefined) throw new Error('no lease');
    await expireLeases();
    const second = await lease();
    if (second === undefined) throw new Error('no lease');
    expect(second.leaseId).not.toBe(first.leaseId);

    expect(await release(first, 999n)).toBe(false);
    expect(await sequenceOf('GONE')).toBe('100');

    expect(await release(second, 101n)).toBe(true);
    expect(await sequenceOf('GONE')).toBe('101');
  });

  it('hands out the key id and the sequence the last holder reached', async () => {
    const first = await lease();
    if (first === undefined) throw new Error('no lease');
    expect(first).toMatchObject({ accountRef: 'GONE', keyId: 'key-one', nextSequence: 100n });
    await release(first, 105n);
    expect((await lease())?.nextSequence).toBe(105n);
  });

  it('never lets a sequence move backwards', async () => {
    const held = await lease();
    if (held === undefined) throw new Error('no lease');
    expect(await release(held, 99n)).toBe(false);
    expect(await sequenceOf('GONE')).toBe('100');
  });

  it('has nothing to give while the account is held', async () => {
    await lease();
    expect(await lease()).toBeUndefined();
  });

  it.each([
    ['an inactive account', `update ops.executor_accounts set active = false`],
    ['an account with no key', `update ops.executor_accounts set key_id = null`],
  ])('skips %s', async (_name, statement) => {
    await admin.query(statement);
    expect(await lease()).toBeUndefined();
  });

  it('gives racing jobs different accounts, and each one its own', async () => {
    await admin.query(
      `insert into ops.executor_accounts (network, account_ref, key_id)
       select $1, 'G' || n, 'key-' || n from generate_series(1, 7) as n`,
      [NETWORK],
    );
    const leases = await Promise.all(Array.from({ length: 8 }, async () => lease()));
    const refs = leases.flatMap((held) => (held === undefined ? [] : [held.accountRef]));
    // A locked row is skipped, so a racer can find nothing free this time, never a shared one.
    expect(new Set(refs).size).toBe(refs.length);
  });

  it.each([0, 3601])('refuses a lease of %i seconds', async (seconds) => {
    await expect(lease(seconds)).rejects.toMatchObject({ code: '22023' });
  });
});
