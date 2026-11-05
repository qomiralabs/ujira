// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Held payouts on the real tables: each is routed exactly once, however many jobs reach
// it, and a release never promises the same balance twice.

import { randomUUID } from 'node:crypto';

import type { ChainAdapter, NetworkId, Uuid } from '@ujira/chain-adapter';
import { fakeAdapterHarness, deployMandate } from '@ujira/chain-adapter/testing';
import { fundingHolds, payoutAttempts, type Payout, type PayoutAttempt } from '@ujira/db';
import { adminQuery } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  helpersFor,
  newTenant,
  workerHarness,
  type WorkerHarness,
} from '../worker/testing/support.js';
import { tenantTask } from '../worker/handlers.js';
import { RELEASE_HELD } from '../worker/tasks.js';
import { enqueueAdvance } from './advance.js';
import { enqueueRelease, releaseHeld, releaseWork, sweepHolds } from './release.js';
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

const noSignal = (): AbortSignal => new AbortController().signal;

const attemptsOf = async (payout: Payout): Promise<readonly PayoutAttempt[]> =>
  harness.db.tenant(TENANT).transaction(async (tx) => payoutAttempts.forPayout(tx, payout.id));

// A payout the router holds, because the mandate has nothing to pay it with.
async function held(world: EngineWorld, key: string, total = 2n * ONE_USDC): Promise<Payout> {
  const payout = await world.payout(key, usdc(total));
  await world.run(payout);
  const after = await world.read(payout.id);
  expect(after).toMatchObject({ status: 'received', statusReason: 'awaiting_funding' });
  return after;
}

const emptyWorld = async (): Promise<EngineWorld> => engineWorld(harness, { fund: 0n });

describe('holding a payout', () => {
  it('stays received with no attempt, and the advance job leaves it alone', async () => {
    const world = await emptyWorld();
    const payout = await held(world, 'held');
    expect(await attemptsOf(payout)).toHaveLength(0);
    await world.h.fund(world.m.ref.address, 10n * ONE_USDC);
    // A deposit does not make this job its owner. Only the release job routes it.
    await world.run(payout);
    expect(await attemptsOf(payout)).toHaveLength(0);
    expect(world.pays).toHaveLength(0);
  });
});

