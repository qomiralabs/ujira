// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for funding holds and their release (hold.ts).
 *
 * - All candidate networks short means `received` with `awaiting_funding`, one
 *   hold row per network, and nothing requested on chain. The public status is
 *   queued, awaiting funding, with the funding needed.
 * - A deposit and the ten minute sweep only enqueue one deduplicated job per
 *   principal and network. The sweep never routes.
 * - The job releases oldest first per instance, with a running free balance
 *   starting from the chain's free less what is routed but not on chain yet.
 *   When funds run out, newer payouts on that instance wait too.
 * - Each release is one compare and set, so a payout routes exactly once
 *   however many jobs reach it. Rerunning a killed job is safe.
 * - A hold older than the project's maximum fails the payout with
 *   funding_hold_expired.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Uuid } from '@ujira/chain-adapter';

import {
  OTHER_SCOPE,
  PUB_NET,
  SCOPE,
  TEST_NET,
  WALLET_PUB,
  WALLET_TEST,
  routeWorld,
  usdc,
} from '../test/route-world.js';
import type { RouteWorld } from '../test/route-world.js';
import {
  DEFAULT_FUNDING_HOLD_MAX_SECONDS,
  RELEASE_TASK,
  SWEEP_INTERVAL_SECONDS,
  createMemoryFundingHoldStore,
  heldStatus,
  holdPayout,
  onDeposit,
  releaseJobSpec,
  runReleaseHeld,
  selectRoute,
  sweepFundingHolds,
} from './index.js';
import type { ReleaseDeps, ReleaseJobSpec, ReleaseQueue, RouteRequest } from './index.js';

