// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What happens to a split when one of its legs cannot go. Before anything is requested
// the same attempt goes to the main method. After, the chain holds a request that cannot
// execute, so it is cancelled and a new attempt pays the main method alone.

import {
  payoutAttempts,
  payoutEngine,
  payoutLegs,
  type Payout,
  type PayoutAttempt,
  type PayoutLeg,
} from '@ujira/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workerHarness, type WorkerHarness } from '../worker/testing/support.js';
import { ENGINE_TIMING } from './advance.js';
import type { LegShare } from './plan.js';
import {
  engineWorld,
  Killed,
  killing,
  ONE_USDC,
  seedTenant,
  TENANT,
  usdc,
  type EngineWorld,
} from './testing/world.js';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  await seedTenant(harness);
});

afterAll(async () => {
  await harness.close();
});

const SPLIT: readonly LegShare[] = [
  { method: 'stellar_wallet', currency: 'USDC', weight: 4n },
  { method: 'bank', currency: 'NGN', weight: 5n },
];

const delivered = [{ afterSeconds: 0, state: 'delivered', rawStatus: 'completed' }];

const attemptsOf = async (payout: Payout): Promise<readonly PayoutAttempt[]> =>
  harness.db.tenant(TENANT).transaction(async (tx) => payoutAttempts.forPayout(tx, payout.id));

const legsOf = async (attempt: PayoutAttempt | undefined): Promise<readonly PayoutLeg[]> =>
  harness.db.tenant(TENANT).transaction(async (tx) => payoutLegs.forAttempt(tx, attempt?.id ?? ''));

async function splitWorld(): Promise<EngineWorld> {
  const world = await engineWorld(harness, {
    anchor: true,
    anchorSteps: delivered,
    overrides: { splitOf: () => Promise.resolve(SPLIT) },
  });
  return world;
}

