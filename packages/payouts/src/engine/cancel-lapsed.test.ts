// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Clearing up after a lapse. A lapsed payout holds its funds until it is cancelled, so a
// mandate with nothing spare cannot pay the retry until that happens. The retry goes
// first when the funds allow, and the sweep frees them when they do not.

import { payoutAttempts, payoutEngine, type Payout, type PayoutAttempt } from '@ujira/db';
import { adminQuery } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newTenant, workerHarness, type WorkerHarness } from '../worker/testing/support.js';
import { cancelLapsedWork, sweepLapsed } from './cancel.js';
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

const TTL = 86_400n;
const TOTAL = 2n * ONE_USDC;
// The total and the one percent take, and not a stroop more.
const NOTHING_SPARE = TOTAL + TOTAL / 100n;

const attemptsOf = async (payout: Payout): Promise<readonly PayoutAttempt[]> =>
  harness.db.tenant(TENANT).transaction(async (tx) => payoutAttempts.forPayout(tx, payout.id));

const cancels = (world: EngineWorld) =>
  world.h.world.net.txs
    .flatMap((tx) => tx.events)
    .filter((event) => event.name === 'payout_cancelled');

const sweepJob = (world: EngineWorld) => ({
  context: TENANT,
  ids: { mandateInstanceId: world.instanceId, mandateId: world.mandateId },
  tryNumber: 1,
  signal: new AbortController().signal,
});

// On chain and approved, and stopped from executing, until it lapses and the job proves it.
async function lapsed(world: EngineWorld, key: string): Promise<Payout> {
  const payout = await world.payout(key, usdc(TOTAL));
  await world.run(payout);
  await world.h.advance(TTL + 60n);
  await world.run(payout);
  const [attempt] = await attemptsOf(payout);
  expect(attempt?.status).toBe('dead');
  expect(attempt?.deadProof).toMatchObject({ kind: 'payout_lapsed' });
  return payout;
}

describe('with nothing spare', () => {
  it('the retry is held, the sweep frees the funds, and the retry pays', async () => {
    const world = await engineWorld(harness, { fund: NOTHING_SPARE });
    const before = await world.balanceOfRecipient();
    const payout = await lapsed(world, 'nothing-spare');

    // The lapsed payout still holds everything, so the next attempt cannot be made.
    await world.run(payout);
    expect(await world.read(payout.id)).toMatchObject({
      status: 'received',
      statusReason: 'awaiting_funding',
    });
    expect(await attemptsOf(payout)).toHaveLength(1);

    // The cron finds it, and the job on the mandate's queue clears it.
    expect(await sweepLapsed(harness.db)).toBeGreaterThanOrEqual(1);
    const work = cancelLapsedWork(world.deps);
    await work(sweepJob(world));
    await world.h.advance(6n);
    await work(sweepJob(world));

    const [event] = cancels(world);
    expect(event?.fields).toMatchObject({ reason: 3 });
    expect(cancels(world)).toHaveLength(1);
    // Clearing it wakes what was waiting on the funds.
    const queued = await adminQuery<{ task_identifier: string }>(
      harness.database.url,
      `select task_identifier from graphile_worker.jobs
        where task_identifier = 'payouts:release_held'`,
    );
    expect(queued.length).toBeGreaterThanOrEqual(1);

    const summary = await releaseHeld(world.deps, TENANT, NETWORK, new AbortController().signal);
    expect(summary.released).toContain(payout.id);
    expect((await world.drive(payout)).status).toBe('paid');
    const attempts = await attemptsOf(payout);
    expect(attempts.map((one) => one.status)).toEqual(['dead', 'final']);
    expect(world.executed(attempts[0]?.onChainPayoutId ?? '')).toBe(0);
    expect(world.executed(attempts[1]?.onChainPayoutId ?? '')).toBe(1);
    expect((await world.balanceOfRecipient()) - before).toBe(TOTAL);
  });
});

describe('with funds to spare', () => {
  it('the retry goes first, and the sweep clears up after it', async () => {
    const world = await engineWorld(harness);
    const payout = await lapsed(world, 'spare');
    expect((await world.drive(payout)).status).toBe('paid');
    expect(cancels(world)).toHaveLength(0);

    const work = cancelLapsedWork(world.deps);
    await work(sweepJob(world));
    await world.h.advance(6n);
    await work(sweepJob(world));
    expect(cancels(world)).toHaveLength(1);
    const attempts = await attemptsOf(payout);
    expect(world.executed(attempts[0]?.onChainPayoutId ?? '')).toBe(0);
    expect(world.executed(attempts[1]?.onChainPayoutId ?? '')).toBe(1);
  });
});

