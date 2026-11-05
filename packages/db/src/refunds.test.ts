// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// When an anchor refunds a leg, the part of the fee charged on it goes back to the
// principal. Both refunds move money, so each is bounded at commit, and a retry or a
// race can never owe a principal twice or owe them more than was paid.

import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { FeeAddressUnknownError, refunds, type NewLegRefund } from './repositories/fees.js';
import { mandateInstances } from './repositories/mandates.js';
import { payoutLegs } from './repositories/payout-legs.js';
import { IdempotencyConflictError, payoutAttempts, payouts } from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { asIndexer } from './testing/ledger-fixture.js';
import {
  feeTerms,
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
const FEE = 25_000n;
const FEE_ADDRESS = 'GFEEADDRESS';
const PRINCIPAL_ADDRESS = 'GPRINCIPALADDRESS';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let fixture: PayoutFixture;
let termsId: string;
let attemptId: string;
let firstLegId: string;
let secondLegId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function makeAttempt(fee: bigint) {
  return db.tenant(fixture.tenant).transaction(async (tx) => {
    const { payout } = await payouts.create(tx, newPayout(fixture));
    const attempt = await payoutAttempts.create(
      tx,
      newAttempt(fixture, payout.id, {
        total: usdc(TOTAL),
        legs: [newLeg(fixture, FIRST_LEG, 0), newLeg(fixture, SECOND_LEG, 1)],
        fee: { amount: fee, bps: 50, termsId: fee === 0n ? null : termsId },
      }),
    );
    const legs = await payoutLegs.forAttempt(tx, attempt.id);
    const [first, second] = legs;
    if (first === undefined || second === undefined) throw new Error('the attempt has no legs');
    return { attemptId: attempt.id, firstLegId: first.id, secondLegId: second.id };
  });
}

function legRefund(overrides: Partial<NewLegRefund> = {}): NewLegRefund {
  return {
    payoutLegId: firstLegId,
    amount: FIRST_LEG,
    refundToAddress: PRINCIPAL_ADDRESS,
    txHash: randomBytes(32),
    eventIndex: 0n,
    ...overrides,
  };
}

async function recordRefund(overrides: Partial<NewLegRefund> = {}) {
  const result = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => refunds.recordLegRefund(tx, legRefund(overrides)));
  if (result === undefined) throw new Error('the leg was not visible');
  return result;
}

async function plan(legRefundId: string) {
  const result = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => refunds.planFeeRefund(tx, legRefundId));
  if (result === undefined) throw new Error('the leg refund was not visible');
  return result;
}

