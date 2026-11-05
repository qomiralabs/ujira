// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// An attempt and a hold are on a network, such as stellar:testnet, and the chain is
// only part of the unit their money is in. A deposit releases holds by network, so a
// hold filed under the chain name would never be found and the funds would stay held.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { fundingHolds, payoutAttempts, payouts } from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newAttempt,
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

describe('an attempt', () => {
  function attempt(network: string) {
    return newAttempt(fixture, payoutId, { network });
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
