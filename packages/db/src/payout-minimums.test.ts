// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { PAYOUT_METHODS } from '@ujira/api-schema';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { AmountBelowMinimumError, PAYOUT_MINIMUM_METHODS } from './payout-minimum.js';
import { audit } from './repositories/audit.js';
import { payoutMinimums, payouts } from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newPayout,
  ONE_USDC,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function setMinimum(amount: bigint): Promise<void> {
  await db.tenant(fixture.tenant).transaction(async (tx) =>
    payoutMinimums.set(tx, {
      method: 'stellar_wallet',
      minimum: { amount, currency: 'USD', scale: 2 },
      memberId: fixture.memberId,
    }),
  );
}

async function create(amount: bigint) {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) => payouts.create(tx, newPayout(fixture, { requested: usdc(amount) })));
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('project payout minimums', () => {
  it('a project minimum below the method floor has no effect and one above it applies', async () => {
    await setMinimum(50n);
    await expect(create(ONE_USDC - 1n)).rejects.toMatchObject({ reason: 'ujira_floor' });
    expect((await create(ONE_USDC)).created).toBe(true);

    await setMinimum(300n);
    await expect(create(3n * ONE_USDC - 1n)).rejects.toMatchObject({
      code: 'AMOUNT_BELOW_MINIMUM',
      method: 'stellar_wallet',
      reason: 'project_min',
      minimum: { amount: 300n, currency: 'USD', scale: 2 },
    });
    expect((await create(3n * ONE_USDC)).created).toBe(true);
  });

  it('the method check accepts stellar_wallet, bank, mobile_money and cash_pickup and refuses cash', async () => {
    const session = db.tenant(fixture.tenant);
    for (const method of ['stellar_wallet', 'bank', 'mobile_money', 'cash_pickup'] as const) {
      await session.transaction(async (tx) =>
        payoutMinimums.set(tx, {
          method,
          minimum: { amount: 1000n, currency: 'USD', scale: 2 },
          memberId: fixture.memberId,
        }),
      );
    }
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          payoutMinimums.set(tx, {
            method: 'cash' as 'bank',
            minimum: { amount: 1000n, currency: 'USD', scale: 2 },
            memberId: fixture.memberId,
          }),
        ),
      ),
    ).toBe('23514');
    const stored = await session.transaction(async (tx) => payoutMinimums.list(tx));
    expect(stored.map((row) => row.method).sort()).toEqual([...PAYOUT_METHODS].sort());
  });

  it('PAYOUT_METHODS equals every database check on a method', async () => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const checks = await admin.query<{ name: string; definition: string }>(
        `select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
          where conname in ('payouts_method', 'project_payout_minimums_method', 'payout_methods_method')`,
      );
      expect(checks.rows.map((row) => row.name).sort()).toEqual([
        'payout_methods_method',
        'payouts_method',
        'project_payout_minimums_method',
      ]);
      for (const check of checks.rows) {
        const values = [...check.definition.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
        expect([...values].sort(), check.name).toEqual([...PAYOUT_METHODS].sort());
      }
    } finally {
      await admin.end();
    }
    expect([...PAYOUT_MINIMUM_METHODS].sort()).toEqual([...PAYOUT_METHODS].sort());
  });

  it('a change writes one audit row, and setting the same value writes none', async () => {
    await setMinimum(300n);
    await setMinimum(300n);
    await setMinimum(400n);
    const logged = await db
      .principal(fixture.tenant, 'app')
      .transaction(async (tx) => audit.list(tx, { limit: 10 }));
    expect(logged.items.map((item) => item.action)).toEqual([
      'project.payout_minimums_changed',
      'project.payout_minimums_changed',
    ]);
    expect(logged.items[0]?.metadata).toMatchObject({ old_value: null, new_value: '300' });
    expect(logged.items[1]?.metadata).toMatchObject({ old_value: '300', new_value: '400' });
    expect(logged.items[1]?.actorId).toBe(fixture.memberId);
    const verified = await db
      .principal(fixture.tenant, 'app')
      .transaction(async (tx) => audit.verify(tx));
    expect(verified.firstBreak).toBeNull();
  });

  it('records who set it, who must be a member of the principal', async () => {
    const stranger = await payoutFixture(db);
    expect(
      await codeOf(
        db.tenant(fixture.tenant).transaction(async (tx) =>
          payoutMinimums.set(tx, {
            method: 'bank',
            minimum: { amount: 1000n, currency: 'USD', scale: 2 },
            memberId: stranger.memberId,
          }),
        ),
      ),
    ).toBe('23503');
    await setMinimum(300n);
    const stored = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutMinimums.list(tx));
    expect(stored[0]?.setBy).toBe(fixture.memberId);
  });

  it('refuses a minimum of zero, and a scale the currency does not have', async () => {
    const set = async (amount: bigint, scale: number) =>
      db.tenant(fixture.tenant).transaction(async (tx) =>
        payoutMinimums.set(tx, {
          method: 'bank',
          minimum: { amount, currency: 'USD', scale },
          memberId: fixture.memberId,
        }),
      );
    expect(await codeOf(set(0n, 2))).toBe('23514');
    expect(await codeOf(set(1000n, 1))).toBe('23503');
  });

  it('a payout below the minimum writes nothing', async () => {
    await expect(create(1n)).rejects.toBeInstanceOf(AmountBelowMinimumError);
    const page = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.list(tx, { limit: 10 }));
    expect(page.items).toEqual([]);
  });
});
