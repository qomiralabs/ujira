// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The router's storage ports against real Postgres, as the real roles.
 *
 * - A payout is routed exactly once, however many releases race it: of any number
 *   of concurrent transactions one moves it and the rest match nothing. A payout
 *   held on two networks routes once and loses every hold row.
 * - A release is all or nothing. If the attempt is refused, the payout is still
 *   held and its holds are still there.
 * - A release and an expiry racing the same payout have one winner.
 * - A job killed after a release and run again does not promise the same funds
 *   twice, because what is routed but not on chain comes off the balance.
 * - One tenant can neither see nor move another tenant's holds.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { RELEASE_BATCH, runReleaseHeld, selectRoute } from '@ujira/router';
import type {
  ReleaseTarget,
  RouteDeps,
  RouteRequest,
  RoutedOutcome,
  RoutingConfig,
} from '@ujira/router';

import type { Database } from './database.js';
import { fundingHolds, payoutAttempts, payouts } from './repositories/payouts.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { payoutMethods, recipients } from './repositories/recipients.js';
import { PageRequestError } from './repositories/page.js';
import { routing } from './repositories/routing.js';
import { projects } from './repositories/tenancy.js';
import { HeldPayoutUnreadableError, createRouteStores } from './route-stores.js';
import type { RouteStores } from './route-stores.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  ONE_USDC,
  TESTNET,
  newPayout,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const OPTS = { signal: new AbortController().signal };
const PUBNET = 'stellar:pubnet';
const FIVE = 5n * ONE_USDC;

type Network = ReleaseTarget['network'];
type Id = ReleaseTarget['principalId'];

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let stores: RouteStores;

function scopeOf(fixture: PayoutFixture) {
  return {
    principalId: fixture.tenant.principalId as Id,
    projectId: fixture.tenant.projectId as Id,
  };
}

function targetOf(fixture: PayoutFixture): ReleaseTarget {
  return { ...scopeOf(fixture), network: TESTNET };
}

async function fixtureWithWallet(): Promise<PayoutFixture> {
  const fixture = await payoutFixture(db);
  await db.tenant(fixture.tenant).transaction((tx) =>
    payoutMethods.create(tx, {
      recipientId: fixture.recipientId,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress: `G${randomUUID()}`,
      destinationTag: null,
      details: null,
    }),
  );
  return fixture;
}

async function createPayout(fixture: PayoutFixture): Promise<Id> {
  const created = await db
    .tenant(fixture.tenant)
    .transaction((tx) => payouts.create(tx, newPayout(fixture)));
  return created.payout.id as Id;
}

async function heldPayout(
  fixture: PayoutFixture,
  networks: readonly string[] = [TESTNET],
): Promise<Id> {
  const id = await createPayout(fixture);
  const held = await stores.holds.hold(
    scopeOf(fixture),
    id,
    usdc(FIVE),
    networks.map((network) => ({
      network: network as Network,
      mandateInstanceId: fixture.instanceId,
      needed: usdc(FIVE),
    })),
    OPTS,
  );
  expect(held).toBe(true);
  return id;
}

function routeFor(fixture: PayoutFixture, network: string = TESTNET): RoutedOutcome {
  const net = network as Network;
  return {
    kind: 'routed',
    network: net,
    mandateInstanceId: fixture.instanceId,
    mandate: { network: net, address: { network: net, value: 'C1' }, specVersion: 1 },
    total: usdc(FIVE),
    legs: [],
    charged: usdc(FIVE),
    collapsed: false,
    methodFallback: false,
    degraded: false,
    quoteFailures: 0,
  };
}

async function stateOf(fixture: PayoutFixture, id: string) {
  return db.tenant(fixture.tenant).transaction(async (tx) => ({
    payout: await payouts.get(tx, id),
    attempts: await payoutAttempts.forPayout(tx, id),
    holds: await fundingHolds.oldestOnNetwork(tx, TESTNET, 50),
  }));
}

const CONFIG = {
  schemaVersion: 1,
  networks: {},
  rails: [{ id: 'wallet', network: TESTNET, rail: 'stellar.wallet', enabled: true }],
  corridors: [
    {
      country: 'NG',
      method: 'stellar_wallet',
      currency: 'USDC',
      enabled: true,
      strategy: 'priority',
      candidates: [{ rail: 'wallet', priority: 1 }],
    },
  ],
} as unknown as RoutingConfig;

