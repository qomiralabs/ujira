// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// An attempt and a hold are on a network, such as stellar:testnet, and the chain is
// only part of the unit their money is in. A deposit releases holds by network, so a
// hold filed under the chain name would never be found and the funds would stay held.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { fundingHolds, payoutAttempts, payouts } from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newPayout,
  ONE_USDC,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TESTNET = 'stellar:testnet';
const PUBNET = 'stellar:pubnet';

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

async function hold(networks: readonly string[]): Promise<boolean> {
  return db.tenant(fixture.tenant).transaction(async (tx) =>
    fundingHolds.hold(
      tx,
      payoutId,
      networks.map((network) => ({
        mandateInstanceId: fixture.instanceId,
        network,
        needed: usdc(5n * ONE_USDC),
      })),
    ),
  );
}

async function onNetwork(network: string) {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) => fundingHolds.oldestOnNetwork(tx, network, 10));
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

describe('a funding hold', () => {
  it('is filed under its network, where a release looks for it', async () => {
    expect(await hold([TESTNET])).toBe(true);
    const found = await onNetwork(TESTNET);
    expect(found.map((row) => [row.payoutId, row.network])).toEqual([[payoutId, TESTNET]]);
    expect(found[0]?.needed).toEqual(usdc(5n * ONE_USDC));
  });

  it('is not found under the chain name, or under another network', async () => {
    await hold([TESTNET]);
    expect(await onNetwork('stellar')).toEqual([]);
    expect(await onNetwork(PUBNET)).toEqual([]);
  });

  it('refuses a chain name, or a network that does not exist', async () => {
    expect(await codeOf(hold(['stellar']))).toBe('23514');
    expect(await codeOf(hold(['stellar:mainnet']))).toBe('23514');
  });
});

// Money sent on one network cannot reach a mandate on another, so an attempt or a
// hold naming the wrong one would wait for something that can never happen.
describe('the network of the instance', () => {
  // A mandate has one instance per chain and asset, so being on the other network
  // takes a mandate of its own.
  async function onPubnet(): Promise<{ readonly instanceId: string; readonly payoutId: string }> {
    return db.tenant(fixture.tenant).transaction(async (tx) => {
      const mandate = await mandates.create(tx, { name: 'Pubnet' });
      const instance = await mandateInstances.create(tx, {
        network: PUBNET,
        mandateId: mandate.id,
        chain: 'stellar',
        contractAddress: `C${randomUUID()}`,
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
      });
      const { payout } = await payouts.create(tx, newPayout({ ...fixture, mandateId: mandate.id }));
      return { instanceId: instance.id, payoutId: payout.id };
    });
  }

  const holdOn = async (forPayout: string, mandateInstanceId: string, network: string) =>
    db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        fundingHolds.hold(tx, forPayout, [
          { mandateInstanceId, network, needed: usdc(5n * ONE_USDC) },
        ]),
      );

  const attemptOn = async (forPayout: string, mandateInstanceId: string, network: string) =>
    db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutAttempts.create(tx, {
        payoutId: forPayout,
        mandateInstanceId,
        network,
        total: usdc(5n * ONE_USDC),
        deadline: new Date(Date.now() + 3_600_000),
      }),
    );

  async function asOwner<T>(work: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      return await work(admin);
    } finally {
      await admin.end();
    }
  }

  it('refuses a pubnet hold on a testnet instance', async () => {
    expect(await codeOf(holdOn(payoutId, fixture.instanceId, PUBNET))).toBe('UJ014');
    expect(await onNetwork(PUBNET)).toEqual([]);
  });

  it('refuses a testnet hold on a pubnet instance', async () => {
    const other = await onPubnet();
    expect(await codeOf(holdOn(other.payoutId, other.instanceId, TESTNET))).toBe('UJ014');
    expect(await onNetwork(TESTNET)).toEqual([]);
  });

  it('holds on the network of the instance, on pubnet as well', async () => {
    const other = await onPubnet();
    expect(await holdOn(other.payoutId, other.instanceId, PUBNET)).toBe(true);
    expect((await onNetwork(PUBNET)).map((row) => row.payoutId)).toEqual([other.payoutId]);
  });

  it('refuses a pubnet attempt on a testnet instance', async () => {
    expect(await codeOf(attemptOn(payoutId, fixture.instanceId, PUBNET))).toBe('UJ014');
  });

  it('refuses a testnet attempt on a pubnet instance', async () => {
    const other = await onPubnet();
    expect(await codeOf(attemptOn(other.payoutId, other.instanceId, TESTNET))).toBe('UJ014');
  });

  it('makes an attempt on the network of the instance, on pubnet as well', async () => {
    const other = await onPubnet();
    const written = await attemptOn(other.payoutId, other.instanceId, PUBNET);
    expect(written.network).toBe(PUBNET);
  });

  it('refuses an attempt on the wrong network, whoever writes it', async () => {
    const insert = asOwner(async (admin) =>
      admin.query(
        `insert into ujira.payout_attempts
           (principal_id, project_id, payout_id, attempt_number, chain, network,
            mandate_instance_id, total_amount, asset, scale, deadline)
         values ($1, $2, $3, 1, 'stellar', $4, $5, 10, 'USDC', 7, now())`,
        [
          fixture.tenant.principalId,
          fixture.tenant.projectId,
          payoutId,
          PUBNET,
          fixture.instanceId,
        ],
      ),
    );
    expect(await codeOf(insert)).toBe('UJ014');
  });

  it('refuses a hold on the wrong network, whoever writes it', async () => {
    const insert = asOwner(async (admin) =>
      admin.query(
        `insert into ujira.payout_funding_holds
           (principal_id, project_id, payout_id, network, chain, mandate_instance_id,
            needed_amount, asset, scale)
         values ($1, $2, $3, $4, 'stellar', $5, 10, 'USDC', 7)`,
        [
          fixture.tenant.principalId,
          fixture.tenant.projectId,
          payoutId,
          PUBNET,
          fixture.instanceId,
        ],
      ),
    );
    expect(await codeOf(insert)).toBe('UJ014');
  });

  it('refuses moving an attempt or a hold onto another network afterwards', async () => {
    const written = await attemptOn(payoutId, fixture.instanceId, TESTNET);
    await holdOn(payoutId, fixture.instanceId, TESTNET);
    const moved = asOwner(async (admin) =>
      admin.query('update ujira.payout_attempts set network = $1 where id = $2', [
        PUBNET,
        written.id,
      ]),
    );
    expect(await codeOf(moved)).toBe('UJ014');
    const movedHold = asOwner(async (admin) =>
      admin.query('update ujira.payout_funding_holds set network = $1 where payout_id = $2', [
        PUBNET,
        payoutId,
      ]),
    );
    expect(await codeOf(movedHold)).toBe('UJ014');
  });

  it('refuses pointing an attempt at an instance on another network afterwards', async () => {
    const written = await attemptOn(payoutId, fixture.instanceId, TESTNET);
    const other = await onPubnet();
    const moved = asOwner(async (admin) =>
      admin.query('update ujira.payout_attempts set mandate_instance_id = $1 where id = $2', [
        other.instanceId,
        written.id,
      ]),
    );
    expect(await codeOf(moved)).toBe('UJ014');
  });
});

