// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A mandate instance moves only on what the chain says: the event intake reads a
// trusted factory's creation and the mandate's own pause, resume and revocation, and
// moves the instance through the indexer's login. No login the API holds can.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { createEventIntake } from '@ujira/chain-adapter';
import type {
  Bytes32,
  EventIntakeStore,
  LedgerEvent,
  NetworkId,
  TenantScope,
} from '@ujira/chain-adapter';
import { contractOf } from '@ujira/identity/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { mandateEventStore } from './repositories/mandate-registry.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const NETWORK: NetworkId = 'stellar:testnet';
const FACTORY = contractOf('lifecycle:factory');
const OTHER_FACTORY = contractOf('lifecycle:other-factory');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

// A tag that depends on the tenant and the address, as the real one does.
function tagFor(scope: TenantScope, contract: string): Bytes32 {
  const digest = createHash('sha256').update(`${scope.projectId}:${contract}`).digest('hex');
  return `0x${digest}` as Bytes32;
}

function intake() {
  // The indexer's adapter only brands the database's strings; the rows are the same.
  const store = mandateEventStore(db, () => 'stellar') as unknown as EventIntakeStore;
  return createEventIntake({
    network: NETWORK,
    store,
    trustedFactories: () => [FACTORY],
    tenantTagFor: tagFor,
  });
}

let ledger = 100n;

function ledgerEvent(over: Partial<LedgerEvent>): LedgerEvent {
  ledger += 1n;
  return {
    network: NETWORK,
    contractId: FACTORY,
    type: 'contract',
    successful: true,
    txHash: randomBytes(32).toString('hex'),
    eventIndex: 0n,
    ledger,
    closedAt: new Date().toISOString(),
    name: null,
    key: null,
    fields: null,
    ...over,
  };
}

async function claimed() {
  const tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Lifecycle',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  const scope = { principalId: tenant.principalId, projectId: tenant.projectId } as TenantScope;
  const contract = contractOf(`lifecycle:${randomUUID()}`);
  const instance = await db.tenant(scope).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: 'Lifecycle' });
    return mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      network: NETWORK,
      contractAddress: contract,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
  });
  const tag = tagFor(scope, contract);
  const creation = (factory = FACTORY) =>
    ledgerEvent({
      contractId: factory,
      name: 'mandate_created',
      key: tag,
      fields: { mandate: contract, principal: 'GPRINCIPAL', asset: 'CUSDC' },
    });
  const own = (name: string) =>
    ledgerEvent({ contractId: contract, name, key: tag, fields: { by: 'principal' } });
  const status = async () => {
    const result = await admin.query<{ status: string }>(
      'select status from ujira.mandate_instances where id = $1',
      [instance.id],
    );
    return result.rows[0]?.status;
  };
  return { scope, instance, creation, own, status };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('a mandate instance through its life', () => {
  it('becomes active only once its trusted factory creation is read, and once', async () => {
    const world = await claimed();
    const read = intake();
    expect(await world.status()).toBe('deploying');
    await read.ingest(world.creation(OTHER_FACTORY));
    expect(await world.status()).toBe('deploying');
    const creation = world.creation();
    expect(await read.ingest(creation)).toMatchObject({ action: 'registered' });
    expect(await world.status()).toBe('active');
    // The same creation read again, or another one, moves nothing.
    await read.ingest(creation);
    await read.ingest(world.creation());
    expect(await world.status()).toBe('active');
  });

  it('follows the pause, resume and revocation the chain reports, and a replay moves nothing', async () => {
    const world = await claimed();
    const read = intake();
    await read.ingest(world.creation());
    const pause = world.own('paused');
    await read.ingest(pause);
    expect(await world.status()).toBe('paused');
    await read.ingest(world.own('resumed'));
    expect(await world.status()).toBe('active');
    await read.ingest(pause);
    expect(await world.status()).toBe('active');
    await read.ingest(world.own('revoked'));
    await read.ingest(world.own('resumed'));
    expect(await world.status()).toBe('revoked');
  });

  it('cannot be moved by the API login, through the repository or around it', async () => {
    const world = await claimed();
    const asApp = db.tenant(world.scope);
    expect(
      await codeOf(
        asApp.transaction(async (tx) => mandateInstances.move(tx, world.instance.id, 'created')),
      ),
    ).toBe('42501');
    expect(
      await codeOf(
        asApp.transaction(async (tx) => {
          await sql`update ujira.mandate_instances set status = 'active' where id = ${world.instance.id}`.execute(
            tx,
          );
        }),
      ),
    ).toBe('42501');
    expect(await world.status()).toBe('deploying');
  });

  it("moves only from the state a move starts from, under the indexer's login", async () => {
    const world = await claimed();
    const asIndexer = (move: 'created' | 'paused' | 'resumed' | 'revoked') =>
      db.withTenant('indexer', { ...world.scope, scope: 'project' }, async (tx) =>
        mandateInstances.move(tx, world.instance.id, move),
      );
    expect(await asIndexer('paused')).toBe(false);
    expect(await asIndexer('resumed')).toBe(false);
    expect(await asIndexer('created')).toBe(true);
    expect(await asIndexer('created')).toBe(false);
    expect(await asIndexer('paused')).toBe(true);
    expect(await asIndexer('resumed')).toBe(true);
    expect(await asIndexer('revoked')).toBe(true);
    expect(await asIndexer('revoked')).toBe(false);
    expect(await asIndexer('created')).toBe(false);
    expect(await world.status()).toBe('revoked');
  });
});