describe('what the sweep touches', () => {
  it('leaves a live attempt alone, even past its deadline', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('live', usdc(TOTAL));
    await world.run(payout);
    await world.h.advance(3_700n);
    await cancelLapsedWork(world.deps)(sweepJob(world));
    expect(cancels(world)).toHaveLength(0);
    expect((await attemptsOf(payout))[0]?.status).not.toBe('dead');
  });

  it('leaves an attempt dead for another reason, which holds nothing', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('never-sent', usdc(TOTAL));
    world.h.faults?.signerDown(true);
    await world.run(payout);
    await world.h.advance(3_700n);
    world.h.faults?.signerDown(false);
    await world.run(payout);
    expect((await attemptsOf(payout))[0]?.deadProof).toMatchObject({ kind: 'deadline_passed' });
    const before = world.h.world.net.txs.length;
    await cancelLapsedWork(world.deps)(sweepJob(world));
    expect(world.h.world.net.txs).toHaveLength(before);
  });

  it('files one job per instance, on the mandate queue, and sends nothing itself', async () => {
    const world = await engineWorld(harness);
    await lapsed(world, 'fan-out-a');
    await lapsed(world, 'fan-out-b');
    const sent = world.h.world.net.txs.length;
    await sweepLapsed(harness.db);
    expect(world.h.world.net.txs).toHaveLength(sent);
    const jobs = await adminQuery<{ queue_name: string; key: string }>(
      harness.database.url,
      `select j.queue_name, j.key from graphile_worker.jobs as j
        where j.task_identifier = 'payouts:cancel_lapsed' and j.key like $1`,
      [`%${world.instanceId}`],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.queue_name).toContain(`mandate:${world.mandateId}`);
  });

  it('finds nothing once it is cleared', async () => {
    const world = await engineWorld(harness);
    await lapsed(world, 'cleared');
    const work = cancelLapsedWork(world.deps);
    await work(sweepJob(world));
    await world.h.advance(6n);
    await work(sweepJob(world));
    const left = await harness.db
      .tenant(TENANT)
      .transaction(async (tx) => payoutEngine.lapsedUncancelled(tx, world.instanceId, 10));
    expect(left).toHaveLength(0);
    const sent = world.h.world.net.txs.length;
    await work(sweepJob(world));
    expect(world.h.world.net.txs).toHaveLength(sent);
  });

  it("does nothing for another tenant's instance", async () => {
    const world = await engineWorld(harness);
    await lapsed(world, 'tenant');
    const other = await newTenant(harness.db);
    await cancelLapsedWork(world.deps)({ ...sweepJob(world), context: other });
    expect(cancels(world)).toHaveLength(0);
  });
});

describe('a rerun', () => {
  const clear = async (world: EngineWorld, deps: EngineDeps): Promise<void> => {
    const work = cancelLapsedWork(deps);
    for (let run = 0; run < 6; run += 1) {
      await work(sweepJob(world)).catch((error: unknown) => {
        if (!(error instanceof Killed)) throw error;
      });
      await world.h.advance(6n);
    }
  };

  it('sends one cancel, at every point a job can die', async () => {
    const measuring = await engineWorld(harness);
    await lapsed(measuring, 'kill-measure');
    const measured = killing(measuring.deps, 0);
    await clear(measuring, measured.deps);
    const points = measured.boundaries();
    expect(points).toBeGreaterThan(2);

    for (let point = 1; point <= points; point += 1) {
      const world = await engineWorld(harness);
      await lapsed(world, `kill-${String(point)}`);
      await clear(world, killing(world.deps, point).deps);
      await clear(world, world.deps);
      expect(cancels(world), `killed at ${String(point)}`).toHaveLength(1);
      const left = await harness.db
        .tenant(TENANT)
        .transaction(async (tx) => payoutEngine.lapsedUncancelled(tx, world.instanceId, 10));
      expect(left).toHaveLength(0);
    }
  }, 240_000);
});
