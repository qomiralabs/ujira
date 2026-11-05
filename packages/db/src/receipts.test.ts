// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { payoutAttempts, payouts, IdempotencyConflictError } from './repositories/payouts.js';
import { ReceiptRevisionError, receipts, type NewReceipt } from './repositories/receipts.js';
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

const FIRST_LEG = 3n * ONE_USDC;
const SECOND_LEG = 2n * ONE_USDC;
const TOTAL = FIRST_LEG + SECOND_LEG;

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;
let payoutId: string;
let attemptId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function receipt(overrides: Partial<NewReceipt> = {}): NewReceipt {
  return {
    payoutId,
    attemptId,
    revision: 1,
    chainReceiptRef: 'receipt-ref',
    settlement: usdc(TOTAL),
    fee: 30n,
    legs: [
      {
        legIndex: 0,
        destinationAddress: fixture.destinationAddress,
        amount: FIRST_LEG,
        fee: 10n,
        chainTxHash: 'tx-0',
      },
      {
        legIndex: 1,
        destinationAddress: fixture.destinationAddress,
        amount: SECOND_LEG,
        fee: 20n,
        chainTxHash: 'tx-1',
      },
    ],
    ...overrides,
  };
}

async function record(overrides: Partial<NewReceipt> = {}) {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) => receipts.record(tx, receipt(overrides)));
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  const made = await db.tenant(fixture.tenant).transaction(async (tx) => {
    const { payout } = await payouts.create(tx, newPayout(fixture));
    const attempt = await payoutAttempts.create(
      tx,
      newAttempt(fixture, payout.id, {
        total: usdc(TOTAL),
        legs: [newLeg(fixture, FIRST_LEG, 0), newLeg(fixture, SECOND_LEG, 1)],
      }),
    );
    return { payoutId: payout.id, attemptId: attempt.id };
  });
  payoutId = made.payoutId;
  attemptId = made.attemptId;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('revisions', () => {
  it('a correction inserts revision 2 and keeps revision 1', async () => {
    const first = await record();
    const corrected = await record({ revision: 2, chainReceiptRef: 'corrected-ref' });
    expect(corrected.created).toBe(true);
    const session = db.tenant(fixture.tenant);
    const all = await session.transaction(async (tx) => receipts.revisions(tx, payoutId));
    expect(all.map((row) => row.revision)).toEqual([1, 2]);
    expect(all[0]).toEqual(first.receipt);
    expect(all[1]?.chainReceiptRef).toBe('corrected-ref');
    const latest = await session.transaction(async (tx) => receipts.latest(tx, payoutId));
    expect(latest?.revision).toBe(2);
  });

  it('a retry finds the first, and different figures are refused', async () => {
    const first = await record();
    expect(await record()).toEqual({ receipt: first.receipt, created: false });
    await expect(record({ chainReceiptRef: 'other' })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('of parallel records of one revision, one writes', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, async () => record()));
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('refuses a revision that skips one, or that is below 1', async () => {
    await expect(record({ revision: 2 })).rejects.toBeInstanceOf(ReceiptRevisionError);
    await expect(record({ revision: 0 })).rejects.toBeInstanceOf(ReceiptRevisionError);
  });

  it('has nothing for a payout with no receipt', async () => {
    const session = db.tenant(fixture.tenant);
    expect(await session.transaction(async (tx) => receipts.latest(tx, payoutId))).toBeUndefined();
    expect(await session.transaction(async (tx) => receipts.revisions(tx, payoutId))).toEqual([]);
  });
});

describe('what a receipt lists', () => {
  it('lists every leg with its chain reference', async () => {
    const { receipt: written } = await record();
    const legs = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => receipts.legs(tx, written.id));
    expect(legs.map((leg) => [leg.legIndex, leg.amount, leg.fee, leg.chainTxHash])).toEqual([
      [0, usdc(FIRST_LEG), usdc(10n), 'tx-0'],
      [1, usdc(SECOND_LEG), usdc(20n), 'tx-1'],
    ]);
    expect(written.settlement).toEqual(usdc(TOTAL));
    expect(written.fee).toEqual(usdc(30n));
  });

  it('a receipt missing a leg is refused at commit', async () => {
    const whole = receipt();
    expect(
      await codeOf(record({ settlement: usdc(FIRST_LEG), fee: 10n, legs: whole.legs.slice(0, 1) })),
    ).toBe('UJ016');
  });

  it('a receipt with no legs is refused at commit', async () => {
    expect(await codeOf(record({ legs: [] }))).toBe('UJ016');
  });

  it('totals that are not the sums of the legs are refused at commit', async () => {
    expect(await codeOf(record({ settlement: usdc(TOTAL - 1n) }))).toBe('UJ016');
    expect(await codeOf(record({ fee: 31n }))).toBe('UJ016');
  });

  it('refuses a leg its attempt does not have', async () => {
    const whole = receipt();
    const [first] = whole.legs;
    if (first === undefined) throw new Error('the fixture has legs');
    expect(await codeOf(record({ legs: [first, { ...first, legIndex: 2 }] }))).toBe('23503');
  });

  it('refuses another payout attempt, by foreign key', async () => {
    const other = await db.tenant(fixture.tenant).transaction(async (tx) => {
      const { payout } = await payouts.create(tx, newPayout(fixture));
      return payoutAttempts.create(tx, newAttempt(fixture, payout.id));
    });
    expect(await codeOf(record({ attemptId: other.id }))).toBe('23503');
  });

  it('is refused for writes outside the owner, and untouchable by the owner', async () => {
    const { receipt: written } = await record();
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      for (const statement of [
        `update ujira.receipts set chain_receipt_ref = 'x' where id = '${written.id}'`,
        `delete from ujira.receipts where id = '${written.id}'`,
        `update ujira.receipt_legs set chain_tx_hash = 'x' where receipt_id = '${written.id}'`,
        `delete from ujira.receipt_legs where receipt_id = '${written.id}'`,
      ]) {
        await admin.query('begin');
        await admin.query('set local role ujira_owner');
        expect(await codeOf(admin.query(statement)), statement).toBe('UJ002');
        await admin.query('rollback');
      }
    } finally {
      await admin.end();
    }
  });
});
