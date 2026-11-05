// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Nothing below a minimum reaches the adapter's pay, whichever minimum it is, and the
// minimum is read on what would actually be sent.

import { money } from '@ujira/core';
import { payoutAttempts, payoutEngine, payoutLegs, type Payout } from '@ujira/db';
import { adminQuery } from '@ujira/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { workerHarness, type WorkerHarness } from '../worker/testing/support.js';
import { engineWorld, ONE_USDC, seedTenant, TENANT, usdc } from './testing/world.js';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  await seedTenant(harness);
});

afterAll(async () => {
  await harness.close();
});

afterEach(async () => {
  await adminQuery(
    harness.database.url,
    `update ujira.projects set cashout_cost_bearer = 'recipient' where id = $1`,
    [TENANT.projectId],
  );
});

const refusalOf = async (payout: Payout): Promise<string | undefined> =>
  harness.db.tenant(TENANT).transaction(async (tx) => payoutEngine.refusalCode(tx, payout.id));

describe('minimums', () => {
  it('a leg below its minimum never reaches pay', async () => {
    const world = await engineWorld(harness, {
      // The month's network budget is spent, so the break-even total now applies. It
      // came after the payout was made, so nothing stopped it at the door.
      overrides: {
        minimumContext: () => ({
          breakEvenMinimum: { amount: 10n * ONE_USDC, currency: 'USDC', scale: 7 },
        }),
      },
    });
    const payout = await world.payout('below', usdc(2n * ONE_USDC));
    await world.run(payout);
    const ended = await world.read(payout.id);
    expect(ended.status).toBe('rejected');
    expect(await refusalOf(payout)).toBe('AMOUNT_BELOW_MINIMUM');
    expect(world.pays).toHaveLength(0);
    const attempts = await harness.db
      .tenant(TENANT)
      .transaction(async (tx) => payoutAttempts.forPayout(tx, payout.id));
    expect(attempts).toHaveLength(0);
  });

  it('principal mode checks the grossed-up leg', async () => {
    const world = await engineWorld(harness, { anchor: true });
    await world.addMethod('bank');
    await adminQuery(
      harness.database.url,
      `update ujira.projects set cashout_cost_bearer = 'principal' where id = $1`,
      [TENANT.projectId],
    );
    // 10000 kobo sells for 5500000 raw, or 0.55 USDC, under the 5.00 floor for a bank. The
    // local amount says nothing about that, so only the grossed-up leg can show it.
    const payout = await world.payout('below-gross', money(10_000n, 'NGN'), {
      method: 'bank',
      minimum: { toUsd: () => ({ amount: 1_000_000_000n, currency: 'USD', scale: 2 }) },
    });
    await world.run(payout);
    expect((await world.read(payout.id)).status).toBe('rejected');
    expect(await refusalOf(payout)).toBe('AMOUNT_BELOW_MINIMUM');
    expect(world.quotes).toHaveLength(1);
    expect(world.pays).toHaveLength(0);
  });

  it('a split leg below its minimum collapses to the main method', async () => {
    const world = await engineWorld(harness, {
      anchor: true,
      overrides: {
        splitOf: () =>
          Promise.resolve([
            { method: 'stellar_wallet', currency: 'USDC', weight: 9n },
            { method: 'mobile_money', currency: 'NGN', weight: 1n },
          ]),
      },
    });
    await world.addMethod('mobile_money');
    const before = await world.balanceOfRecipient();
    // A tenth of 5.00 is 0.50, under the 2.00 floor for mobile money.
    const payout = await world.payout('split-below', usdc(5n * ONE_USDC));
    const paid = await world.drive(payout);
    expect(paid.status).toBe('paid');
    const legs = await harness.db.tenant(TENANT).transaction(async (tx) => {
      const [attempt] = await payoutAttempts.forPayout(tx, payout.id);
      return payoutLegs.forAttempt(tx, attempt?.id ?? '');
    });
    expect(legs.map((leg) => [leg.method, leg.amount.amount])).toEqual([
      ['stellar_wallet', 5n * ONE_USDC],
    ]);
    expect((await world.balanceOfRecipient()) - before).toBe(5n * ONE_USDC);
  });
});