const payoutId = (n: number): Uuid =>
  `50000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Uuid;
const TARGET_TEST = { ...SCOPE, network: TEST_NET };
const TARGET_PUB = { ...SCOPE, network: PUB_NET };
const HOUR = 3_600_000;

function recordingQueue(): ReleaseQueue & { readonly jobs: ReleaseJobSpec[] } {
  const jobs: ReleaseJobSpec[] = [];
  return {
    jobs,
    enqueue: (spec) => {
      jobs.push(spec);
      return Promise.resolve();
    },
  };
}

const walletRequest = (w: RouteWorld, total: bigint): RouteRequest =>
  w.request({
    total: usdc(total),
    legs: [{ method: 'stellar_wallet', currency: 'USDC', amount: usdc(total) }],
  });

/** Routes a payout and holds it, an hour after the one before. */
async function held(w: RouteWorld, n: number, total: bigint): Promise<RouteRequest> {
  const request = walletRequest(w, total);
  w.store.add(payoutId(n), request);
  const outcome = await selectRoute(request, w.deps);
  if (outcome.kind !== 'hold') throw new Error(`expected a hold, got ${outcome.kind}`);
  expect(await holdPayout(SCOPE, payoutId(n), outcome, { store: w.store })).toBe(true);
  w.now = new Date(w.now.getTime() + HOUR);
  return request;
}

function releaseDeps(w: RouteWorld): ReleaseDeps {
  return { store: w.store, route: w.deps, now: () => w.now };
}

async function emptyWorld(): Promise<RouteWorld> {
  const w = await routeWorld({ test: 0n, pub: 0n });
  w.fee = 0n;
  w.destinations = [WALLET_TEST];
  return w;
}

describe('hold', () => {
  it('held when short of funds', async () => {
    const w = await routeWorld({ test: 100n, pub: 200n });
    w.destinations = [WALLET_TEST, WALLET_PUB];
    const request = walletRequest(w, 1_000n);
    w.store.add(payoutId(1), request);
    const movesBefore = w.test.moves().length;

    const outcome = await selectRoute(request, w.deps);
    if (outcome.kind !== 'hold') throw new Error('expected a hold');
    expect(await holdPayout(SCOPE, payoutId(1), outcome, { store: w.store })).toBe(true);

    expect(w.store.payout(SCOPE, payoutId(1))).toMatchObject({
      status: 'received',
      statusReason: 'awaiting_funding',
      attempts: [],
    });
    // One row per candidate network, and nothing asked of the chain.
    expect(w.store.holdsOf(SCOPE, payoutId(1)).map((h) => [h.network, h.needed.amount])).toEqual([
      [TEST_NET, 910n],
      [PUB_NET, 810n],
    ]);
    expect(w.test.moves()).toHaveLength(movesBefore);
    expect(heldStatus(outcome.networks)).toEqual({
      status: 'queued',
      reason: 'awaiting_funding',
      fundingNeeded: usdc(810n),
    });
    // Holding again changes nothing.
    expect(await holdPayout(SCOPE, payoutId(1), outcome, { store: w.store })).toBe(false);
  });

  it('released oldest first on deposit', async () => {
    const w = await emptyWorld();
    await held(w, 1, 100n);
    await held(w, 2, 100n);
    await held(w, 3, 100n);
    const queue = recordingQueue();

    await w.test.fund(w.testMandate.ref.address, 200n);
    await onDeposit({ scope: SCOPE, mandate: w.testMandate.ref }, { queue });
    expect(queue.jobs).toEqual([releaseJobSpec(TARGET_TEST)]);

    const summary = await runReleaseHeld(TARGET_TEST, releaseDeps(w));
    expect(summary.released).toEqual([payoutId(1), payoutId(2)]);
    expect(summary.waiting).toEqual([payoutId(3)]);
    expect(w.store.payout(SCOPE, payoutId(1))?.status).toBe('routed');
    expect(w.store.payout(SCOPE, payoutId(3))?.statusReason).toBe('awaiting_funding');
    // The hold rows of what was released are gone.
    expect(w.store.holdsOf(SCOPE, payoutId(1))).toEqual([]);
  });

  it('fails after funding_hold_max_seconds', async () => {
    const w = await emptyWorld();
    await held(w, 1, 100n);
    const deps = releaseDeps(w);
    const heldFor = (seconds: number): void => {
      const start = new Date('2026-11-02T00:00:00Z').getTime();
      w.now = new Date(start + seconds * 1_000);
    };

    heldFor(DEFAULT_FUNDING_HOLD_MAX_SECONDS - 1);
    expect((await runReleaseHeld(TARGET_TEST, deps)).expired).toEqual([]);
    expect(w.store.payout(SCOPE, payoutId(1))?.status).toBe('received');

    heldFor(DEFAULT_FUNDING_HOLD_MAX_SECONDS);
    expect((await runReleaseHeld(TARGET_TEST, deps)).expired).toEqual([payoutId(1)]);
    expect(w.store.payout(SCOPE, payoutId(1))).toMatchObject({
      status: 'failed',
      statusReason: 'funding_hold_expired',
    });
    expect(w.store.holdsOf(SCOPE, payoutId(1))).toEqual([]);
  });

  it('honours a shorter project maximum', async () => {
    const w = await emptyWorld();
    const store = createMemoryFundingHoldStore({ now: () => w.now, maxHoldSeconds: 3_600 });
    const request = walletRequest(w, 100n);
    store.add(payoutId(1), request);
    await store.hold(
      SCOPE,
      payoutId(1),
      usdc(100n),
      [{ network: TEST_NET, mandateInstanceId: 'instance-test', needed: usdc(100n) }],
      { signal: new AbortController().signal },
    );
    w.now = new Date(w.now.getTime() + HOUR);
    const summary = await runReleaseHeld(TARGET_TEST, { store, route: w.deps, now: () => w.now });
    expect(summary.expired).toEqual([payoutId(1)]);
  });

  it('two release jobs plus a sweep route each payout once', async () => {
    const w = await emptyWorld();
    await held(w, 1, 100n);
    await held(w, 2, 100n);
    await w.test.fund(w.testMandate.ref.address, 1_000n);
    const queue = recordingQueue();

    const [a, b] = await Promise.all([
      runReleaseHeld(TARGET_TEST, releaseDeps(w)),
      runReleaseHeld(TARGET_TEST, releaseDeps(w)),
      sweepFundingHolds({ store: w.store, queue }),
    ]);
    const third = await runReleaseHeld(TARGET_TEST, releaseDeps(w));

    expect(w.store.payout(SCOPE, payoutId(1))?.attempts).toHaveLength(1);
    expect(w.store.payout(SCOPE, payoutId(2))?.attempts).toHaveLength(1);
    expect([...a.released, ...b.released].sort()).toEqual([payoutId(1), payoutId(2)]);
    expect([...a.lost, ...b.lost].sort()).toEqual([payoutId(1), payoutId(2)]);
    expect(third).toEqual({ released: [], expired: [], lost: [], waiting: [] });
  });

  it('a payout held on two networks with simultaneous deposits routes once', async () => {
    const w = await routeWorld({ test: 0n, pub: 0n });
    w.fee = 0n;
    w.destinations = [WALLET_TEST, WALLET_PUB];
    await held(w, 1, 100n);
    expect(w.store.holdsOf(SCOPE, payoutId(1))).toHaveLength(2);
    await w.test.fund(w.testMandate.ref.address, 100n);
    await w.pub.fund(w.pubMandate.ref.address, 100n);

    const [onTest, onPub] = await Promise.all([
      runReleaseHeld(TARGET_TEST, releaseDeps(w)),
      runReleaseHeld(TARGET_PUB, releaseDeps(w)),
    ]);

    const payout = w.store.payout(SCOPE, payoutId(1));
    expect(payout?.attempts).toHaveLength(1);
    expect([...onTest.released, ...onPub.released]).toEqual([payoutId(1)]);
    expect([...onTest.lost, ...onPub.lost]).toEqual([payoutId(1)]);
    // Every hold row is gone, on the network that lost as well.
    expect(w.store.holdsOf(SCOPE, payoutId(1))).toEqual([]);
  });

  it('a job killed halfway and rerun is safe', async () => {
    const w = await emptyWorld();
    await held(w, 1, 100n);
    await held(w, 2, 100n);
    // Enough for one payout only. The chain still shows it all after the first
    // release, because nothing has been requested there yet.
    await w.test.fund(w.testMandate.ref.address, 100n);
    const release = w.store.release.bind(w.store);
    const killed = new Error('worker killed');
    const spy = vi.spyOn(w.store, 'release');
    spy.mockImplementation(async (...args) => {
      await release(...args);
      throw killed;
    });
    await expect(runReleaseHeld(TARGET_TEST, releaseDeps(w))).rejects.toBe(killed);
    spy.mockRestore();
    expect(w.store.payout(SCOPE, payoutId(1))?.status).toBe('routed');

    const rerun = await runReleaseHeld(TARGET_TEST, releaseDeps(w));
    expect(rerun.released).toEqual([]);
    expect(rerun.waiting).toEqual([payoutId(2)]);
    expect(w.store.payout(SCOPE, payoutId(1))?.attempts).toHaveLength(1);
    expect(w.store.payout(SCOPE, payoutId(2))?.attempts).toEqual([]);
  });

  it('the running free balance stops over-commit', async () => {
    const w = await emptyWorld();
    await held(w, 1, 60n);
    await held(w, 2, 60n);
    await held(w, 3, 10n);
    await w.test.fund(w.testMandate.ref.address, 100n);
    const read = vi.spyOn(w.test.adapter, 'readMandate');

    const summary = await runReleaseHeld(TARGET_TEST, releaseDeps(w));
    expect(summary.released).toEqual([payoutId(1)]);
    // The small newest payout would fit, but it does not jump the queue.
    expect(summary.waiting).toEqual([payoutId(2), payoutId(3)]);
    const charged = w.store.payout(SCOPE, payoutId(1))?.attempts[0]?.charged.amount;
    expect(charged).toBe(60n);
    expect(read).toHaveBeenCalled();
  });

  it('the sweep never calls the router', async () => {
    const w = await routeWorld({ test: 0n, pub: 0n });
    w.fee = 0n;
    w.destinations = [WALLET_TEST, WALLET_PUB];
    await held(w, 1, 100n);
    await held(w, 2, 100n);
    const queue = recordingQueue();
    const list = vi.spyOn(w.deps.adapters, 'list');
    const destinations = vi.spyOn(w.deps.destinations, 'list');
    const health = vi.spyOn(w.test.adapter, 'health');

    expect(await sweepFundingHolds({ store: w.store, queue })).toBe(2);
    expect(queue.jobs).toEqual([releaseJobSpec(TARGET_TEST), releaseJobSpec(TARGET_PUB)]);
    expect(list).not.toHaveBeenCalled();
    expect(destinations).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
    expect(w.store.payout(SCOPE, payoutId(1))?.status).toBe('received');
    expect(SWEEP_INTERVAL_SECONDS).toBe(600);
  });

  it('deduplicates by job key and keeps one queue per principal and network', () => {
    const spec = releaseJobSpec(TARGET_TEST);
    expect(spec.task).toBe(RELEASE_TASK);
    expect(spec.task).toBe('payouts:release_held');
    expect(spec.jobKey).toBe(releaseJobSpec(TARGET_TEST).jobKey);
    expect(spec.queueName).toBe(spec.jobKey);
    expect(spec.jobKey).not.toBe(releaseJobSpec(TARGET_PUB).jobKey);
    expect(spec.jobKey).not.toBe(releaseJobSpec({ ...OTHER_SCOPE, network: TEST_NET }).jobKey);
  });

  it('never releases one tenant holds for another', async () => {
    const w = await emptyWorld();
    await held(w, 1, 100n);
    await w.test.fund(w.testMandate.ref.address, 1_000n);
    const summary = await runReleaseHeld({ ...OTHER_SCOPE, network: TEST_NET }, releaseDeps(w));
    expect(summary.released).toEqual([]);
    expect(w.store.payout(SCOPE, payoutId(1))?.status).toBe('received');
    expect(w.store.payout(OTHER_SCOPE, payoutId(1))).toBeUndefined();
  });

  it('releases nothing while the network cannot answer, and does not fail the payout', async () => {
    const w = await emptyWorld();
    await held(w, 1, 100n);
    await held(w, 2, 100n);
    const read = vi.spyOn(w.test.adapter, 'readMandate');
    read.mockRejectedValue(new Error('rpc down'));
    const summary = await runReleaseHeld(TARGET_TEST, releaseDeps(w));
    expect(summary.waiting).toEqual([payoutId(1), payoutId(2)]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(w.store.payout(SCOPE, payoutId(1))?.status).toBe('received');
  });

  it('keeps going past a payout that cannot be routed right now', async () => {
    const w = await emptyWorld();
    await held(w, 1, 100n);
    await held(w, 2, 100n);
    await w.test.fund(w.testMandate.ref.address, 100n);
    // The recipient of the oldest payout has no verified method at the moment.
    vi.spyOn(w.deps.destinations, 'list').mockResolvedValueOnce([]);
    const summary = await runReleaseHeld(TARGET_TEST, releaseDeps(w));
    expect(summary.waiting).toEqual([payoutId(1)]);
    expect(summary.released).toEqual([payoutId(2)]);
  });

  it('reports a release that loses the race as lost and keeps the balance', async () => {
    const w = await emptyWorld();
    await held(w, 1, 100n);
    await held(w, 2, 100n);
    await w.test.fund(w.testMandate.ref.address, 100n);
    vi.spyOn(w.store, 'release').mockResolvedValueOnce(false);
    const summary = await runReleaseHeld(TARGET_TEST, releaseDeps(w));
    expect(summary.lost).toEqual([payoutId(1)]);
    expect(summary.released).toEqual([payoutId(2)]);
  });

  it('counts an expiry another job got to first as lost', async () => {
    const w = await emptyWorld();
    await held(w, 1, 100n);
    w.now = new Date(w.now.getTime() + DEFAULT_FUNDING_HOLD_MAX_SECONDS * 1_000);
    vi.spyOn(w.store, 'expire').mockResolvedValueOnce(false);
    expect((await runReleaseHeld(TARGET_TEST, releaseDeps(w))).lost).toEqual([payoutId(1)]);
  });

  it('refuses a status with no network', () => {
    expect(() => heldStatus([])).toThrow(RangeError);
  });

  it('bounds its store calls and surfaces their failure', async () => {
    const w = await emptyWorld();
    const hanging = { ...w.store, oldestHeld: () => new Promise<never>(() => undefined) };
    await expect(
      runReleaseHeld(TARGET_TEST, { ...releaseDeps(w), store: hanging, timeoutMs: 10 }),
    ).rejects.toThrow('deadline');
  });

  it('refuses an unknown payout and instance', async () => {
    const store = createMemoryFundingHoldStore();
    const opts = { signal: new AbortController().signal };
    await expect(store.requestOf(SCOPE, payoutId(9), opts)).rejects.toThrow(RangeError);
    await expect(store.instanceOf(SCOPE, 'nope', opts)).rejects.toThrow(RangeError);
    expect(await store.release(SCOPE, payoutId(9), {} as never, opts)).toBe(false);
    expect(await store.expire(SCOPE, payoutId(9), opts)).toBe(false);
    expect(await store.hold(SCOPE, payoutId(9), usdc(1n), [], opts)).toBe(false);
  });
});
