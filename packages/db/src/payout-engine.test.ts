// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the payout advance job asks of the database, as the rules the database itself
// holds, whatever the job does.

import { moneyAt } from '@ujira/core';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { payoutEngine } from './repositories/payout-engine.js';
import { liveLegs, payoutLegs } from './repositories/payout-legs.js';
import {
  AttemptWithoutLegsError,
  fundingHolds,
  payoutAttempts,
  payoutBatches,
  payouts,
  type PayoutAttempt,
} from './repositories/payouts.js';
import { payoutMethods } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newAttempt,
  newLeg,
  newPayout,
  ONE_USDC,
  payoutFixture,
  TESTNET,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TOTAL = 5n * ONE_USDC;

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

const inTenant = <T>(work: Parameters<ReturnType<Database['tenant']>['transaction']>[0]) =>
  db.tenant(fixture.tenant).transaction(work) as Promise<T>;

async function attemptWith(
  overrides: Parameters<typeof newAttempt>[2] = {},
): Promise<PayoutAttempt> {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) => payoutAttempts.create(tx, newAttempt(fixture, payoutId, overrides)));
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

describe('ending a payout', () => {
  it('keeps the code, from where it was', async () => {
    const ended = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutEngine.end(tx, payoutId, { from: 'received', to: 'rejected', code: 'NO_ROUTE' }),
      );
    expect(ended).toBe(true);
    const code = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutEngine.refusalCode(tx, payoutId));
    expect(code).toBe('NO_ROUTE');
  });

  it('moves nothing from anywhere else, so of two runs one loses', async () => {
    const ended = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutEngine.end(tx, payoutId, { from: 'routed', to: 'failed', code: 'NOPE' }),
      );
    expect(ended).toBe(false);
  });

  it('has no code until there is one, and refuses one of any other shape', async () => {
    const none = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutEngine.refusalCode(tx, payoutId));
    expect(none).toBeUndefined();
    expect(
      await codeOf(
        db
          .tenant(fixture.tenant)
          .transaction(async (tx) => payoutEngine.noteRefusal(tx, payoutId, 'not a code')),
      ),
    ).toBe('23514');
  });

  it('can note a refusal on a payout that goes on', async () => {
    const noted = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutEngine.noteRefusal(tx, payoutId, 'TRANSFER_FAILED'));
    expect(noted).toBe(true);
    const payout = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.get(tx, payoutId));
    expect(payout?.status).toBe('received');
  });
});

describe('marking a payout as waiting on a network', () => {
  it('only touches one that is received and waiting on nothing else', async () => {
    const marked = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutEngine.markUnavailable(tx, payoutId));
    expect(marked).toBe(true);
    expect(
      await db.tenant(fixture.tenant).transaction(async (tx) => payouts.get(tx, payoutId)),
    ).toMatchObject({ status: 'received', statusReason: 'network_unavailable' });

    await db.tenant(fixture.tenant).transaction(async (tx) => {
      await fundingHolds.hold(tx, payoutId, [
        { mandateInstanceId: fixture.instanceId, network: TESTNET, needed: usdc(1n) },
      ]);
    });
    const held = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutEngine.markUnavailable(tx, payoutId));
    expect(held).toBe(false);
  });
});

describe('what the job reads', () => {
  it('finds the idempotency key and the instance, or nothing', async () => {
    const found = await db.tenant(fixture.tenant).transaction(async (tx) => ({
      key: await payoutEngine.idempotencyKey(tx, payoutId),
      instance: await payoutEngine.instance(tx, fixture.instanceId),
      all: await payoutEngine.instancesOfMandate(tx, fixture.mandateId),
      noKey: await payoutEngine.idempotencyKey(tx, fixture.instanceId),
      noInstance: await payoutEngine.instance(tx, payoutId),
    }));
    expect(found.key?.length).toBeGreaterThan(0);
    expect(found.instance?.id).toBe(fixture.instanceId);
    expect(found.all.map((one) => one.id)).toEqual([fixture.instanceId]);
    expect(found.noKey).toBeUndefined();
    expect(found.noInstance).toBeUndefined();
  });

  it('sets the total, once it is known', async () => {
    const total = usdc(TOTAL);
    const moved = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutEngine.setTotal(tx, payoutId, total));
    expect(moved).toBe(true);
    const payout = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.get(tx, payoutId));
    expect(payout?.total?.amount).toBe(TOTAL);
  });

  it("lists a recipient's methods and a batch's items, a page at a time", async () => {
    const page = await db.tenant(fixture.tenant).transaction(async (tx) => ({
      methods: await payoutMethods.forRecipient(tx, fixture.recipientId, 10),
      batch: await payoutBatches.create(tx, {
        idempotencyKey: 'batch-page',
        items: [
          newPayout(fixture, { idempotencyKey: 'batch-page-1' }),
          newPayout(fixture, { idempotencyKey: 'batch-page-2' }),
        ],
      }),
    }));
    // The fixture gives its recipient a method for each possible leg.
    expect(page.methods.map((method) => method.id)).toEqual(
      fixture.methods.map((method) => method.id).sort(),
    );
    const first = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutBatches.items(tx, page.batch.batch.id, fixture.mandateId, { limit: 1 }),
      );
    expect(first.items).toHaveLength(1);
    const after = first.next ?? '';
    const second = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutBatches.items(tx, page.batch.batch.id, fixture.mandateId, { limit: 1, after }),
      );
    expect(second.items).toHaveLength(1);
    expect(second.next).toBeNull();
  });
});

