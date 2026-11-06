// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The zero fee fallback's records against real Postgres, as the real roles.
 *
 * - One decision per attempt and one invoice item per payout, held by unique constraints
 *   and not by the code, however many runs race.
 * - A resend is all or nothing: the old attempt dead with its proof, the new attempt and
 *   the invoice item. If any of it is refused, none of it happened.
 * - Nothing is sent again without a decision, or after the attempt reached final.
 * - The records are never edited, and one tenant cannot reach another's.
 * - The address alarm rings once per network until it is cleared.
 */

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  FeeAttemptLandedError,
  FeeAttemptUnknownError,
  FeeResendNotDecidedError,
  feeAddressAlarms,
  feeFallback,
} from './repositories/fee-fallback.js';
import { payoutLegs } from './repositories/payout-legs.js';
import { payoutAttempts, payouts } from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  ONE_USDC,
  TESTNET,
  newLeg,
  newPayout,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const FIVE = 5n * ONE_USDC;
const FEE = usdc(45_000n);
const PROOF = { kind: 'payout_lapsed', at: { ledgerOrBlock: 7n, finality: 'final' } };
const UNIQUE_VIOLATION = '23505';

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 8);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

function resendInput(chainId: string, fee = FEE) {
  return {
    failedOnChainId: chainId,
    proof: PROOF,
    fee,
    deadline: new Date(Date.now() + 3_600_000),
    chainIdFor: (attemptNumber: number) => `${chainId}:${String(attemptNumber)}`,
  };
}

/** A payout with one requested attempt, the state a fee failure happens in. */
async function failedAttempt(fixture: PayoutFixture) {
  const chainId = randomUUID();
  const { payoutId, attemptId } = await db.tenant(fixture.tenant).transaction(async (tx) => {
    const created = await payouts.create(tx, newPayout(fixture));
    const attempt = await payoutAttempts.create(tx, {
      payoutId: created.payout.id,
      mandateInstanceId: fixture.instanceId,
      network: TESTNET,
      total: usdc(FIVE),
      deadline: new Date(Date.now() + 3_600_000),
      onChainPayoutId: chainId,
      legs: [newLeg(fixture, 2n * ONE_USDC, 0), newLeg(fixture, 3n * ONE_USDC, 1)],
    });
    await payoutAttempts.transition(tx, attempt.id, { from: 'created', to: 'requested' });
    return { payoutId: created.payout.id, attemptId: attempt.id };
  });
  return { chainId, payoutId, attemptId };
}

async function decided(fixture: PayoutFixture) {
  const failed = await failedAttempt(fixture);
  await db.tenant(fixture.tenant).transaction((tx) => feeFallback.decide(tx, failed.chainId));
  return failed;
}

async function stateOf(fixture: PayoutFixture, payoutId: string) {
  return db.tenant(fixture.tenant).transaction(async (tx) => ({
    attempts: await payoutAttempts.forPayout(tx, payoutId),
    item: await feeFallback.unpaidForPayout(tx, payoutId),
  }));
}

async function countOf(table: string, payoutOrAttemptColumn: string, id: string) {
  const { rows } = await admin.query<{ count: string }>(
    `select count(*) from ${table} where ${payoutOrAttemptColumn} = $1`,
    [id],
  );
  return Number(rows[0]?.count);
}

