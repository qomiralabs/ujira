// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One attempt never sends two legs to one destination. A leg's destination is its
// address and its tag, and no tag counts as one value.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { payoutAttempts, payouts, type NewPayoutLeg } from './repositories/payouts.js';
import { payoutMethods } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newAttempt,
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
let payoutId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// Another method on the fixture's first address, under its own tag.
async function taggedMethod(tag: bigint): Promise<string> {
  const method = await db.tenant(fixture.tenant).transaction(async (tx) =>
    payoutMethods.create(tx, {
      recipientId: fixture.recipientId,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress: fixture.destinationAddress,
      destinationTag: tag,
      details: null,
    }),
  );
  return method.id;
}

function leg(payoutMethodId: string, tag: bigint | null, amount: bigint): NewPayoutLeg {
  return {
    payoutMethodId,
    method: 'stellar_wallet',
    destinationAddress: fixture.destinationAddress,
    destinationTag: tag,
    amount,
  };
}

async function attemptWith(legs: readonly NewPayoutLeg[]) {
  const total = legs.reduce((sum, item) => sum + item.amount, 0n);
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) =>
      payoutAttempts.create(tx, newAttempt(fixture, payoutId, { total: usdc(total), legs })),
    );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  const { payout } = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
  payoutId = payout.id;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the legs of one attempt', () => {
  it('untagged plus tagged on one address accepted, duplicate untagged refused', async () => {
    const tagged = await taggedMethod(5n);
    const accepted = await attemptWith([
      leg(fixture.methodId, null, ONE_USDC),
      leg(tagged, 5n, ONE_USDC),
    ]);
    expect(accepted.total).toEqual(usdc(2n * ONE_USDC));

    await db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutAttempts.markDead(tx, accepted.id, {
        from: 'created',
        proof: { kind: 'tombstone' },
      }),
    );
    expect(
      await codeOf(
        attemptWith([leg(fixture.methodId, null, ONE_USDC), leg(fixture.methodId, null, ONE_USDC)]),
      ),
    ).toBe('23505');
  });

  it('refuses the same tag twice', async () => {
    const tagged = await taggedMethod(5n);
    expect(await codeOf(attemptWith([leg(tagged, 5n, ONE_USDC), leg(tagged, 5n, ONE_USDC)]))).toBe(
      '23505',
    );
  });

  it('accepts two tags on one address', async () => {
    const five = await taggedMethod(5n);
    const six = await taggedMethod(6n);
    const accepted = await attemptWith([leg(five, 5n, ONE_USDC), leg(six, 6n, ONE_USDC)]);
    expect(accepted.attemptNumber).toBe(1);
  });

  it('a retry after a dead attempt may use the same destination again', async () => {
    const first = await attemptWith([leg(fixture.methodId, null, ONE_USDC)]);
    await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutAttempts.markDead(tx, first.id, { from: 'created', proof: { kind: 'tombstone' } }),
      );
    const second = await attemptWith([leg(fixture.methodId, null, ONE_USDC)]);
    expect(second.attemptNumber).toBe(2);
  });
});

describe('a tag on another chain', () => {
  // Only one chain is settled today, so a second has to be made by hand.
  it.each([
    ['ujira.payout_legs', 'payout_legs_tag_chain'],
    ['ujira.receipt_legs', 'receipt_legs_tag_chain'],
  ])('%s holds a tag to Stellar', async (table, constraint) => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const check = await admin.query<{ definition: string; validated: boolean }>(
        `select pg_get_constraintdef(c.oid) as definition, c.convalidated as validated
           from pg_constraint as c
          where c.conname = $1 and c.conrelid = $2::regclass`,
        [constraint, table],
      );
      expect(check.rows[0]?.definition).toContain("'stellar'");
      expect(check.rows[0]?.definition).toContain('destination_tag IS NULL');
      expect(check.rows[0]?.validated).toBe(true);
    } finally {
      await admin.end();
    }
  });
});