describe('releasing held payouts', () => {
  it('two release jobs plus a sweep route each payout once', async () => {
    const world = await emptyWorld();
    const payouts = [await held(world, 'twice-a'), await held(world, 'twice-b')];
    await world.h.fund(world.m.ref.address, 10n * ONE_USDC);
    const [first, second] = await Promise.all([
      releaseHeld(world.deps, TENANT, NETWORK, noSignal()),
      releaseHeld(world.deps, TENANT, NETWORK, noSignal()),
    ]);
    await sweepHolds(harness.db);
    const third = await releaseHeld(world.deps, TENANT, NETWORK, noSignal());
    for (const payout of payouts) {
      const attempts = await attemptsOf(payout);
      expect(attempts).toHaveLength(1);
      expect((await world.read(payout.id)).status).toBe('routed');
    }
    expect(first.released.length + second.released.length).toBe(2);
    expect(third.released).toHaveLength(0);
    // Its advance job is what goes on from here, and it pays once.
    for (const payout of payouts) {
      expect((await world.drive(payout)).status).toBe('paid');
    }
  });

  it('a payout held on two networks with simultaneous deposits routes once', async () => {
    const world = await emptyWorld();
    const other: NetworkId = 'stellar:pubnet';
    const pub = fakeAdapterHarness({ network: other });
    const pubMandate = await deployMandate(pub, { fund: 100n * ONE_USDC, salt: randomUUID() });
    await world.h.fund(world.m.ref.address, 100n * ONE_USDC);
    const payout = await world.payout('two-networks', usdc(2n * ONE_USDC));
    await harness.db.tenant(TENANT).transaction(async (tx) => {
      await fundingHolds.hold(
        tx,
        payout.id,
        [NETWORK, other].map((network) => ({
          network,
          mandateInstanceId: world.instanceId,
          needed: usdc(ONE_USDC),
        })),
      );
    });
    const enabled = new Map<NetworkId, ChainAdapter>([[other, pub.adapter]]);
    const adapters = {
      get: (network: NetworkId) => enabled.get(network) ?? world.deps.adapters.get(network),
      list: () => [...world.deps.adapters.list(), pub.adapter],
    };
    const config = world.deps.routing.config();
    const both = {
      ...world.deps,
      adapters,
      routing: {
        ...world.deps.routing,
        adapters,
        config: () =>
          ({
            ...config,
            networks: { ...config.networks, [other]: config.networks[NETWORK] },
            rails: [
              ...config.rails,
              { id: 'wallet_pub', network: other, rail: 'stellar.wallet', enabled: true },
            ],
            corridors: config.corridors.map((corridor) =>
              corridor.currency === 'USDC'
                ? {
                    ...corridor,
                    candidates: [...corridor.candidates, { rail: 'wallet_pub', priority: 2 }],
                  }
                : corridor,
            ),
          }) as typeof config,
        mandates: {
          ...world.deps.routing.mandates,
          list: async (...args: Parameters<typeof world.deps.routing.mandates.list>) => [
            ...(await world.deps.routing.mandates.list(...args)),
            { mandateInstanceId: world.instanceId, ref: pubMandate.ref },
          ],
        },
        destinations: {
          list: async (...args: Parameters<typeof world.deps.routing.destinations.list>) => {
            const found = await world.deps.routing.destinations.list(...args);
            return [...found, ...found.map((one) => ({ ...one, network: other }))];
          },
        },
      },
    };
    const results = await Promise.all([
      releaseHeld(both, TENANT, NETWORK, noSignal()),
      releaseHeld(both, TENANT, other, noSignal()),
    ]);
    const released = results.flatMap((summary) => summary.released);
    expect(released).toEqual([payout.id]);
    expect(await attemptsOf(payout)).toHaveLength(1);
    expect((await world.read(payout.id)).status).toBe('routed');
    const left = await adminQuery(
      harness.database.url,
      'select 1 from ujira.payout_funding_holds where payout_id = $1',
      [payout.id],
    );
    expect(left).toHaveLength(0);
  });

  it('a job killed halfway and rerun is safe', async () => {
    const world = await emptyWorld();
    const payouts = [
      await held(world, 'kill-a'),
      await held(world, 'kill-b'),
      await held(world, 'kill-c'),
    ];
    await world.h.fund(world.m.ref.address, 10n * ONE_USDC);
    // A clean run says how many boundaries one has; dying halfway through it leaves some
    // payouts released and some not.
    const dying = killing(world.deps, 12);
    await expect(releaseHeld(dying.deps, TENANT, NETWORK, noSignal())).rejects.toBeInstanceOf(
      Killed,
    );
    const midway = await Promise.all(payouts.map(attemptsOf));
    expect(midway.flat().length).toBeLessThan(3);

    await releaseHeld(world.deps, TENANT, NETWORK, noSignal());
    for (const payout of payouts) expect(await attemptsOf(payout)).toHaveLength(1);
  });

  it('the running free balance stops over-commit, oldest first', async () => {
    const world = await emptyWorld();
    const oldest = await held(world, 'budget-a');
    const next = await held(world, 'budget-b');
    const newest = await held(world, 'budget-c');
    // Enough for two with their fees, and not the third.
    await world.h.fund(world.m.ref.address, 5n * ONE_USDC);
    const summary = await releaseHeld(world.deps, TENANT, NETWORK, noSignal());
    expect(summary.released).toEqual([oldest.id, next.id]);
    expect(summary.waiting).toContain(newest.id);
    expect((await world.read(newest.id)).statusReason).toBe('awaiting_funding');

    // Nothing has reached the chain yet, and running it again must not see that as free.
    const again = await releaseHeld(world.deps, TENANT, NETWORK, noSignal());
    expect(again.released).toHaveLength(0);
    expect(await attemptsOf(newest)).toHaveLength(0);
  });

  it('the sweep never calls the router', async () => {
    const world = await emptyWorld();
    const payout = await held(world, 'sweep');
    const asked = world.pays.length;
    const swept = await sweepHolds(harness.db);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(world.pays).toHaveLength(asked);
    expect(await attemptsOf(payout)).toHaveLength(0);
    const jobs = await adminQuery<{ task_identifier: string; queue_name: string }>(
      harness.database.url,
      `select task_identifier, queue_name from graphile_worker.jobs
        where task_identifier = 'payouts:release_held'`,
    );
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const queues = jobs.map((job) => job.queue_name);
    expect(queues).toContainEqual(expect.stringContaining(TENANT.principalId));
    expect(queues).toContainEqual(expect.stringContaining(`release_held:${NETWORK}`));
  });

  it('a burst of deposits collapses into one job', async () => {
    await adminQuery(
      harness.database.url,
      `delete from graphile_worker._private_jobs where task_id in (
         select id from graphile_worker._private_tasks where identifier = 'payouts:release_held')`,
    );
    for (let deposit = 0; deposit < 3; deposit += 1) {
      await harness.db.tenant(TENANT).transaction(async (tx) => {
        await enqueueRelease(tx, TENANT, NETWORK);
      });
    }
    const jobs = await adminQuery(
      harness.database.url,
      `select 1 from graphile_worker.jobs where task_identifier = 'payouts:release_held'`,
    );
    expect(jobs).toHaveLength(1);
  });

  it('expires a hold past the project setting', async () => {
    const world = await emptyWorld();
    const payout = await held(world, 'expired');
    const late = {
      ...world.deps,
      now: () => Date.now() + 15 * 24 * 3_600 * 1_000,
    };
    const summary = await releaseHeld(late, TENANT, NETWORK, noSignal());
    expect(summary.expired).toContain(payout.id);
    expect(await world.read(payout.id)).toMatchObject({
      status: 'failed',
      statusReason: 'funding_hold_expired',
    });
  });

  it('refuses a held payout whose route falls below a minimum', async () => {
    const world = await engineWorld(harness, {
      fund: 0n,
      overrides: {
        minimumContext: () => ({
          breakEvenMinimum: { amount: 100n * ONE_USDC, currency: 'USDC', scale: 7 },
        }),
      },
    });
    const payout = await world.payout('held-below', usdc(2n * ONE_USDC));
    await harness.db.tenant(TENANT).transaction(async (tx) => {
      await fundingHolds.hold(tx, payout.id, [
        { network: NETWORK, mandateInstanceId: world.instanceId, needed: usdc(ONE_USDC) },
      ]);
    });
    await world.h.fund(world.m.ref.address, 10n * ONE_USDC);
    const summary = await releaseHeld(world.deps, TENANT, NETWORK, noSignal());
    expect(summary.released).not.toContain(payout.id);
    expect((await world.read(payout.id)).status).toBe('rejected');
    expect(await attemptsOf(payout)).toHaveLength(0);
  });

  it('runs as a job, and only for the project it names', async () => {
    const world = await emptyWorld();
    const payout = await held(world, 'as-a-job');
    await world.h.fund(world.m.ref.address, 10n * ONE_USDC);
    const handler = tenantTask(RELEASE_HELD, releaseWork(world.deps), {
      db: harness.db,
      alert: () => undefined,
    });
    await expect(
      handler(
        { ...TENANT, network: NETWORK, heldProjectId: randomUUID() as Uuid },
        helpersFor('1'),
      ),
    ).rejects.toThrow(/payload/);
    await handler(
      { ...TENANT, network: NETWORK, heldProjectId: TENANT.projectId },
      helpersFor('1'),
    );
    expect(await attemptsOf(payout)).toHaveLength(1);
    await harness.db.tenant(TENANT).transaction(async (tx) => {
      await enqueueAdvance(tx, await world.read(payout.id));
    });
  });

  it("does not release another tenant's holds", async () => {
    const world = await emptyWorld();
    const payout = await held(world, 'other-tenant');
    await world.h.fund(world.m.ref.address, 10n * ONE_USDC);
    const other = await newTenant(harness.db);
    const summary = await releaseHeld(world.deps, other, NETWORK, noSignal());
    expect(summary.released).toHaveLength(0);
    expect(await attemptsOf(payout)).toHaveLength(0);
  });
});
