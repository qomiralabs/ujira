// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { payoutAttempts, payoutLegs, type Payout } from '@ujira/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workerHarness, type WorkerHarness } from '../worker/testing/support.js';
import {
  ATTEMPT_EDGES,
  LEG_EDGES,
  PAYOUT_EDGES,
  legStatusOf,
  pathTo,
  payoutAfterFinal,
} from './status.js';
import { engineWorld, ONE_USDC, seedTenant, TENANT, usdc } from './testing/world.js';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  await seedTenant(harness);
});

afterAll(async () => {
  await harness.close();
});

const liveLegsOf = async (payout: Payout) =>
  harness.db.tenant(TENANT).transaction(async (tx) => {
    const [attempt] = await payoutAttempts.forPayout(tx, payout.id);
    return payoutLegs.forAttempt(tx, attempt?.id ?? '');
  });

describe('the public status', () => {
  it('one leg delivered, one in transit is partly_paid', async () => {
    const world = await engineWorld(harness, {
      anchor: true,
      anchorSteps: [
        { afterSeconds: 0, state: 'in_transit', rawStatus: 'pending' },
        { afterSeconds: 600, state: 'delivered', rawStatus: 'completed' },
      ],
      overrides: {
        splitOf: () =>
          Promise.resolve([
            { method: 'stellar_wallet', currency: 'USDC', weight: 2n },
            { method: 'bank', currency: 'NGN', weight: 5n },
          ]),
      },
    });
    await world.addAllowedMethod('bank', 'bank-destination');
    const payout = await world.payout('partly', usdc(7n * ONE_USDC));
    for (let run = 0; run < 5; run += 1) {
      await world.run(payout);
      await world.h.advance(6n);
    }
    const partly = await world.read(payout.id);
    expect(partly.status).toBe('partly_paid');
    expect(partly.publicStatus).not.toBe('paid');
    expect((await liveLegsOf(payout)).map((leg) => leg.status)).toEqual([
      'delivered',
      'delivering',
    ]);

    await world.h.advance(700n);
    const paid = await world.drive(payout);
    expect(paid.status).toBe('paid');
    expect((await liveLegsOf(payout)).map((leg) => leg.status)).toEqual(['delivered', 'delivered']);
  });

  it('is paid only when every leg has arrived', () => {
    expect(payoutAfterFinal(['delivered', 'delivered'])).toBe('paid');
    expect(payoutAfterFinal(['delivered', 'delivering'])).toBe('partly_paid');
    expect(payoutAfterFinal(['delivering', 'delivering'])).toBe('delivering');
    expect(payoutAfterFinal([])).toBe('delivering');
  });

  it.each([
    ['not_applicable', 'delivered'],
    ['delivered', 'delivered'],
    ['awaiting_settlement', 'delivering'],
    ['in_transit', 'delivering'],
    ['action_required', 'delivering'],
    ['failed', 'failed'],
    ['refunded', 'failed'],
    ['expired', 'failed'],
  ] as const)('a leg whose delivery is %s is %s', (state, status) => {
    expect(legStatusOf(state)).toBe(status);
  });
});

describe('finding the way forward', () => {
  it('walks every step a job that died may have missed', () => {
    expect(pathTo(ATTEMPT_EDGES, 'created', 'final')).toEqual(['requested', 'executing', 'final']);
    expect(pathTo(PAYOUT_EDGES, 'routed', 'paid')).toEqual(['submitting', 'settling', 'paid']);
    expect(pathTo(LEG_EDGES, 'planned', 'delivered')).toEqual([
      'submitted',
      'settled',
      'delivered',
    ]);
  });

  it('moves nothing for a step already passed, or one beside it', () => {
    expect(pathTo(ATTEMPT_EDGES, 'final', 'requested')).toBeNull();
    expect(pathTo(ATTEMPT_EDGES, 'final', 'final')).toEqual([]);
    expect(pathTo(PAYOUT_EDGES, 'paid', 'settling')).toBeNull();
  });
});
