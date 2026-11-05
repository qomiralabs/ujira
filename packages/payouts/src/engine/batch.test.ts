// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The batch job on the real database and the fake chain.

import type { PayBatchRequest } from '@ujira/chain-adapter';
import {
  fundingHolds,
  payoutAttempts,
  payoutEngine,
  type Payout,
  type PayoutAttempt,
} from '@ujira/db';
import { adminQuery } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newTenant, workerHarness, type WorkerHarness } from '../worker/testing/support.js';
import { batchComplete, batchWork, enqueueBatchAdvance } from './batch.js';
import type { EngineDeps } from './plan.js';
import { releaseHeld } from './release.js';
import {
  engineWorld,
  Killed,
  killing,
  NETWORK,
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

const attemptsOf = async (payout: Payout): Promise<readonly PayoutAttempt[]> =>
  harness.db.tenant(TENANT).transaction(async (tx) => payoutAttempts.forPayout(tx, payout.id));

const executedOf = async (world: EngineWorld, payout: Payout): Promise<number> => {
  const attempts = await attemptsOf(payout);
  return attempts.reduce((sum, one) => sum + world.executed(one.onChainPayoutId ?? ''), 0);
};

// As the queue would run them: the batch job until it stops asking, then each item.
async function runBatch(
  world: EngineWorld,
  batchId: string,
  deps: EngineDeps = world.deps,
): Promise<void> {
  const work = batchWork(deps);
  for (let run = 0; run < 3; run += 1) {
    await work({
      context: TENANT,
      ids: { batchId, mandateId: world.mandateId },
      tryNumber: 1,
      signal: new AbortController().signal,
    });
    await world.h.advance(6n);
  }
}

describe('batch advance', () => {
  it('one rejected request item is recorded with its code', async () => {
    const world = await engineWorld(harness);
    const { batchId, payouts } = await world.batch('rejected', [
      usdc(2n * ONE_USDC),
      // Over the mandate's cap on one payment, which only the chain knows.
      usdc(11n * ONE_USDC),
      usdc(2n * ONE_USDC),
    ]);
    await runBatch(world, batchId);
    const [first, bad, last] = payouts;
    if (first === undefined || bad === undefined || last === undefined) throw new Error('items');
    expect(await world.read(bad.id)).toMatchObject({ status: 'failed' });
    expect(
      await harness.db
        .tenant(TENANT)
        .transaction(async (tx) => payoutEngine.refusalCode(tx, bad.id)),
    ).toBe('PAYMENT_CAP_EXCEEDED');
    expect(await executedOf(world, bad)).toBe(0);
    for (const good of [first, last]) {
      expect((await world.drive(good)).status).toBe('paid');
      expect(await executedOf(world, good)).toBe(1);
    }
  });

  it('bisected offender, 19 paid', async () => {
    const world = await engineWorld(harness);
    await world.addMethod('stellar_wallet', 1);
    const offenderAddress = world.m.recipients[1]?.address;
    if (offenderAddress === undefined) throw new Error('no second recipient');
    const before = await world.balanceOfRecipient();
    const { batchId, payouts } = await world.batch(
      'bisected',
      Array.from({ length: 20 }, () => usdc(ONE_USDC)),
      { secondRecipientAt: 7 },
    );
    world.h.world.net.faults.transferFails(offenderAddress.value);
    await runBatch(world, batchId);

    for (const call of world.batches as PayBatchRequest[]) {
      expect(call.items.length).toBeLessThanOrEqual(10);
    }
    const offender = payouts[7];
    if (offender === undefined) throw new Error('no offender');
    const others = payouts.filter((payout) => payout.id !== offender.id);
    for (const payout of others) {
      expect((await world.drive(payout)).status).toBe('paid');
      expect(await executedOf(world, payout)).toBe(1);
    }
    expect(others).toHaveLength(19);
    expect(await executedOf(world, offender)).toBe(0);
    expect((await world.read(offender.id)).status).not.toBe('paid');
    expect(
      await harness.db
        .tenant(TENANT)
        .transaction(async (tx) => payoutEngine.refusalCode(tx, offender.id)),
    ).toBe('TRANSFER_FAILED');
    expect((await world.balanceOfRecipient()) - before).toBe(19n * ONE_USDC);
  });

  it('held items release once each, oldest first, without over-committing', async () => {
    const world = await engineWorld(harness, { fund: 0n });
    const { batchId, payouts } = await world.batch('held', [
      usdc(2n * ONE_USDC),
      usdc(2n * ONE_USDC),
      usdc(2n * ONE_USDC),
    ]);
    await runBatch(world, batchId);
    for (const payout of payouts) {
      expect(await world.read(payout.id)).toMatchObject({
        status: 'received',
        statusReason: 'awaiting_funding',
      });
      expect(await attemptsOf(payout)).toHaveLength(0);
    }
    expect(world.batches).toHaveLength(0);

    // Enough for two with their fees, and not the third.
    await world.h.fund(world.m.ref.address, 5n * ONE_USDC);
    // Two at once, as after a lost job lock, must still promise the funds only once.
    await Promise.all([
      releaseHeld(world.deps, TENANT, NETWORK, new AbortController().signal),
      releaseHeld(world.deps, TENANT, NETWORK, new AbortController().signal),
    ]);
    const attempts = await Promise.all(payouts.map(attemptsOf));
    expect(attempts.flat()).toHaveLength(2);
    for (const one of attempts) expect(one.length).toBeLessThanOrEqual(1);
    const paid = payouts.filter((_payout, index) => attempts[index]?.length === 1);
    for (const payout of paid) expect((await world.drive(payout)).status).toBe('paid');
  });

  it('held items release oldest first when the queue runs them one after the other', async () => {
    const world = await engineWorld(harness, { fund: 0n });
    const { batchId } = await world.batch('held-order', [
      usdc(2n * ONE_USDC),
      usdc(2n * ONE_USDC),
      usdc(2n * ONE_USDC),
    ]);
    await runBatch(world, batchId);
    await world.h.fund(world.m.ref.address, 5n * ONE_USDC);
    // One after the other, as the queue runs them.
    const order = await harness.db
      .tenant(TENANT)
      .transaction(async (tx) => fundingHolds.oldestOnNetwork(tx, NETWORK, 10));
    const mine = order.filter((hold) => hold.mandateInstanceId === world.instanceId);
    const [oldest, next, newest] = mine.map((hold) => hold.payoutId);
    if (oldest === undefined || next === undefined || newest === undefined) {
      throw new Error('items');
    }
    const first = await releaseHeld(world.deps, TENANT, NETWORK, new AbortController().signal);
    const second = await releaseHeld(world.deps, TENANT, NETWORK, new AbortController().signal);
    expect(first.released).toEqual([oldest, next]);
    expect(first.waiting).toContain(newest);
    expect(second.released).toHaveLength(0);
  });

  it('pays nothing twice, at every point a batch job can die', async () => {
    const measuring = await engineWorld(harness);
    const measured = killing(measuring.deps, 0);
    const clean = await measuring.batch('measure', [
      usdc(ONE_USDC),
      usdc(ONE_USDC),
      usdc(ONE_USDC),
    ]);
    await runBatch(measuring, clean.batchId, measured.deps);
    const points = measured.boundaries();
    expect(points).toBeGreaterThan(5);

    for (let point = 1; point <= points; point += 1) {
      const world = await engineWorld(harness);
      const before = await world.balanceOfRecipient();
      const { batchId, payouts } = await world.batch(`kill-${String(point)}`, [
        usdc(ONE_USDC),
        usdc(ONE_USDC),
        usdc(ONE_USDC),
      ]);
      const dying = killing(world.deps, point);
      const work = batchWork(dying.deps);
      for (let run = 0; run < 6; run += 1) {
        await work({
          context: TENANT,
          ids: { batchId, mandateId: world.mandateId },
          tryNumber: 1,
          signal: new AbortController().signal,
        }).catch((error: unknown) => {
          if (!(error instanceof Killed)) throw error;
        });
        await world.h.advance(6n);
      }
      for (const payout of payouts) {
        expect((await world.drive(payout)).status, `killed at ${String(point)}`).toBe('paid');
        expect(await attemptsOf(payout)).toHaveLength(1);
        expect(await executedOf(world, payout)).toBe(1);
      }
      expect((await world.balanceOfRecipient()) - before).toBe(3n * ONE_USDC);
    }
  }, 280_000);

  it('files one job for each mandate a batch names', async () => {
    const world = await engineWorld(harness);
    const other = await engineWorld(harness);
    const { batchId } = await world.batch('two-mandates', [usdc(ONE_USDC)]);
    await harness.db.tenant(TENANT).transaction(async (tx) => {
      await enqueueBatchAdvance(tx, batchId, [
        { mandateId: world.mandateId },
        { mandateId: world.mandateId },
        { mandateId: other.mandateId },
      ]);
    });
    const jobs = await adminQuery<{ queue_name: string }>(
      harness.database.url,
      `select queue_name from graphile_worker.jobs where key like $1`,
      [`%batch:${batchId}:%`],
    );
    const queues = jobs.map((job) => job.queue_name);
    expect(queues).toHaveLength(2);
    expect(queues).toContainEqual(expect.stringContaining(`mandate:${world.mandateId}`));
    expect(queues).toContainEqual(expect.stringContaining(`mandate:${other.mandateId}`));
  });

  it("reads nothing of another tenant's batch", async () => {
    const world = await engineWorld(harness);
    const { batchId, payouts } = await world.batch('other-tenant', [usdc(2n * ONE_USDC)]);
    const other = await newTenant(harness.db);
    await batchWork(world.deps)({
      context: other,
      ids: { batchId, mandateId: world.mandateId },
      tryNumber: 1,
      signal: new AbortController().signal,
    });
    expect(world.batches).toHaveLength(0);
    expect((await world.read(payouts[0]?.id ?? '')).status).toBe('received');
  });

  it('is complete when every item is terminal or on its way', () => {
    expect(batchComplete(['paid', 'failed', 'settling', 'submitting'])).toBe(true);
    expect(batchComplete(['paid', 'received'])).toBe(false);
    expect(batchComplete(['paid', 'routed'])).toBe(false);
    expect(batchComplete([])).toBe(true);
  });
});
