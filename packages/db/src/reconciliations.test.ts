// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for recording reconciliations (repositories/reconciliations.ts) and for
 * listing what to reconcile (entryPoints.reconcileTargets).
 *
 * - A comparison stores what state() said, sets the books beside it, and records the
 *   outcome on the instance: a match sets last_reconciled_at and clears any mark, a
 *   mismatch marks the instance from the first run it was seen and says so once.
 * - Nothing it does changes a ledger balance.
 * - The target list names every active or paused instance with its tenant, a page at
 *   a time, to the indexer's login and to no other.
 */

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { reconciliations } from './repositories/reconciliations.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  asIndexer,
  deposit,
  ledgerFixture,
  postEvent,
  type LedgerFixture,
} from './testing/ledger-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

async function asAdmin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const setStatus = (fixture: LedgerFixture, status: string) =>
  asAdmin((client) =>
    client.query('update ujira.mandate_instances set status = $1 where id = $2', [
      status,
      fixture.instanceId,
    ]),
  );

const record = (fixture: LedgerFixture, ledger: bigint, balance: bigint) =>
  asIndexer(db, fixture.tenant, (tx) =>
    reconciliations.record(tx, {
      mandateInstanceId: fixture.instanceId,
      ledger,
      balance,
      pending: 0n,
      committed: 0n,
      spent: 0n,
    }),
  );

describe('recording a reconciliation', () => {
  it('matching state records last_reconciled_at', async () => {
    const fixture = await ledgerFixture(db);
    await postEvent(db, fixture, deposit(250n));
    const row = await record(fixture, 10n, 250n);
    expect(row).toMatchObject({ matches: true, ledger: 10n, newlyDiverged: false });
    expect(row.lastReconciledAt).toBeInstanceOf(Date);
    expect(row.divergedSince).toBeNull();
    expect(row.books).toMatchObject({ balance: 250n });
    const read = await asIndexer(db, fixture.tenant, (tx) =>
      reconciliations.get(tx, fixture.instanceId),
    );
    expect(read?.lastReconciledAt).toEqual(row.lastReconciledAt);
  });

  it('a mismatch marks the instance once, keeps the last good time, and clears when fixed', async () => {
    const fixture = await ledgerFixture(db);
    await postEvent(db, fixture, deposit(250n));
    const good = await record(fixture, 10n, 250n);
    const apart = await record(fixture, 11n, 300n);
    expect(apart).toMatchObject({ matches: false, newlyDiverged: true });
    expect(apart.state).toMatchObject({ balance: 300n });
    expect(apart.books).toMatchObject({ balance: 250n });
    expect(apart.lastReconciledAt).toEqual(good.lastReconciledAt);
    const still = await record(fixture, 12n, 300n);
    expect(still).toMatchObject({ matches: false, newlyDiverged: false });
    expect(still.divergedSince).toEqual(apart.divergedSince);
    const fixed = await record(fixture, 13n, 250n);
    expect(fixed).toMatchObject({ matches: true, divergedSince: null });
    // Comparing never touches the books.
    const balance = await asAdmin((client) =>
      client.query<{ balance: string }>(
        "select balance from ujira.ledger_accounts where mandate_instance_id = $1 and kind = 'balance'",
        [fixture.instanceId],
      ),
    );
    expect(balance.rows[0]?.balance).toBe('250');
  });

  it('cannot record against, or read, another tenant', async () => {
    const mine = await ledgerFixture(db);
    const theirs = await ledgerFixture(db);
    await record(theirs, 5n, 0n);
    await expect(
      asIndexer(db, mine.tenant, (tx) =>
        reconciliations.record(tx, {
          mandateInstanceId: theirs.instanceId,
          ledger: 6n,
          balance: 0n,
          pending: 0n,
          committed: 0n,
          spent: 0n,
        }),
      ),
    ).rejects.toThrow();
    expect(
      await asIndexer(db, mine.tenant, (tx) => reconciliations.get(tx, theirs.instanceId)),
    ).toBeUndefined();
    expect(
      await db.tenant(mine.tenant).transaction((tx) => reconciliations.get(tx, theirs.instanceId)),
    ).toBeUndefined();
  });
});

describe('what to reconcile', () => {
  it('names every active or paused instance with its tenant, a page at a time', async () => {
    const fixtures = await Promise.all(Array.from({ length: 5 }, () => ledgerFixture(db)));
    const statuses = ['active', 'paused', 'revoked', 'deploying', 'active'];
    for (const [i, fixture] of fixtures.entries()) await setStatus(fixture, statuses[i] ?? '');
    const wanted = new Set(
      fixtures
        .filter((_, i) => ['active', 'paused'].includes(statuses[i] ?? ''))
        .map((f) => f.instanceId),
    );
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await db.unscoped(
        (tx) =>
          entryPoints.reconcileTargets(tx, { limit: 2, ...(after === undefined ? {} : { after }) }),
        'indexer',
      );
      for (const target of page.items) {
        seen.push(target.mandateInstanceId);
        const own = fixtures.find((f) => f.instanceId === target.mandateInstanceId);
        if (own !== undefined) {
          expect(target).toMatchObject({
            principalId: own.tenant.principalId,
            projectId: own.tenant.projectId,
            network: 'stellar:testnet',
          });
        }
      }
      if (page.next === null) break;
      after = page.next;
    }
    expect(new Set(seen.filter((id) => wanted.has(id)))).toEqual(wanted);
    expect(seen.some((id) => !wanted.has(id) && fixtures.some((f) => f.instanceId === id))).toBe(
      false,
    );
    expect([...seen].sort()).toEqual(seen);
  });

  it('is for the indexer alone', async () => {
    await expect(
      db.unscoped((tx) => entryPoints.reconcileTargets(tx, { limit: 1 }), 'app'),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
