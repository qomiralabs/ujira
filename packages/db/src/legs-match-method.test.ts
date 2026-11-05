// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A leg must use exactly its method's destination. Money sent to the right address
// with the wrong tag is lost as surely as money sent to the wrong address.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { payoutLegs } from './repositories/payout-legs.js';
import { payoutAttempts, payouts, type NewPayoutLeg } from './repositories/payouts.js';
import { payoutMethods } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newAttempt,
  newLeg,
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
let taggedMethodId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function attemptWith(legs: readonly NewPayoutLeg[]) {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) =>
      payoutAttempts.create(
        tx,
        newAttempt(fixture, payoutId, { total: usdc(5n * ONE_USDC), legs }),
      ),
    );
}

function taggedLeg(tag: bigint | null): NewPayoutLeg {
  return {
    payoutMethodId: taggedMethodId,
    method: 'stellar_wallet',
    destinationAddress: fixture.destinationAddress,
    destinationTag: tag,
    amount: 5n * ONE_USDC,
  };
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  const made = await db.tenant(fixture.tenant).transaction(async (tx) => {
    const { payout } = await payouts.create(tx, newPayout(fixture));
    const method = await payoutMethods.create(tx, {
      recipientId: fixture.recipientId,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress: fixture.destinationAddress,
      destinationTag: 77n,
      details: null,
    });
    return { payoutId: payout.id, methodId: method.id };
  });
  payoutId = made.payoutId;
  taggedMethodId = made.methodId;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('a leg and its method', () => {
  it('a leg with another tag than its method raises UJ010', async () => {
    expect(await codeOf(attemptWith([taggedLeg(78n)]))).toBe('UJ010');
  });

  it('a leg with no tag on a tagged method raises UJ010', async () => {
    expect(await codeOf(attemptWith([taggedLeg(null)]))).toBe('UJ010');
  });

  it('a leg with a tag on an untagged method raises UJ010', async () => {
    expect(
      await codeOf(attemptWith([{ ...newLeg(fixture, 5n * ONE_USDC), destinationTag: 77n }])),
    ).toBe('UJ010');
  });

  it('a leg with another address than its method raises UJ010', async () => {
    expect(
      await codeOf(
        attemptWith([{ ...newLeg(fixture, 5n * ONE_USDC), destinationAddress: 'GSOMEONEELSE' }]),
      ),
    ).toBe('UJ010');
  });

  it('accepts exactly the method destination, tag and all', async () => {
    const attempt = await attemptWith([taggedLeg(77n)]);
    const legs = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutLegs.forAttempt(tx, attempt.id));
    expect(legs[0]?.destinationTag).toBe(77n);
    expect(legs[0]?.destinationAddress).toBe(fixture.destinationAddress);
  });

  it('holds on a later change too, even by the owner', async () => {
    const attempt = await attemptWith([taggedLeg(77n)]);
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local role ujira_owner');
      expect(
        await codeOf(
          admin.query('update ujira.payout_legs set destination_tag = 78 where attempt_id = $1', [
            attempt.id,
          ]),
        ),
      ).toBe('UJ010');
      await admin.query('rollback');
    } finally {
      await admin.end();
    }
  });

  it('a method of another recipient is still its own refusal', async () => {
    const other = await payoutFixture(db);
    expect(await codeOf(attemptWith([newLeg(other, 5n * ONE_USDC)]))).toBe('UJ015');
  });
});
