// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The same contract the adapter's in-memory store meets, against the real tables. A
// clean database for each check, because the contract's factory promises an empty store.

import { randomUUID } from 'node:crypto';

import type { NetworkId, TenantScope, UnixSeconds, Uuid } from '@ujira/chain-adapter';
import { describeAdapterStore } from '@ujira/chain-adapter/testing';
import pg from 'pg';
import { afterAll, inject } from 'vitest';

import type { Database } from './database.js';
import { DatabaseAdapterStore } from './repositories/adapter-store.js';
import { entryPoints } from './repositories/entry-points.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const NETWORK: NetworkId = 'stellar:testnet';
const OTHER_NETWORK: NetworkId = 'stellar:pubnet';
const EXECUTORS = 2;

const open: {
  readonly db: Database;
  readonly database: TestDatabase;
  readonly admin: pg.Client;
}[] = [];

async function principal(db: Database): Promise<TenantScope> {
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  return { principalId: created.principalId as Uuid, projectId: created.projectId as Uuid };
}

afterAll(async () => {
  for (const { db, database, admin } of open) {
    await admin.end();
    await db.close();
    await database.drop();
  }
});

describeAdapterStore('database', async () => {
  const database = await createTestDatabase(adminUrl, `${import.meta.url}#${randomUUID()}`);
  const db = databaseAsServiceRoles(roleUrls, database, 2);
  const admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  open.push({ db, database, admin });

  for (let index = 0; index < EXECUTORS; index += 1) {
    await admin.query(
      `insert into ops.executor_accounts (network, account_ref, key_id, next_sequence)
       values ($1, $2, $3, 100)`,
      [NETWORK, `GEXECUTOR${String(index)}`, `key-${String(index)}`],
    );
  }

  let offset = 0n;
  const now = (): UnixSeconds => (BigInt(Math.floor(Date.now() / 1000)) + offset) as UnixSeconds;
  return {
    store: new DatabaseAdapterStore({ db, clock: now }),
    network: NETWORK,
    otherNetwork: OTHER_NETWORK,
    scope: await principal(db),
    otherScope: await principal(db),
    executors: EXECUTORS,
    now,
    // Leases run on the database's clock, so time passing is their expiry moving back.
    advance: async (seconds) => {
      offset += seconds;
      await admin.query(
        `update ops.executor_accounts
            set lease_expires_at = lease_expires_at - make_interval(secs => $1)
          where lease_expires_at is not null`,
        [Number(seconds)],
      );
    },
  };
});
