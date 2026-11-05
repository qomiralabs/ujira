// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every pair of fee refund statuses, against the list below. A refund that has settled
// or was found not to be owed stays that way, so money cannot go back a second time.

import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  FEE_REFUND_STATUS_VALUES,
  refunds,
  type FeeRefundStatusValue,
} from './repositories/fees.js';
import { mandateInstances } from './repositories/mandates.js';
import { payoutLegs } from './repositories/payout-legs.js';
import { IllegalTransitionError, payoutAttempts, payouts } from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { asIndexer } from './testing/ledger-fixture.js';
import {
  feeTerms,
  newAttempt,
  newPayout,
  ONE_USDC,
  payoutFixture,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const ALLOWED: readonly (readonly [FeeRefundStatusValue, FeeRefundStatusValue])[] = [
  ['owed', 'awaiting_signatures'],
  ['owed', 'not_owed'],
  ['awaiting_signatures', 'submitted'],
  ['awaiting_signatures', 'failed'],
  ['submitted', 'settled'],
  ['submitted', 'failed'],
  ['failed', 'awaiting_signatures'],
];

function isAllowed(from: FeeRefundStatusValue, to: FeeRefundStatusValue): boolean {
  return ALLOWED.some(([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to);
}

const PAIRS = FEE_REFUND_STATUS_VALUES.flatMap((from) =>
  FEE_REFUND_STATUS_VALUES.filter((to) => to !== from).map((to) => [from, to] as const),
);

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let fixture: PayoutFixture;
let feeRefundId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  await asIndexer(db, fixture.tenant, async (tx) =>
    mandateInstances.setFeeCap(tx, fixture.instanceId, { maxFeeBps: 100, feeAddress: 'GFEE' }),
  );
  const termsId = await feeTerms(db, fixture);
  feeRefundId = await db.tenant(fixture.tenant).transaction(async (tx) => {
    const { payout } = await payouts.create(tx, newPayout(fixture));
    const attempt = await payoutAttempts.create(
      tx,
      newAttempt(fixture, payout.id, { fee: { amount: 25_000n, bps: 50, termsId } }),
    );
    const [leg] = await payoutLegs.forAttempt(tx, attempt.id);
    if (leg === undefined) throw new Error('the attempt has no legs');
    const recorded = await refunds.recordLegRefund(tx, {
      payoutLegId: leg.id,
      amount: ONE_USDC,
      refundToAddress: 'GPRINCIPAL',
      txHash: randomBytes(32),
      eventIndex: 0n,
    });
    if (recorded === undefined) throw new Error('the leg was not visible');
    const planned = await refunds.planFeeRefund(tx, recorded.legRefund.id);
    if (planned === undefined) throw new Error('the leg refund was not visible');
    return planned.feeRefund.id;
  });
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('fee refund transitions', () => {
  it('the database lists exactly these', async () => {
    const rows = await admin.query<{ from_status: string; to_status: string }>(
      `select from_status, to_status from ujira.status_transitions where machine = 'fee_refund'`,
    );
    const listed = rows.rows.map((row) => `${row.from_status}>${row.to_status}`).sort();
    expect(listed).toEqual(ALLOWED.map(([from, to]) => `${from}>${to}`).sort());
  });

  it('every pair is held to the list in the database', async () => {
    await admin.query('begin');
    try {
      // A hash on the row, so the check that a submitted refund has one stays out of this.
      await admin.query('set local session_replication_role = replica');
      await admin.query(`update ujira.fee_refunds set tx_hash = $1 where id = $2`, [
        randomBytes(32),
        feeRefundId,
      ]);
      for (const [from, to] of PAIRS) {
        await admin.query('savepoint pair');
        await admin.query('set local session_replication_role = replica');
        await admin.query('update ujira.fee_refunds set status = $1 where id = $2', [
          from,
          feeRefundId,
        ]);
        await admin.query('set local session_replication_role = origin');
        const moved = admin.query('update ujira.fee_refunds set status = $1 where id = $2', [
          to,
          feeRefundId,
        ]);
        expect(await codeOf(moved), `${from} to ${to}`).toBe(
          isAllowed(from, to) ? undefined : 'UJ004',
        );
        await admin.query('rollback to savepoint pair');
      }
    } finally {
      await admin.query('rollback');
    }
  });

  it('every disallowed pair fails in the repository with a typed error', async () => {
    const disallowed = PAIRS.filter(([from, to]) => !isAllowed(from, to));
    expect(disallowed.length).toBeGreaterThan(20);
    for (const [from, to] of disallowed) {
      await expect(
        db
          .tenant(fixture.tenant)
          .transaction(async (tx) => refunds.transitionFeeRefund(tx, feeRefundId, from, to)),
        `${from} to ${to}`,
      ).rejects.toBeInstanceOf(IllegalTransitionError);
    }
  });

  it('walks to settled through the repository, keeping the hash', async () => {
    const txHash = randomBytes(32);
    const move = async (
      from: FeeRefundStatusValue,
      to: FeeRefundStatusValue,
      patch?: Parameters<typeof refunds.transitionFeeRefund>[4],
    ) =>
      db
        .tenant(fixture.tenant)
        .transaction(async (tx) => refunds.transitionFeeRefund(tx, feeRefundId, from, to, patch));
    await move('owed', 'awaiting_signatures');
    await move('awaiting_signatures', 'failed', { failureReason: 'signature_expired' });
    await move('failed', 'awaiting_signatures');
    await move('awaiting_signatures', 'submitted', { txHash });
    const settled = await move('submitted', 'settled');
    expect(settled).toMatchObject({ status: 'settled', txHash });
  });

  it('finds nothing when the refund has already moved on', async () => {
    const moved = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        refunds.transitionFeeRefund(tx, feeRefundId, 'failed', 'awaiting_signatures'),
      );
    expect(moved).toBeUndefined();
  });

  it('refuses submitted with no transaction hash', async () => {
    const attempt = db.tenant(fixture.tenant).transaction(async (tx) => {
      await refunds.transitionFeeRefund(tx, feeRefundId, 'owed', 'awaiting_signatures');
      return refunds.transitionFeeRefund(tx, feeRefundId, 'awaiting_signatures', 'submitted');
    });
    expect(await codeOf(attempt)).toBe('23514');
  });

  it('refuses a failure reason that could hold free text', async () => {
    const attempt = db.tenant(fixture.tenant).transaction(async (tx) => {
      await refunds.transitionFeeRefund(tx, feeRefundId, 'owed', 'awaiting_signatures');
      return refunds.transitionFeeRefund(tx, feeRefundId, 'awaiting_signatures', 'failed', {
        failureReason: 'Jane Doe told us no',
      });
    });
    expect(await codeOf(attempt)).toBe('23514');
  });
});
