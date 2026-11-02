// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Leases and the routing config, called the way the service calls them: as
// the app role, through the narrow functions, with no tenant context.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { executors, routingConfig } from './repositories/ops.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const NETWORK = 'stellar:testnet';

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

async function seed(count: number): Promise<void> {
  await admin.query('delete from ops.executor_accounts');
  for (let index = 0; index < count; index += 1) {
    await admin.query('insert into ops.executor_accounts (network, account_ref) values ($1, $2)', [
      NETWORK,
      `account-${String(index)}`,
    ]);
  }
}

const lease = async (holder: string, leaseSeconds = 60) =>
  db.unscoped(async (tx) => executors.lease(tx, { network: NETWORK, holder, leaseSeconds }));

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

beforeEach(async () => {
  await seed(2);
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('executor leases', () => {
  it('two concurrent leases never get the same account', async () => {
    for (let round = 0; round < 10; round += 1) {
      await seed(2);
      const [first, second] = await Promise.all([lease('worker-a'), lease('worker-b')]);
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first?.accountRef).not.toBe(second?.accountRef);
    }
  });

  it('gives every concurrent caller a different account, and none past the last', async () => {
    await seed(6);
    const leases = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => lease(`worker-${String(index)}`)),
    );
    const held = leases.flatMap((item) => (item === undefined ? [] : [item.accountRef]));
    // A caller that loses every race gets no row rather than waiting, so
    // fewer than six may win a round. None may share one.
    expect(new Set(held).size).toBe(held.length);
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThanOrEqual(6);
  });

  it('returns no account when every one is held, and frees one when its lease expires', async () => {
    await seed(1);
    expect(await lease('worker-a')).toBeDefined();
    expect(await lease('worker-b')).toBeUndefined();
    await admin.query(
      `update ops.executor_accounts set lease_expires_at = now() - interval '1 second'`,
    );
    expect((await lease('worker-b'))?.accountRef).toBe('account-0');
  });

  it('refuses a lease length outside 1 to 3600 seconds', async () => {
    for (const seconds of [0, 3601]) {
      await expect(lease('worker-a', seconds)).rejects.toMatchObject({ code: '22023' });
    }
  });

  it('lets only the holder release, and never moves the sequence backwards', async () => {
    await seed(1);
    const held = await lease('worker-a');
    const accountRef = held?.accountRef ?? '';
    const release = async (holder: string, sequenceReached: bigint) =>
      db.unscoped(async (tx) =>
        executors.release(tx, { network: NETWORK, accountRef, holder, sequenceReached }),
      );
    expect(await release('worker-b', 9n)).toBe(false);
    expect(await release('worker-a', 9007199254740993n)).toBe(true);
    // Above 2^53, so a number anywhere on the way would have rounded it.
    expect((await lease('worker-c'))?.nextSequence).toBe(9007199254740993n);
    expect(await release('worker-c', 1n)).toBe(true);
    expect((await lease('worker-d'))?.nextSequence).toBe(9007199254740993n);
  });

  it('has no row for an unknown network', async () => {
    expect(
      await db.unscoped(async (tx) =>
        executors.lease(tx, { network: 'stellar:other', holder: 'worker-a', leaseSeconds: 60 }),
      ),
    ).toBeUndefined();
  });
});

describe('routing config', () => {
  it('reads nothing before activation, then the active version only', async () => {
    expect(await db.unscoped(async (tx) => routingConfig.active(tx))).toBeUndefined();
    const inserted = await admin.query<{ version: string }>(
      `insert into ops.routing_config_versions (document, created_by) values
         ('{"v":1}', 'deploy.runbook'), ('{"v":2}', 'deploy.runbook') returning version`,
    );
    const second = inserted.rows[1]?.version ?? '';
    await admin.query('insert into ops.routing_config_active (version) values ($1)', [second]);
    const active = await db.unscoped(async (tx) => routingConfig.active(tx));
    expect(active).toEqual({ version: BigInt(second), document: { v: 2 } });
  });
});