// Around the repository, because planFeeRefund never works out more than the fee.
async function insertFeeRefund(legRefundId: string, amount: bigint) {
  return admin.query(
    `insert into ujira.fee_refunds
       (principal_id, project_id, leg_refund_id, payout_id, attempt_id, chain, asset, scale, amount,
        from_address, to_address, idempotency_key, due_at)
     select r.principal_id, r.project_id, r.id, r.payout_id, r.attempt_id, r.chain, r.asset, r.scale,
            $2::numeric, 'GFEE', 'GPRINCIPAL',
            sha256(convert_to('ujira/fee-refund/v1' || r.id::text, 'UTF8')), now()
       from ujira.leg_refunds as r
      where r.id = $1`,
    [legRefundId, amount.toString()],
  );
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
    mandateInstances.setFeeCap(tx, fixture.instanceId, {
      maxFeeBps: 100,
      feeAddress: FEE_ADDRESS,
    }),
  );
  termsId = await feeTerms(db, fixture);
  ({ attemptId, firstLegId, secondLegId } = await makeAttempt(FEE));
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('leg refunds', () => {
  it('records the refund against its leg, taking the unit and attempt from the leg', async () => {
    const { created, legRefund: refund } = await recordRefund();
    expect(created).toBe(true);
    expect(refund).toMatchObject({
      payoutLegId: firstLegId,
      attemptId,
      amount: usdc(FIRST_LEG),
      refundToAddress: PRINCIPAL_ADDRESS,
    });
  });

  it('cannot be stamped onto another attempt, whatever a writer passes', async () => {
    const other = await makeAttempt(0n);
    const inserted = await admin.query<{ attempt_id: string }>(
      `insert into ujira.leg_refunds
         (principal_id, project_id, payout_leg_id, payout_id, attempt_id, chain, asset, scale, amount,
          refund_to_address, tx_hash, event_index)
       select principal_id, project_id, $1, payout_id, $2, chain, asset, scale, 1, 'G', $3, 0
         from ujira.payout_legs where id = $1
       returning attempt_id`,
      [firstLegId, other.attemptId, randomBytes(32)],
    );
    expect(inserted.rows[0]?.attempt_id).toBe(attemptId);
  });

  it('finds the first record when the same event is presented again', async () => {
    const txHash = randomBytes(32);
    const first = await recordRefund({ txHash });
    const again = await recordRefund({ txHash });
    expect(again.created).toBe(false);
    expect(again.legRefund.id).toBe(first.legRefund.id);
  });

  it('refuses the same event carrying other figures', async () => {
    const txHash = randomBytes(32);
    await recordRefund({ txHash, amount: 1n });
    await expect(recordRefund({ txHash, amount: 2n })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('UJ008', async () => {
    expect(await codeOf(recordRefund({ amount: FIRST_LEG + 1n }))).toBe('UJ008');

    await recordRefund({ amount: FIRST_LEG - 1n });
    expect(await codeOf(recordRefund({ amount: 2n }))).toBe('UJ008');
    expect((await recordRefund({ amount: 1n })).created).toBe(true);
  });

  it('holds the bound per leg, not across the attempt', async () => {
    await recordRefund({ amount: FIRST_LEG });
    expect((await recordRefund({ payoutLegId: secondLegId, amount: SECOND_LEG })).created).toBe(
      true,
    );
  });

  // Each alone fits, so only the lock taken at commit can stop them together.
  it('lets racing refunds through only as far as the leg goes', async () => {
    const half = FIRST_LEG / 2n;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async () => recordRefund({ amount: half })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect((result.reason as { code?: string }).code).toBe('UJ008');
      }
    }
  });

  it('refuses an amount of zero', async () => {
    expect(await codeOf(recordRefund({ amount: 0n }))).toBe('23514');
  });

  it('is append only for everyone, the superuser included', async () => {
    const { legRefund: refund } = await recordRefund();
    expect(
      await codeOf(admin.query('delete from ujira.leg_refunds where id = $1', [refund.id])),
    ).toBe('UJ002');
    expect(
      await codeOf(
        admin.query('update ujira.leg_refunds set amount = 1 where id = $1', [refund.id]),
      ),
    ).toBe('UJ002');
  });
});

describe('planning a fee refund', () => {
  it('CHAINOPS-FEE-004: returns the fee on the refunded part, rounded up, to the principal', async () => {
    const { legRefund: refund } = await recordRefund({ amount: FIRST_LEG });
    const { created, feeRefund } = await plan(refund.id);
    expect(created).toBe(true);
    expect(feeRefund).toMatchObject({
      legRefundId: refund.id,
      attemptId,
      amount: usdc(15_000n),
      fromAddress: FEE_ADDRESS,
      toAddress: PRINCIPAL_ADDRESS,
      status: 'owed',
      txHash: null,
    });

    const small = await recordRefund({ payoutLegId: secondLegId, amount: 333_333n });
    // 333_333 * 25_000 / 50_000_000 is 166.6665.
    expect((await plan(small.legRefund.id)).feeRefund.amount).toEqual(usdc(167n));
  });

  it('CHAINOPS-FEE-004: a one minor unit refund on a non-zero fee returns at least 1', async () => {
    const { legRefund: refund } = await recordRefund({ amount: 1n });
    const { feeRefund } = await plan(refund.id);
    expect(feeRefund).toMatchObject({ amount: usdc(1n), status: 'owed' });
  });

  it('CHAINOPS-FEE-004: is due seven days after the leg refund', async () => {
    const { legRefund: refund } = await recordRefund();
    const { feeRefund } = await plan(refund.id);
    expect(feeRefund.dueAt.getTime() - refund.createdAt.getTime()).toBe(SEVEN_DAYS_MS);
  });

  it('keys it on the leg refund', async () => {
    const { legRefund: refund } = await recordRefund();
    const { feeRefund } = await plan(refund.id);
    expect(feeRefund.idempotencyKey.toString('hex')).toBe(
      createHash('sha256').update(`ujira/fee-refund/v1${refund.id}`, 'utf8').digest('hex'),
    );
  });

  it('refuses a row whose key is not the one for its leg refund', async () => {
    const { legRefund: refund } = await recordRefund();
    const attempt = admin.query(
      `insert into ujira.fee_refunds
         (principal_id, project_id, leg_refund_id, payout_id, attempt_id, chain, asset, scale, amount,
          from_address, to_address, idempotency_key, due_at)
       select r.principal_id, r.project_id, r.id, r.payout_id, r.attempt_id, r.chain, r.asset, r.scale,
              1, 'GFEE', 'GPRINCIPAL', $2, now()
         from ujira.leg_refunds as r where r.id = $1`,
      [refund.id, randomBytes(32)],
    );
    expect(await codeOf(attempt)).toBe('23514');
  });

  // Each share alone rounds up, 15_001 and 10_001, which would return 25_002 of a fee of
  // 25_001 without the cap.
  it('CHAINOPS-FEE-004: two partial refunds that together refund the total return exactly the fee', async () => {
    const made = await makeAttempt(25_001n);
    const first = await recordRefund({ payoutLegId: made.firstLegId, amount: FIRST_LEG });
    const second = await recordRefund({ payoutLegId: made.secondLegId, amount: SECOND_LEG });
    expect((await plan(first.legRefund.id)).feeRefund.amount).toEqual(usdc(15_001n));
    expect((await plan(second.legRefund.id)).feeRefund.amount).toEqual(usdc(10_000n));
  });

  it('CHAINOPS-FEE-004: returns exactly the fee however a whole refund splits', async () => {
    const amounts = [1n, 7n, 999_999n, FIRST_LEG - 1_000_007n];
    let returned = 0n;
    for (const amount of amounts) {
      const { legRefund: refund } = await recordRefund({ amount });
      returned += (await plan(refund.id)).feeRefund.amount.amount;
    }
    const last = await recordRefund({ payoutLegId: secondLegId, amount: SECOND_LEG });
    returned += (await plan(last.legRefund.id)).feeRefund.amount.amount;
    expect(returned).toBe(FEE);
  });

  it('CHAINOPS-FEE-004: racing refunds share the same cap', async () => {
    const fee = 3n;
    const made = await makeAttempt(fee);
    const recorded = [];
    for (let index = 0; index < 8; index += 1) {
      recorded.push(await recordRefund({ payoutLegId: made.firstLegId, amount: 1n }));
    }
    const results = await Promise.all(recorded.map(async (item) => plan(item.legRefund.id)));
    const owed = results.filter((result) => result.feeRefund.status === 'owed');
    expect(owed).toHaveLength(3);
    expect(results.reduce((sum, result) => sum + result.feeRefund.amount.amount, 0n)).toBe(fee);
    expect(results.filter((result) => result.feeRefund.status === 'not_owed')).toHaveLength(5);
  });

  it('a retry finds its first share, even after the fee has been used up', async () => {
    const made = await makeAttempt(1n);
    const first = await recordRefund({ payoutLegId: made.firstLegId, amount: 1n });
    const second = await recordRefund({ payoutLegId: made.firstLegId, amount: 1n });
    expect((await plan(first.legRefund.id)).feeRefund.amount).toEqual(usdc(1n));
    expect((await plan(second.legRefund.id)).feeRefund.amount).toEqual(usdc(0n));
    const again = await plan(first.legRefund.id);
    expect(again.created).toBe(false);
    expect(again.feeRefund.amount).toEqual(usdc(1n));
  });

  it('owes nothing when the attempt had no fee', async () => {
    const made = await makeAttempt(0n);
    const { legRefund: refund } = await recordRefund({ payoutLegId: made.firstLegId });
    const { feeRefund } = await plan(refund.id);
    expect(feeRefund).toMatchObject({ amount: usdc(0n), status: 'not_owed' });
  });

  it('refuses to owe a refund from an address nobody knows yet', async () => {
    // A tenant whose instance has reported no fee address.
    fixture = await payoutFixture(db);
    termsId = await feeTerms(db, fixture);
    const made = await makeAttempt(FEE);
    const { legRefund: refund } = await recordRefund({ payoutLegId: made.firstLegId });
    await expect(plan(refund.id)).rejects.toBeInstanceOf(FeeAddressUnknownError);
  });

  it('50 parallel planFeeRefund calls create one row', async () => {
    const { legRefund: refund } = await recordRefund();
    const results = await Promise.all(Array.from({ length: 50 }, async () => plan(refund.id)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.feeRefund.id)).size).toBe(1);
    const rows = await admin.query('select id from ujira.fee_refunds where leg_refund_id = $1', [
      refund.id,
    ]);
    expect(rows.rowCount).toBe(1);
  });
});

