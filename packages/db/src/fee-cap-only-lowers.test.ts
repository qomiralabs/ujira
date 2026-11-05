// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A mandate's fee cap can only go down, and its fee address never changes, as in the
// contract. A principal agreed to a cap, and nothing here can raise it on them.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { asIndexer } from './testing/ledger-fixture.js';
import { payoutFixture, type PayoutFixture } from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const FEE_ADDRESS = 'GFEEADDRESS';

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;
let instanceId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function setCap(maxFeeBps: number, feeAddress = FEE_ADDRESS) {
  return asIndexer(db, fixture.tenant, async (tx) =>
    mandateInstances.setFeeCap(tx, instanceId, { maxFeeBps, feeAddress }),
  );
}

async function currentCap(): Promise<number | null | undefined> {
  const instance = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => mandateInstances.get(tx, instanceId));
  return instance?.maxFeeBps;
}

// Around the repository and every grant, the way a mistaken script would come.
async function asAdmin(statement: string): Promise<unknown> {
  const admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  try {
    return await admin.query(statement, [instanceId]);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  const instance = await db.tenant(fixture.tenant).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: 'Fees' });
    return mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
      maxFeeBps: 50,
      feeAddress: FEE_ADDRESS,
    });
  });
  instanceId = instance.id;
  expect(instance.maxFeeBps).toBe(50);
  expect(instance.feeAddress).toBe(FEE_ADDRESS);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the fee cap of an instance', () => {
  it('increase refused', async () => {
    expect(await codeOf(setCap(51))).toBe('UJ007');
    expect(await currentCap()).toBe(50);
  });

  it('fee_address change refused', async () => {
    expect(await codeOf(setCap(50, 'GSOMEONEELSE'))).toBe('UJ007');
  });

  it('a lower cap is accepted, and an equal one changes nothing', async () => {
    expect(await setCap(50)).toBe(true);
    expect(await setCap(10)).toBe(true);
    expect(await codeOf(setCap(11))).toBe('UJ007');
    expect(await currentCap()).toBe(10);
  });

  it('an instance with neither yet can have them set once', async () => {
    instanceId = fixture.instanceId;
    expect(await currentCap()).toBeNull();
    expect(await setCap(100)).toBe(true);
    expect(await codeOf(setCap(101))).toBe('UJ007');
  });

  it('cannot be raised or cleared by anyone, the superuser included', async () => {
    for (const assignment of ['max_fee_bps = 99', 'max_fee_bps = null', 'fee_address = null']) {
      const update = `update ujira.mandate_instances set ${assignment} where id = $1`;
      expect(await codeOf(asAdmin(update)), assignment).toBe('UJ007');
    }
    expect(await currentCap()).toBe(50);
  });

  // The contract holds the cap and the indexer mirrors it, so an API request can never
  // decide what a principal's cap is once the instance exists.
  it('is out of reach of the app', async () => {
    const attempt = db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        mandateInstances.setFeeCap(tx, instanceId, { maxFeeBps: 1, feeAddress: FEE_ADDRESS }),
      );
    expect(await codeOf(attempt)).toBe('42501');
  });

  it.each([101, -1])('refuses a cap of %s', async (maxFeeBps) => {
    instanceId = fixture.instanceId;
    expect(await codeOf(setCap(maxFeeBps))).toBe('23514');
  });
});