// The router against the real stores, with a chain that reports this free balance.
function routeDeps(free: () => bigint): RouteDeps {
  const adapter = {
    network: TESTNET,
    capabilities: () => ({
      network: TESTNET,
      specVersions: [1],
      settlementAssets: ['USDC'],
      rails: [
        {
          rail: 'stellar.wallet',
          enabled: true,
          deliveryCurrencies: ['USDC'],
          countries: [],
          firmQuotes: true,
          requiresRecipientKyc: false,
        },
      ],
      maxLegs: 4,
      maxBatch: 10,
      supportsDestinationTag: true,
      typicalSettlementSeconds: 5,
      typicalFinalSeconds: 5,
    }),
    health: () => Promise.resolve({ network: TESTNET, state: 'healthy', rails: [], reasons: [] }),
    readMandate: () =>
      Promise.resolve({
        trustedFactory: true,
        tenantTagMatches: true,
        state: { free: usdc(free()), paused: false, revoked: false, expired: false },
      }),
  };
  return {
    config: () => CONFIG,
    adapters: { get: () => adapter, list: () => [adapter] } as unknown as RouteDeps['adapters'],
    mandates: stores.mandates,
    destinations: stores.destinations,
    quotes: { quote: () => Promise.reject(new Error('no quote is needed')) },
    compliance: {
      read: () => Promise.resolve(null),
    } as unknown as RouteDeps['compliance'],
    feeFor: () => usdc(0n),
  };
}

const releaseDeps = (free: () => bigint, now: Date = new Date()) => ({
  store: stores.holds,
  route: routeDeps(free),
  now: () => now,
});

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 8);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  stores = createRouteStores({
    db,
    networkOf: () => TESTNET,
    railOf: () => 'stellar.wallet',
    attemptDeadline: () => new Date(Date.now() + 3_600_000),
    holdTargets: () => Promise.resolve([]),
  });
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('exactly one release', () => {
  it('routes a payout once however many releases race it', async () => {
    const fixture = await payoutFixture(db);
    const id = await heldPayout(fixture);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        stores.holds.release(scopeOf(fixture), id, routeFor(fixture), OPTS),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const { payout, attempts, holds } = await stateOf(fixture, id);
    expect(payout?.status).toBe('routed');
    expect(payout?.statusReason).toBeNull();
    expect(attempts).toHaveLength(1);
    expect(holds).toEqual([]);
  });

  it('routes a payout held on two networks once, and clears both holds', async () => {
    const fixture = await payoutFixture(db);
    const id = await heldPayout(fixture, [TESTNET, PUBNET]);
    const results = await Promise.all(
      [TESTNET, PUBNET, TESTNET, PUBNET].map((network) =>
        stores.holds.release(scopeOf(fixture), id, routeFor(fixture, network), OPTS),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await stateOf(fixture, id)).attempts).toHaveLength(1);
    const left = await admin.query(
      'select 1 from ujira.payout_funding_holds where payout_id = $1',
      [id],
    );
    expect(left.rowCount).toBe(0);
  });

  it('gives a release and an expiry racing the same payout one winner', async () => {
    const fixture = await payoutFixture(db);
    const id = await heldPayout(fixture);
    const [released, expired] = await Promise.all([
      stores.holds.release(scopeOf(fixture), id, routeFor(fixture), OPTS),
      stores.holds.expire(scopeOf(fixture), id, OPTS),
    ]);
    expect([released, expired].filter(Boolean)).toHaveLength(1);
    const { payout, attempts } = await stateOf(fixture, id);
    expect(payout?.status).toBe(released ? 'routed' : 'failed');
    expect(attempts).toHaveLength(released ? 1 : 0);
  });

  it('two jobs and a sweep route each payout once, through the real router', async () => {
    const fixture = await fixtureWithWallet();
    const ids = [await heldPayout(fixture), await heldPayout(fixture), await heldPayout(fixture)];
    const free = () => 100n * ONE_USDC;
    const [a, b] = await Promise.all([
      runReleaseHeld(targetOf(fixture), releaseDeps(free)),
      runReleaseHeld(targetOf(fixture), releaseDeps(free)),
    ]);
    expect([...a.released, ...b.released].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const { payout, attempts } = await stateOf(fixture, id);
      expect(payout?.status).toBe('routed');
      expect(attempts).toHaveLength(1);
    }
    expect(await runReleaseHeld(targetOf(fixture), releaseDeps(free))).toEqual({
      released: [],
      expired: [],
      lost: [],
      waiting: [],
    });
  });
});