describe('the decision', () => {
  it('is one row however many runs make it at once', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, attemptId } = await failedAttempt(fixture);
    const session = db.tenant(fixture.tenant);

    expect(await session.transaction((tx) => feeFallback.decided(tx, chainId))).toBe(false);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        session.transaction((tx) => feeFallback.decide(tx, chainId)),
      ),
    );

    expect(await session.transaction((tx) => feeFallback.decided(tx, chainId))).toBe(true);
    expect(await countOf('ujira.fee_resend_decisions', 'attempt_id', attemptId)).toBe(1);
  });

  it('is held to one row by the table itself', async () => {
    const fixture = await payoutFixture(db);
    const { attemptId } = await decided(fixture);
    await expect(
      admin.query(
        `insert into ujira.fee_resend_decisions (principal_id, project_id, attempt_id)
         values ($1, $2, $3)`,
        [fixture.tenant.principalId, fixture.tenant.projectId, attemptId],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it('refuses an on chain id no attempt has', async () => {
    const fixture = await payoutFixture(db);
    const session = db.tenant(fixture.tenant);
    await expect(
      session.transaction((tx) => feeFallback.decide(tx, randomUUID())),
    ).rejects.toBeInstanceOf(FeeAttemptUnknownError);
    await expect(
      session.transaction((tx) => feeFallback.decided(tx, randomUUID())),
    ).rejects.toBeInstanceOf(FeeAttemptUnknownError);
  });
});

describe('the resend', () => {
  it('kills the old attempt with its proof, and writes the new one and the invoice item', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId, attemptId } = await decided(fixture);

    const { attempt, created } = await db
      .tenant(fixture.tenant)
      .transaction((tx) => feeFallback.resend(tx, resendInput(chainId)));

    expect(created).toBe(true);
    expect(attempt).toMatchObject({
      attemptNumber: 2,
      status: 'created',
      onChainPayoutId: `${chainId}:2`,
      mandateInstanceId: fixture.instanceId,
      network: TESTNET,
      total: usdc(FIVE),
    });
    const { attempts, item } = await stateOf(fixture, payoutId);
    expect(attempts[0]).toMatchObject({ id: attemptId, status: 'dead' });
    expect(attempts[0]?.deadProof).toMatchObject({
      kind: 'payout_lapsed',
      at: { ledgerOrBlock: '7' },
    });
    expect(item).toMatchObject({ payoutId, attemptId, fee: FEE });
    const legsOf = (id: string) =>
      db.tenant(fixture.tenant).transaction((tx) => payoutLegs.forAttempt(tx, id));
    const strip = (legs: Awaited<ReturnType<typeof legsOf>>) =>
      legs.map((leg) => [leg.index, leg.payoutMethodId, leg.destinationAddress, leg.amount]);
    expect(strip(await legsOf(attempt.id))).toEqual(strip(await legsOf(attemptId)));
    expect(await legsOf(attempt.id)).toHaveLength(2);
  });

  it('gives one attempt and one invoice item however many runs race', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId } = await decided(fixture);
    const session = db.tenant(fixture.tenant);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        session.transaction((tx) => feeFallback.resend(tx, resendInput(chainId))),
      ),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.attempt.id)).size).toBe(1);
    const { attempts } = await stateOf(fixture, payoutId);
    expect(attempts).toHaveLength(2);
    expect(await countOf('ujira.unpaid_fee_items', 'payout_id', payoutId)).toBe(1);
  });

  it('gives a rerun the attempt the first run made', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId } = await decided(fixture);
    const session = db.tenant(fixture.tenant);
    const first = await session.transaction((tx) => feeFallback.resend(tx, resendInput(chainId)));
    const again = await session.transaction((tx) => feeFallback.resend(tx, resendInput(chainId)));
    expect(again).toEqual({ attempt: first.attempt, created: false });
    expect(await countOf('ujira.unpaid_fee_items', 'payout_id', payoutId)).toBe(1);
  });

  it('undoes everything when the invoice item is refused', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId, attemptId } = await decided(fixture);

    // The table refuses an invoice for nothing, after the attempts have been written.
    await expect(
      db
        .tenant(fixture.tenant)
        .transaction((tx) => feeFallback.resend(tx, resendInput(chainId, usdc(0n)))),
    ).rejects.toMatchObject({ code: '23514' });

    const { attempts, item } = await stateOf(fixture, payoutId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ id: attemptId, status: 'requested', deadProof: null });
    expect(item).toBeUndefined();
  });

  it('undoes everything when the transaction fails after it', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId } = await decided(fixture);
    const killed = new Error('worker killed');

    await expect(
      db.tenant(fixture.tenant).transaction(async (tx) => {
        await feeFallback.resend(tx, resendInput(chainId));
        throw killed;
      }),
    ).rejects.toBe(killed);

    const { attempts, item } = await stateOf(fixture, payoutId);
    expect(attempts.map((a) => a.status)).toEqual(['requested']);
    expect(item).toBeUndefined();
  });

  it('refuses an attempt nothing decided to send again', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId } = await failedAttempt(fixture);
    await expect(
      db.tenant(fixture.tenant).transaction((tx) => feeFallback.resend(tx, resendInput(chainId))),
    ).rejects.toBeInstanceOf(FeeResendNotDecidedError);
    expect((await stateOf(fixture, payoutId)).attempts.map((a) => a.status)).toEqual(['requested']);
  });

  it('never sends again an attempt that reached final', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId, attemptId } = await decided(fixture);
    await db.tenant(fixture.tenant).transaction(async (tx) => {
      await payoutAttempts.transition(tx, attemptId, { from: 'requested', to: 'executing' });
      await payoutAttempts.transition(tx, attemptId, { from: 'executing', to: 'final' });
    });

    await expect(
      db.tenant(fixture.tenant).transaction((tx) => feeFallback.resend(tx, resendInput(chainId))),
    ).rejects.toBeInstanceOf(FeeAttemptLandedError);

    const { attempts, item } = await stateOf(fixture, payoutId);
    expect(attempts).toHaveLength(1);
    expect(item).toBeUndefined();
  });

  it('keeps the first invoice item when the same payout fails on its fee again', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId, attemptId } = await decided(fixture);
    const session = db.tenant(fixture.tenant);
    const { attempt } = await session.transaction((tx) =>
      feeFallback.resend(tx, resendInput(chainId)),
    );
    const secondChainId = attempt.onChainPayoutId;
    if (secondChainId === null) throw new Error('the new attempt has an on chain id');

    await session.transaction((tx) => feeFallback.decide(tx, secondChainId));
    const third = await session.transaction((tx) =>
      feeFallback.resend(tx, resendInput(secondChainId, usdc(1n))),
    );

    expect(third.attempt.attemptNumber).toBe(3);
    const { item } = await stateOf(fixture, payoutId);
    expect(item).toMatchObject({ attemptId, fee: FEE });
    expect(await countOf('ujira.unpaid_fee_items', 'payout_id', payoutId)).toBe(1);
  });

  it('refuses a fee in another unit than the attempt', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId } = await decided(fixture);
    const other = { ...FEE, scale: 2 };
    await expect(
      db
        .tenant(fixture.tenant)
        .transaction((tx) => feeFallback.resend(tx, resendInput(chainId, other))),
    ).rejects.toThrow();
    expect((await stateOf(fixture, payoutId)).attempts).toHaveLength(1);
  });
});