describe('leg fallback', () => {
  it('anchor down before request re-allocates in the same attempt', async () => {
    const world = await splitWorld();
    await world.addAllowedMethod('bank', 'bank-destination');
    const before = await world.balanceOfRecipient();
    const total = 9n * ONE_USDC;
    const payout = await world.payout('anchor-down', usdc(total));

    // Nothing reaches the chain, so the attempt sits at created with both its legs.
    world.h.faults?.signerDown(true);
    await world.run(payout);
    const [first] = await attemptsOf(payout);
    expect(first?.status).toBe('created');
    expect((await legsOf(first)).map((leg) => leg.method)).toEqual(['stellar_wallet', 'bank']);

    world.h.world.net.faults.anchorScript(null);
    world.h.faults?.signerDown(false);
    const paid = await world.drive(payout);
    expect(paid.status).toBe('paid');

    const attempts = await attemptsOf(payout);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.id).toBe(first?.id);
    expect(attempts[0]?.onChainPayoutId).toBe(first?.onChainPayoutId);
    const legs = await legsOf(attempts[0]);
    expect(legs.map((leg) => [leg.method, leg.status])).toEqual([
      ['stellar_wallet', 'cancelled'],
      ['bank', 'cancelled'],
      ['stellar_wallet', 'delivered'],
    ]);
    expect(legs[2]?.amount.amount).toBe(total);
    expect(world.executed(attempts[0]?.onChainPayoutId ?? '')).toBe(1);
    expect((await world.balanceOfRecipient()) - before).toBe(total);
  });

  it('leaves a split alone when the chain already knows its request', async () => {
    const world = await splitWorld();
    await world.addAllowedMethod('bank', 'bank-destination');
    const payout = await world.payout('already-there', usdc(9n * ONE_USDC));
    await world.run(payout);
    const [attempt] = await attemptsOf(payout);
    expect(attempt?.status).toBe('requested');
    expect(await legsOf(attempt)).toHaveLength(2);
    world.h.world.net.faults.anchorScript(null);
    await world.run(payout);
    expect(await legsOf(attempt)).toHaveLength(2);
    expect(await attemptsOf(payout)).toHaveLength(1);
  });

  it('retries when the main method is what is down', async () => {
    const world = await engineWorld(harness, { anchor: true, anchorSteps: delivered });
    await world.addAllowedMethod('bank', 'bank-destination');
    const payout = await world.payout('main-down', usdc(6n * ONE_USDC), { method: 'bank' });
    world.h.faults?.signerDown(true);
    await world.run(payout);
    const [first] = await attemptsOf(payout);
    world.h.world.net.faults.anchorScript(null);
    world.h.faults?.signerDown(false);
    await world.run(payout);
    // A single leg has nowhere else to go, so it stays and waits for the rail.
    expect(await legsOf(first)).toHaveLength(1);
    expect((await legsOf(first))[0]?.status).toBe('planned');
  });

  it('TRANSFER_FAILED leads to cancel and a new single-leg attempt', async () => {
    const world = await splitWorld();
    // The bank leg's destination is one the transfer to fails, and the wallet's is not.
    const failing = await world.addAllowedMethod('bank', 'bank-destination');
    const before = await world.balanceOfRecipient();
    const total = 9n * ONE_USDC;
    const payout = await world.payout('transfer-failed', usdc(total));

    await world.run(payout);
    const [attempt] = await attemptsOf(payout);
    expect(attempt?.status).toBe('requested');
    expect(await legsOf(attempt)).toHaveLength(2);

    world.h.world.net.faults.transferFails(failing.value);
    const paid = await world.drive(payout, { runs: 25 });
    expect(paid.status).toBe('paid');

    const attempts = await attemptsOf(payout);
    expect(attempts.map((one) => one.status)).toEqual(['dead', 'final']);
    expect(attempts[0]?.deadProof).toMatchObject({ kind: 'tombstone', status: 'cancelled' });
    expect(attempts[0]?.onChainPayoutId).not.toBe(attempts[1]?.onChainPayoutId);
    expect(world.executed(attempts[0]?.onChainPayoutId ?? '')).toBe(0);
    expect(world.executed(attempts[1]?.onChainPayoutId ?? '')).toBe(1);

    const legs = await legsOf(attempts[1]);
    expect(legs.map((leg) => [leg.method, leg.amount.amount])).toEqual([['stellar_wallet', total]]);
    expect((await world.balanceOfRecipient()) - before).toBe(total);
    expect(
      await harness.db
        .tenant(TENANT)
        .transaction(async (tx) => payoutEngine.refusalCode(tx, payout.id)),
    ).toBe('TRANSFER_FAILED');
  });

  it('a single leg whose transfer fails goes to a person, not round again', async () => {
    const world = await engineWorld(harness);
    const first = world.m.recipients[0];
    if (first === undefined) throw new Error('no recipient');
    const payout = await world.payout('single-failed', usdc(2n * ONE_USDC));
    await world.run(payout);
    world.h.world.net.faults.transferFails(first.address.value);
    await world.h.advance(6n);
    await world.run(payout);
    const attempts = await attemptsOf(payout);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).not.toBe('dead');
    expect(attempts.length).toBeLessThanOrEqual(ENGINE_TIMING.maxAttempts);
  });

  it('pays nothing twice when the job dies around a re-allocation', async () => {
    const world = await splitWorld();
    await world.addAllowedMethod('bank', 'bank-destination');
    const before = await world.balanceOfRecipient();
    const total = 9n * ONE_USDC;
    const payout = await world.payout('kill-reallocate', usdc(total));
    world.h.faults?.signerDown(true);
    await world.run(payout);
    world.h.world.net.faults.anchorScript(null);
    world.h.faults?.signerDown(false);
    for (let point = 1; point <= 8; point += 1) {
      await world.run(payout, { deps: killing(world.deps, point).deps }).catch((error: unknown) => {
        if (!(error instanceof Killed)) throw error;
      });
      await world.h.advance(6n);
    }
    expect((await world.drive(payout)).status).toBe('paid');
    const attempts = await attemptsOf(payout);
    expect(attempts).toHaveLength(1);
    expect(world.executed(attempts[0]?.onChainPayoutId ?? '')).toBe(1);
    expect((await world.balanceOfRecipient()) - before).toBe(total);
  });
});