describe('all or nothing', () => {
  it('leaves the payout held when the attempt is refused', async () => {
    const fixture = await payoutFixture(db);
    const id = await heldPayout(fixture);
    // A live attempt already there: the one live attempt index is the backstop.
    await db.tenant(fixture.tenant).transaction((tx) =>
      payoutAttempts.create(tx, {
        payoutId: id,
        mandateInstanceId: fixture.instanceId,
        network: TESTNET,
        total: usdc(FIVE),
        deadline: new Date(Date.now() + 3_600_000),
      }),
    );
    await expect(
      stores.holds.release(scopeOf(fixture), id, routeFor(fixture), OPTS),
    ).rejects.toThrow();
    const { payout, attempts, holds } = await stateOf(fixture, id);
    expect(payout?.status).toBe('received');
    expect(payout?.statusReason).toBe('awaiting_funding');
    expect(attempts).toHaveLength(1);
    expect(holds.map((h) => h.payoutId)).toContain(id);
  });

  it('a job killed halfway and rerun does not promise the same funds twice', async () => {
    const fixture = await fixtureWithWallet();
    const first = await heldPayout(fixture);
    const second = await heldPayout(fixture);
    // Enough for one, and the chain still shows it all until a request lands.
    const free = () => FIVE;
    const killed = new Error('worker killed');
    const release = stores.holds.release.bind(stores.holds);
    const spy = vi.spyOn(stores.holds, 'release').mockImplementation(async (...args) => {
      await release(...args);
      throw killed;
    });
    try {
      await expect(runReleaseHeld(targetOf(fixture), releaseDeps(free))).rejects.toBe(killed);
    } finally {
      spy.mockRestore();
    }

    const rerun = await runReleaseHeld(targetOf(fixture), releaseDeps(free));
    expect(rerun.released).toEqual([]);
    expect(rerun.waiting).toEqual([second]);
    expect((await stateOf(fixture, first)).attempts).toHaveLength(1);
    expect((await stateOf(fixture, second)).payout?.statusReason).toBe('awaiting_funding');
  });
});

describe('reading a batch', () => {
  it('reads as many as a job asks for, but never without limit', async () => {
    const fixture = await payoutFixture(db);
    for (const limit of [0, 1001, 1.5]) {
      await expect(
        db.tenant(fixture.tenant).transaction((tx) => routing.heldOnNetwork(tx, TESTNET, limit)),
      ).rejects.toBeInstanceOf(PageRequestError);
    }
    await expect(
      db
        .tenant(fixture.tenant)
        .transaction((tx) => routing.heldOnNetwork(tx, TESTNET, RELEASE_BATCH)),
    ).resolves.toEqual([]);
  });
});

describe('holding', () => {
  it('holds a received payout once, recording the total', async () => {
    const fixture = await payoutFixture(db);
    const id = await heldPayout(fixture);
    const { payout } = await stateOf(fixture, id);
    expect(payout?.statusReason).toBe('awaiting_funding');
    expect(payout?.total).toEqual(usdc(FIVE));
    expect(
      await stores.holds.hold(
        scopeOf(fixture),
        id,
        usdc(FIVE),
        [
          {
            network: TESTNET,
            mandateInstanceId: fixture.instanceId,
            needed: usdc(FIVE),
          },
        ],
        OPTS,
      ),
    ).toBe(false);
  });

  it('refuses to hold a payout that has moved on, and changes nothing', async () => {
    const fixture = await payoutFixture(db);
    const id = await heldPayout(fixture);
    await stores.holds.release(scopeOf(fixture), id, routeFor(fixture), OPTS);
    expect(
      await stores.holds.hold(
        scopeOf(fixture),
        id,
        usdc(1n),
        [{ network: TESTNET, mandateInstanceId: fixture.instanceId, needed: usdc(1n) }],
        OPTS,
      ),
    ).toBe(false);
    expect((await stateOf(fixture, id)).payout?.total).toEqual(usdc(FIVE));
  });

  it('does not release a payout that is received but not held', async () => {
    const fixture = await payoutFixture(db);
    const id = await createPayout(fixture);
    expect(await stores.holds.release(scopeOf(fixture), id, routeFor(fixture), OPTS)).toBe(false);
    expect(await stores.holds.expire(scopeOf(fixture), id, OPTS)).toBe(false);
    expect((await stateOf(fixture, id)).payout?.status).toBe('received');
  });

  it('expires a held payout and clears its holds', async () => {
    const fixture = await payoutFixture(db);
    const id = await heldPayout(fixture);
    expect(await stores.holds.expire(scopeOf(fixture), id, OPTS)).toBe(true);
    const { payout, holds } = await stateOf(fixture, id);
    expect(payout?.status).toBe('failed');
    expect(payout?.statusReason).toBe('funding_hold_expired');
    expect(holds).toEqual([]);
  });

  it('expires through the job after the project maximum', async () => {
    const fixture = await fixtureWithWallet();
    const id = await heldPayout(fixture);
    const seconds = await stores.holds.maxHoldSeconds(scopeOf(fixture), OPTS);
    expect(seconds).toBe(1_209_600);
    const later = new Date(Date.now() + (seconds + 60) * 1_000);
    const summary = await runReleaseHeld(
      targetOf(fixture),
      releaseDeps(() => 0n, later),
    );
    expect(summary.expired).toEqual([id]);
  });
});