describe('the records', () => {
  it('are held to one invoice item per payout by the table itself', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId, attemptId } = await decided(fixture);
    await db
      .tenant(fixture.tenant)
      .transaction((tx) => feeFallback.resend(tx, resendInput(chainId)));
    await expect(
      admin.query(
        `insert into ujira.unpaid_fee_items
           (principal_id, project_id, payout_id, attempt_id, amount, chain, asset, scale)
         values ($1, $2, $3, $4, 1, 'stellar', 'USDC', 7)`,
        [fixture.tenant.principalId, fixture.tenant.projectId, payoutId, attemptId],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it('are never edited or removed, even by the owner', async () => {
    const fixture = await payoutFixture(db);
    const { chainId, payoutId, attemptId } = await decided(fixture);
    await db
      .tenant(fixture.tenant)
      .transaction((tx) => feeFallback.resend(tx, resendInput(chainId)));
    for (const statement of [
      `update ujira.unpaid_fee_items set amount = 1 where payout_id = '${payoutId}'`,
      `delete from ujira.unpaid_fee_items where payout_id = '${payoutId}'`,
      `update ujira.fee_resend_decisions set decided_at = now() where attempt_id = '${attemptId}'`,
      `delete from ujira.fee_resend_decisions where attempt_id = '${attemptId}'`,
    ]) {
      await expect(admin.query(statement)).rejects.toThrow();
    }
  });

  it('cannot be reached from another tenant', async () => {
    const owner = await payoutFixture(db);
    const other = await payoutFixture(db);
    const { chainId, payoutId } = await decided(owner);
    const session = db.tenant(other.tenant);

    for (const attempt of [
      () => session.transaction((tx) => feeFallback.decide(tx, chainId)),
      () => session.transaction((tx) => feeFallback.decided(tx, chainId)),
      () => session.transaction((tx) => feeFallback.resend(tx, resendInput(chainId))),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(FeeAttemptUnknownError);
    }

    expect((await stateOf(owner, payoutId)).attempts.map((a) => a.status)).toEqual(['requested']);
  });
});

describe('the address alarm', () => {
  const asWorker = <T>(work: Parameters<Database['unscoped']>[0]) =>
    db.unscoped(work, 'worker') as Promise<T>;

  it('rings once per network however many raise it, until it is cleared', async () => {
    const network = `stellar:test-${randomUUID()}`;
    const raised = await Promise.all(
      Array.from({ length: 10 }, () =>
        asWorker<boolean>((tx) => feeAddressAlarms.raise(tx, network, 'NO_TRUSTLINE')),
      ),
    );
    expect(raised.filter(Boolean)).toHaveLength(1);

    const elsewhere = `stellar:test-${randomUUID()}`;
    expect(
      await asWorker<boolean>((tx) => feeAddressAlarms.raise(tx, elsewhere, 'NO_TRUSTLINE')),
    ).toBe(true);

    expect(await asWorker<boolean>((tx) => feeAddressAlarms.clear(tx, network))).toBe(true);
    expect(await asWorker<boolean>((tx) => feeAddressAlarms.clear(tx, network))).toBe(false);
    expect(
      await asWorker<boolean>((tx) => feeAddressAlarms.raise(tx, network, 'TRUSTLINE_LIMIT')),
    ).toBe(true);
  });

  it('is out of reach of a tenant session', async () => {
    const fixture = await payoutFixture(db);
    await expect(
      db
        .tenant(fixture.tenant)
        .transaction((tx) => feeAddressAlarms.raise(tx, TESTNET, 'NO_TRUSTLINE')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a reason it does not know', async () => {
    await expect(
      asWorker((tx) => feeAddressAlarms.raise(tx, TESTNET, 'BAD' as 'NO_TRUSTLINE')),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