describe('what is routed and not yet requested', () => {
  const unrequested = async (): Promise<bigint> =>
    db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutEngine.unrequestedOn(tx, fixture.instanceId));

  it('counts the total and the take of an attempt at created', async () => {
    expect(await unrequested()).toBe(0n);
    await attemptWith({ fee: usdc(ONE_USDC) });
    expect(await unrequested()).toBe(TOTAL + ONE_USDC);
  });

  it('stops counting once it is requested', async () => {
    const attempt = await attemptWith();
    await db.tenant(fixture.tenant).transaction(async (tx) => {
      await payoutAttempts.transition(tx, attempt.id, { from: 'created', to: 'requested' });
    });
    expect(await unrequested()).toBe(0n);
  });

  it('stops counting once the payout has ended, which will never request it', async () => {
    await attemptWith();
    await db.tenant(fixture.tenant).transaction(async (tx) => {
      await payouts.transition(tx, payoutId, { from: 'received', to: 'failed' });
    });
    expect(await unrequested()).toBe(0n);
  });
});

describe('what a cash-out records on a leg', () => {
  const delivery = {
    receive: moneyAt(119_000n, 'NGN', 2),
    fxNumerator: 2n,
    fxDenominator: 1_000n,
    costBearer: 'recipient' as const,
    quoteId: 'quote-1',
  };

  it('reads back whole, with the rail and the take', async () => {
    const attempt = await attemptWith({
      fee: usdc(ONE_USDC),
      legs: [{ ...newLeg(fixture, TOTAL), rail: 'some.rail', fee: 7n, delivery }],
    });
    expect(attempt.fee.amount).toBe(ONE_USDC);
    const [leg] = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutLegs.forAttempt(tx, attempt.id));
    expect(leg?.rail).toBe('some.rail');
    expect(leg?.fee.amount).toBe(7n);
    expect(leg?.delivery).toMatchObject({
      fxNumerator: 2n,
      fxDenominator: 1_000n,
      costBearer: 'recipient',
      quoteId: 'quote-1',
    });
    expect(leg?.delivery?.receive).toMatchObject({ amount: 119_000n, currency: 'NGN', scale: 2 });
  });

  it('is nothing at all on a leg straight to a wallet', async () => {
    const attempt = await attemptWith();
    const [leg] = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutLegs.forAttempt(tx, attempt.id));
    expect(leg?.delivery).toBeNull();
    expect(leg?.rail).toBeNull();
    expect(attempt.fee.amount).toBe(0n);
  });
});

describe('replacing the legs of an attempt', () => {
  const replace = async (attempt: PayoutAttempt, amounts: readonly bigint[]) =>
    db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutAttempts.replaceLegs(
        tx,
        attempt,
        amounts.map((amount) => newLeg(fixture, amount)),
      ),
    );

  const legsOf = async (attempt: PayoutAttempt) =>
    db.tenant(fixture.tenant).transaction(async (tx) => payoutLegs.forAttempt(tx, attempt.id));

  it('cancels the old legs, keeps them, and numbers the new one after them', async () => {
    const attempt = await attemptWith({
      legs: [newLeg(fixture, ONE_USDC), newLeg(fixture, TOTAL - ONE_USDC)],
    });
    expect(await replace(attempt, [TOTAL])).toBe(true);
    const legs = await legsOf(attempt);
    expect(legs.map((leg) => [leg.index, leg.status])).toEqual([
      [0, 'cancelled'],
      [1, 'cancelled'],
      [2, 'planned'],
    ]);
    expect(liveLegs(legs).map((leg) => leg.amount.amount)).toEqual([TOTAL]);
  });

  it('still refuses new legs that do not sum to the total', async () => {
    const attempt = await attemptWith();
    expect(await codeOf(replace(attempt, [TOTAL - 1n]))).toBe('UJ005');
    // Rolled back, so the first legs stand.
    expect(liveLegs(await legsOf(attempt))).toHaveLength(1);
  });

  it('refuses a fifth live leg, however they got there', async () => {
    const attempt = await attemptWith();
    expect(await codeOf(replace(attempt, [1n, 1n, 1n, 1n, TOTAL - 4n]))).toBe('23514');
  });

  it('refuses no legs at all', async () => {
    const attempt = await attemptWith();
    await expect(replace(attempt, [])).rejects.toBeInstanceOf(AttemptWithoutLegsError);
  });

  it('does nothing once the attempt has moved on, when the chain may know its legs', async () => {
    const attempt = await attemptWith();
    await db.tenant(fixture.tenant).transaction(async (tx) => {
      await payoutAttempts.transition(tx, attempt.id, { from: 'created', to: 'requested' });
    });
    expect(await replace(attempt, [TOTAL])).toBe(false);
    expect(await legsOf(attempt)).toHaveLength(1);
  });

  it('still never deletes a leg', async () => {
    const attempt = await attemptWith();
    expect(
      await codeOf(
        inTenant(async (tx) => {
          await tx.deleteFrom('ujira.payout_legs').where('attempt_id', '=', attempt.id).execute();
        }),
      ),
    ).toBeDefined();
    expect(await legsOf(attempt)).toHaveLength(1);
  });
});