describe('an attempt', () => {
  function attempt(network: string) {
    return {
      payoutId,
      mandateInstanceId: fixture.instanceId,
      network,
      total: usdc(5n * ONE_USDC),
      deadline: new Date(Date.now() + 3_600_000),
    };
  }

  it('records its network, and keeps the chain in its unit', async () => {
    const written = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutAttempts.create(tx, attempt(TESTNET)));
    expect(written.network).toBe(TESTNET);
    expect(written.total).toEqual(usdc(5n * ONE_USDC));
    const read = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutAttempts.get(tx, written.id));
    expect(read?.network).toBe(TESTNET);
  });

  it('refuses a chain name, or a network that does not exist', async () => {
    const session = db.tenant(fixture.tenant);
    expect(
      await codeOf(
        session.transaction(async (tx) => payoutAttempts.create(tx, attempt('stellar'))),
      ),
    ).toBe('23514');
    expect(
      await codeOf(
        session.transaction(async (tx) => payoutAttempts.create(tx, attempt('stellar:mainnet'))),
      ),
    ).toBe('23514');
  });

  it('refuses a network on another chain than its unit, even directly', async () => {
    // Only one chain is settled today, so the mismatch has to be made by hand: a
    // network from a chain the unit is not on.
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query('begin');
      await admin.query(`alter domain ujira.network_id drop constraint network_id_known`);
      expect(
        await codeOf(
          admin.query(
            `insert into ujira.payout_attempts
               (principal_id, project_id, payout_id, attempt_number, chain, network,
                mandate_instance_id, total_amount, asset, scale, deadline)
             values ($1, $2, $3, 1, 'stellar', 'other:testnet', $4, 10, 'USDC', 7, now())`,
            [fixture.tenant.principalId, fixture.tenant.projectId, payoutId, fixture.instanceId],
          ),
        ),
      ).toBe('23514');
      await admin.query('rollback');
    } finally {
      await admin.end();
    }
  });
});