describe('reading', () => {
  it('lists holds oldest first, with each one under its own tenant', async () => {
    const fixture = await payoutFixture(db);
    const first = await heldPayout(fixture);
    const second = await heldPayout(fixture);
    const held = await stores.holds.oldestHeld(targetOf(fixture), 10, OPTS);
    expect(held.map((h) => h.payoutId)).toEqual([first, second]);
    expect(held[0]).toMatchObject({
      scope: scopeOf(fixture),
      network: TESTNET,
      mandateInstanceId: fixture.instanceId,
      needed: usdc(FIVE),
    });
    expect(held[0]?.heldAt).toBeInstanceOf(Date);
    expect(
      await stores.holds.oldestHeld({ ...targetOf(fixture), network: PUBNET }, 10, OPTS),
    ).toEqual([]);
    expect(await stores.holds.oldestHeld(targetOf(fixture), 1, OPTS)).toHaveLength(1);
  });

  it('rebuilds a payout asked for in the token, and leaves its currency open', async () => {
    const fixture = await fixtureWithWallet();
    const id = await heldPayout(fixture);
    const request: RouteRequest = await stores.holds.requestOf(scopeOf(fixture), id, OPTS);
    expect(request).toEqual({
      scope: scopeOf(fixture),
      mandateId: fixture.mandateId,
      recipientId: fixture.recipientId,
      country: 'NG',
      total: usdc(FIVE),
      legs: [{ method: 'stellar_wallet', amount: usdc(FIVE) }],
      chainFallback: 'off',
      correlationId: id,
    });
    const outcome = await selectRoute(
      request,
      routeDeps(() => 100n * ONE_USDC),
    );
    expect(outcome).toMatchObject({ kind: 'routed', network: TESTNET, total: usdc(FIVE) });
  });

  it('refuses a payout it cannot rebuild', async () => {
    const fixture = await payoutFixture(db);
    await expect(
      stores.holds.requestOf(scopeOf(fixture), randomUUID() as Id, OPTS),
    ).rejects.toThrow(HeldPayoutUnreadableError);
    await expect(stores.holds.instanceOf(scopeOf(fixture), randomUUID(), OPTS)).rejects.toThrow(
      HeldPayoutUnreadableError,
    );
  });

  it('gives a mandate instance as a reference on its network', async () => {
    const fixture = await payoutFixture(db);
    const [instance] = await stores.mandates.list(scopeOf(fixture), fixture.mandateId as Id, OPTS);
    expect(instance?.mandateInstanceId).toBe(fixture.instanceId);
    expect(instance?.ref.network).toBe(TESTNET);
    expect(instance?.ref.specVersion).toBe(1);
    expect(instance?.ref.address.network).toBe(TESTNET);
    expect(await stores.holds.instanceOf(scopeOf(fixture), fixture.instanceId, OPTS)).toEqual(
      instance,
    );
  });

  it('counts what is routed but not yet requested on chain', async () => {
    const fixture = await payoutFixture(db);
    const read = () =>
      stores.mandates.unrequested(scopeOf(fixture), fixture.instanceId, usdc(0n), OPTS);
    expect(await read()).toEqual(usdc(0n));
    const first = await heldPayout(fixture);
    await heldPayout(fixture);
    await stores.holds.release(scopeOf(fixture), first, routeFor(fixture), OPTS);
    expect(await read()).toEqual(usdc(FIVE));

    // Once it is requested, the chain's own balance shows it.
    const { attempts } = await stateOf(fixture, first);
    const attempt = attempts[0];
    if (attempt === undefined) throw new Error('expected an attempt');
    await db
      .tenant(fixture.tenant)
      .transaction((tx) =>
        payoutAttempts.transition(tx, attempt.id, { from: 'created', to: 'requested' }),
      );
    expect(await read()).toEqual(usdc(0n));
  });

  it('lists only active methods of an active recipient', async () => {
    const fixture = await fixtureWithWallet();
    const list = () => stores.destinations.list(scopeOf(fixture), fixture.recipientId as Id, OPTS);
    const [method] = await list();
    expect(method).toMatchObject({
      method: 'stellar_wallet',
      network: TESTNET,
      rail: 'stellar.wallet',
    });
    if (method === undefined) throw new Error('expected a method');

    await db
      .tenant(fixture.tenant)
      .transaction((tx) => payoutMethods.disable(tx, method.recipientMethodId));
    expect(await list()).toEqual([]);

    const suspended = await fixtureWithWallet();
    await admin.query(`update ujira.recipients set status = 'suspended' where id = $1`, [
      suspended.recipientId,
    ]);
    expect(
      await stores.destinations.list(scopeOf(suspended), suspended.recipientId as Id, OPTS),
    ).toEqual([]);
  });

  it('asks the signal before starting anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const opts = { signal: controller.signal };
    const fixture = await payoutFixture(db);
    const scope = scopeOf(fixture);
    const id = randomUUID() as Id;
    const calls = [
      stores.holds.hold(
        scope,
        id,
        usdc(1n),
        [{ network: TESTNET, mandateInstanceId: fixture.instanceId, needed: usdc(1n) }],
        opts,
      ),
      stores.holds.oldestHeld(targetOf(fixture), 1, opts),
      stores.holds.release(scope, id, routeFor(fixture), opts),
      stores.holds.expire(scope, id, opts),
      stores.holds.maxHoldSeconds(scope, opts),
      stores.holds.requestOf(scope, id, opts),
      stores.holds.instanceOf(scope, id, opts),
      stores.mandates.list(scope, id, opts),
      stores.mandates.unrequested(scope, 'x', usdc(0n), opts),
      stores.destinations.list(scope, id, opts),
    ];
    const results = await Promise.allSettled(calls);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('never lets one tenant see or move another tenant hold', async () => {
    const owner = await payoutFixture(db);
    const other = await payoutFixture(db);
    const id = await heldPayout(owner);

    expect(await stores.holds.oldestHeld(targetOf(other), 10, OPTS)).toEqual([]);
    expect(await stores.holds.release(scopeOf(other), id, routeFor(owner), OPTS)).toBe(false);
    expect(await stores.holds.expire(scopeOf(other), id, OPTS)).toBe(false);
    expect(
      await stores.holds.hold(
        scopeOf(other),
        id,
        usdc(1n),
        [{ network: TESTNET, mandateInstanceId: owner.instanceId, needed: usdc(1n) }],
        OPTS,
      ),
    ).toBe(false);
    await expect(stores.holds.requestOf(scopeOf(other), id, OPTS)).rejects.toThrow(
      HeldPayoutUnreadableError,
    );
    await expect(stores.holds.instanceOf(scopeOf(other), owner.instanceId, OPTS)).rejects.toThrow(
      HeldPayoutUnreadableError,
    );
    expect(await stores.mandates.list(scopeOf(other), owner.mandateId as Id, OPTS)).toEqual([]);
    expect(
      await stores.mandates.unrequested(scopeOf(other), owner.instanceId, usdc(0n), OPTS),
    ).toEqual(usdc(0n));
    expect(await stores.destinations.list(scopeOf(other), owner.recipientId as Id, OPTS)).toEqual(
      [],
    );

    const { payout } = await stateOf(owner, id);
    expect(payout?.statusReason).toBe('awaiting_funding');
  });

  it('sees every project of the principal in a release job, and no other', async () => {
    const fixture = await payoutFixture(db);
    const first = await heldPayout(fixture);

    // A second project of the same principal, with its own mandate and payout.
    const projectId = await db
      .tenant(fixture.tenant)
      .transaction((tx) => projects.create(tx, { name: 'Second' }));
    const second = { principalId: fixture.tenant.principalId, projectId };
    const secondFixture = await db.tenant(second).transaction(async (tx) => {
      const recipient = await recipients.create(tx, {
        recipientRef: randomBytes(32),
        country: 'NG',
      });
      const mandate = await mandates.create(tx, { name: 'Second' });
      const instance = await mandateInstances.create(tx, {
        mandateId: mandate.id,
        chain: 'stellar',
        contractAddress: `C${randomUUID()}`,
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
      });
      return {
        ...fixture,
        tenant: { ...fixture.tenant, projectId },
        recipientId: recipient.id,
        mandateId: mandate.id,
        instanceId: instance.id,
      };
    });
    const other = await heldPayout(secondFixture);

    const stranger = await payoutFixture(db);
    await heldPayout(stranger);

    const held = await stores.holds.oldestHeld(targetOf(fixture), 50, OPTS);
    expect(held.map((h) => [h.payoutId, h.scope.projectId])).toEqual([
      [first, fixture.tenant.projectId],
      [other, projectId],
    ]);
  });
});