describe('the bound on fee refunds', () => {
  it('UJ009', async () => {
    const first = await recordRefund({ amount: 1n });
    const second = await recordRefund({ amount: 1n });
    expect(await codeOf(insertFeeRefund(first.legRefund.id, FEE + 1n))).toBe('UJ009');

    await insertFeeRefund(first.legRefund.id, FEE);
    expect(await codeOf(insertFeeRefund(second.legRefund.id, 1n))).toBe('UJ009');
  });

  // A debt cannot be forgiven by moving its status, so not_owed means nothing to send.
  it.each([
    ['owes nothing while still owed', 0n, 'owed'],
    ['says not owed while owing', 1n, 'not_owed'],
  ])('refuses a row that %s', async (_name, amount, status) => {
    const { legRefund: refund } = await recordRefund();
    const attempt = admin.query(
      `insert into ujira.fee_refunds
         (principal_id, project_id, leg_refund_id, payout_id, attempt_id, chain, asset, scale, amount,
          from_address, to_address, status, idempotency_key, due_at)
       select r.principal_id, r.project_id, r.id, r.payout_id, r.attempt_id, r.chain, r.asset, r.scale,
              $2::numeric, 'GFEE', 'GPRINCIPAL', $3,
              sha256(convert_to('ujira/fee-refund/v1' || r.id::text, 'UTF8')), now()
         from ujira.leg_refunds as r where r.id = $1`,
      [refund.id, amount.toString(), status],
    );
    expect(await codeOf(attempt)).toBe('23514');
  });

  it('cannot be deleted, by anyone', async () => {
    const { legRefund: refund } = await recordRefund();
    const { feeRefund } = await plan(refund.id);
    expect(
      await codeOf(admin.query('delete from ujira.fee_refunds where id = $1', [feeRefund.id])),
    ).toBe('UJ002');
  });
});

// The queue's overdue job reads this table through its own role. That job arrives with
// the job queue, and this holds either way round.
describe('the overdue cron', () => {
  it('finds an overdue refund once the function exists', async () => {
    const found = await admin.query<{ fn: string | null }>(
      `select to_regprocedure('ujira.overdue_fee_refunds(integer)')::text as fn`,
    );
    if (found.rows[0]?.fn === null) return;
    const { legRefund: refund } = await recordRefund();
    const { feeRefund } = await plan(refund.id);
    await admin.query('begin');
    try {
      await admin.query('set local session_replication_role = replica');
      await admin.query(`update ujira.fee_refunds set due_at = '2020-01-01' where id = $1`, [
        feeRefund.id,
      ]);
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }
    const app = new pg.Client({ connectionString: new URL(database.url).toString() });
    await app.connect();
    try {
      await app.query('set role ujira_app');
      const due = await app.query<{ fee_refund_id: string }>(
        'select fee_refund_id from ujira.overdue_fee_refunds(500)',
      );
      expect(due.rows.map((row) => row.fee_refund_id)).toContain(feeRefund.id);
    } finally {
      await app.end();
    }
  });
});
