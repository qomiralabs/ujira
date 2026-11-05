// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What happens to a split when one of its legs cannot go. Before anything is requested
// the same attempt goes to the main method. After, the chain holds a request that cannot
// execute, so it is cancelled and a new attempt pays the main method alone.

import type { ChainAdapter, ChainAdapterRegistry } from '@ujira/chain-adapter';
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
import { batchWork } from './batch.js';
import type { EngineDeps, LegShare } from './plan.js';
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

// The mandates here give a payout a day before it lapses.
const MANDATE_TTL = 86_400n;

// Keeps each answer proveDead gives.
function provingWatched(registry: ChainAdapterRegistry, proofs: unknown[]): ChainAdapterRegistry {
  const watch = (real: ChainAdapter): ChainAdapter =>
    new Proxy(real, {
      get(on, property) {
        const value: unknown = Reflect.get(on, property);
        if (typeof value !== 'function') return value;
        if (property !== 'proveDead') return (value as () => unknown).bind(on);
        return async (...args: Parameters<ChainAdapter['proveDead']>) => {
          const proof = await on.proveDead(...args);
          proofs.push(proof);
          return proof;
        };
      },
    });
  return { get: (network) => watch(registry.get(network)), list: () => registry.list().map(watch) };
}

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

  // A split on chain whose bank leg's destination is one the transfer to fails.
  async function failedSplit(key: string, deps?: EngineDeps) {
    const world = await splitWorld();
    const failing = await world.addAllowedMethod('bank', 'bank-destination');
    const before = await world.balanceOfRecipient();
    const total = 9n * ONE_USDC;
    const payout = await world.payout(key, usdc(total));
    await world.run(payout);
    const [attempt] = await attemptsOf(payout);
    expect(attempt?.status).toBe('requested');
    expect(await legsOf(attempt)).toHaveLength(2);
    world.h.world.net.faults.transferFails(failing.value);
    await world.h.advance(6n);
    return { world, payout, attempt, before, total, deps };
  }

  const expectOnePaidOnTheMainMethod = async (
    world: EngineWorld,
    payout: Payout,
    before: bigint,
    total: bigint,
  ): Promise<void> => {
    expect((await world.read(payout.id)).status).toBe('paid');
    const attempts = await attemptsOf(payout);
    expect(attempts.map((one) => one.status)).toEqual(['dead', 'final']);
    expect(attempts[0]?.deadProof).toMatchObject({ kind: 'payout_lapsed' });
    expect(attempts[0]?.onChainPayoutId).not.toBe(attempts[1]?.onChainPayoutId);
    expect(world.executed(attempts[0]?.onChainPayoutId ?? '')).toBe(0);
    expect(world.executed(attempts[1]?.onChainPayoutId ?? '')).toBe(1);
    const legs = await legsOf(attempts[1]);
    expect(legs.map((leg) => [leg.method, leg.amount.amount])).toEqual([['stellar_wallet', total]]);
    expect((await world.balanceOfRecipient()) - before).toBe(total);
  };

  it('TRANSFER_FAILED leads to a lapse and a new single-leg attempt', async () => {
    const { world, payout, before, total } = await failedSplit('transfer-failed');
    await world.run(payout);
    expect(
      await harness.db
        .tenant(TENANT)
        .transaction(async (tx) => payoutEngine.refusalCode(tx, payout.id)),
    ).toBe('TRANSFER_FAILED');
    await world.h.advance(MANDATE_TTL + 60n);
    await world.drive(payout, { runs: 25 });
    await expectOnePaidOnTheMainMethod(world, payout, before, total);
  });

  it('retries only after a payout_lapsed proof, and never before', async () => {
    const { world, payout, attempt } = await failedSplit('never-before');
    await world.run(payout);
    const pays = world.pays.length;
    const proofs: unknown[] = [];
    const watching = {
      ...world.deps,
      adapters: provingWatched(world.deps.adapters, proofs),
    };
    // Past the attempt's own deadline, and on through the day, up to just short of expiry.
    for (const step of [3_700n, 40_000n, 40_000n, 2_000n]) {
      await world.h.advance(step);
      await world.run(payout, { deps: watching });
      const attempts = await attemptsOf(payout);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.id).toBe(attempt?.id);
      expect(attempts[0]?.status).toBe('requested');
      expect(attempts[0]?.deadProof).toBeNull();
    }
    // It looked, and found no proof, and asked nothing else of the chain.
    expect(proofs.length).toBeGreaterThanOrEqual(4);
    expect(proofs.every((proof) => proof === null)).toBe(true);
    expect(world.pays).toHaveLength(pays);
    expect(world.executed(attempt?.onChainPayoutId ?? '')).toBe(0);

    await world.h.advance(1_000n);
    await world.drive(payout, { deps: watching, runs: 25 });
    expect(proofs.find((proof) => proof !== null)).toMatchObject({ kind: 'payout_lapsed' });
    expect(await attemptsOf(payout)).toHaveLength(2);
  });

  it('never cancels', async () => {
    const { world, payout } = await failedSplit('no-cancel');
    await world.run(payout);
    await world.h.advance(MANDATE_TTL + 60n);
    await world.drive(payout, { runs: 25 });
    const cancelled = world.h.world.net.txs
      .flatMap((tx) => tx.events)
      .filter((event) => event.name === 'payout_cancelled');
    expect(cancelled).toHaveLength(0);
  });

  it('a clean rerun of every step still gives one attempt on the main method', async () => {
    const { world, payout, before, total } = await failedSplit('run-twice');
    await world.run(payout);
    await world.run(payout);
    await world.h.advance(MANDATE_TTL + 60n);
    for (let run = 0; run < 12; run += 1) {
      await world.run(payout);
      await world.run(payout);
      await world.h.advance(6n);
      if ((await world.read(payout.id)).status === 'paid') break;
    }
    await expectOnePaidOnTheMainMethod(world, payout, before, total);
  });

  it('a job killed at every step still gives one attempt on the main method', async () => {
    const clean = await failedSplit('kill-measure');
    const measured = killing(clean.world.deps, 0);
    await clean.world.run(clean.payout, { deps: measured.deps });
    await clean.world.h.advance(MANDATE_TTL + 60n);
    await clean.world.drive(clean.payout, { deps: measured.deps, runs: 25 });
    const points = measured.boundaries();
    expect(points).toBeGreaterThan(5);

    for (let point = 1; point <= points; point += 1) {
      const { world, payout, before, total } = await failedSplit(`kill-${String(point)}`);
      const dying = killing(world.deps, point);
      let lapsed = false;
      for (let run = 0; run < 25; run += 1) {
        if ((await world.read(payout.id)).status === 'paid') break;
        await world.run(payout, { deps: dying.deps }).catch((error: unknown) => {
          if (!(error instanceof Killed)) throw error;
        });
        // A few looks before the expiry, so a death can land on one of those too.
        if (run === 2 && !lapsed) {
          await world.h.advance(MANDATE_TTL + 60n);
          lapsed = true;
        }
        await world.h.advance(6n);
      }
      await expectOnePaidOnTheMainMethod(world, payout, before, total);
    }
  }, 280_000);

  it('a batch leaves a split waiting to lapse alone', async () => {
    const world = await splitWorld();
    const failing = await world.addAllowedMethod('bank', 'bank-destination');
    const { batchId, payouts } = await world.batch('waiting', [usdc(9n * ONE_USDC)]);
    const work = batchWork(world.deps);
    const job = {
      context: TENANT,
      ids: { batchId, mandateId: world.mandateId },
      tryNumber: 1,
      signal: new AbortController().signal,
    };
    await work(job);
    await world.h.advance(6n);
    world.h.world.net.faults.transferFails(failing.value);
    await work(job);
    const calls = world.batches.length;
    const refused = payouts[0];
    if (refused === undefined) throw new Error('no item');
    expect((await attemptsOf(refused))[0]?.status).toBe('requested');
    await world.h.advance(6n);
    await work(job);
    expect(world.batches).toHaveLength(calls);
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
