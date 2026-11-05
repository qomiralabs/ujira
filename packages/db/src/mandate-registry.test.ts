// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The registry and the bookings against a real server, under the roles that use
// them, so the unique keys and the grants are the ones in the migrations.

import { randomBytes, randomUUID } from 'node:crypto';

import { sql, type RawBuilder } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import {
  mandateEventStore,
  mandateRegistry,
  payoutBookings,
  type MandateFlagReason,
  type NewMandateRegistration,
} from './repositories/mandate-registry.js';
import { chainEvents, mandateInstances, mandates } from './repositories/mandates.js';
import type { MandateInstance } from './repositories/mandates.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const NETWORK = 'stellar:testnet';
const FINALIZED_AT = '2026-11-02T00:00:00.000Z';
const hex = (bytes: Buffer): `0x${string}` => `0x${bytes.toString('hex')}`;

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;
let other: CreatedPrincipal;
let store: ReturnType<typeof mandateEventStore>;

async function newInstance(context: ProjectContext): Promise<MandateInstance> {
  return db.tenant(context).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: 'Payroll' });
    return mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
  });
}

function registration(over: Partial<NewMandateRegistration> = {}): NewMandateRegistration {
  return {
    network: NETWORK,
    contractId: `C${randomUUID()}`,
    factory: 'CFACTORY',
    tenantTag: hex(randomBytes(32)),
    txHash: randomBytes(32).toString('hex'),
    eventIndex: 0n,
    ledger: 5n,
    ...over,
  };
}

function booking(instance: MandateInstance, context: ProjectContext, payoutId: `0x${string}`) {
  return {
    tenant: { scope: context, mandateInstanceId: instance.id },
    network: NETWORK,
    contractId: instance.contractAddress,
    txHash: randomBytes(32).toString('hex'),
    eventIndex: 0n,
    ledger: 7n,
    closedAt: FINALIZED_AT,
    name: 'payout_requested',
    payload: { total: '100', payout_id: payoutId },
    payoutId,
  };
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  return work.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );
}

async function listOf(context: ProjectContext, instanceId: string) {
  return db
    .tenant(context)
    .transaction(async (tx) => payoutBookings.list(tx, instanceId, { limit: 100 }));
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  const create = (name: string) =>
    db.unscoped(async (tx) =>
      entryPoints.createPrincipal(tx, {
        name,
        projectName: 'Main',
        ownerUserId: randomUUID(),
      }),
    );
  tenant = await create('Acme');
  other = await create('Other');
  store = mandateEventStore(db, (network) => network.split(':')[0] ?? network);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the mandate registry', () => {
  it('registers a contract once, and a replay cannot move it to another factory or tag', async () => {
    const first = registration();
    expect(await store.register(first)).toBe(true);
    expect(
      await store.register({ ...first, factory: 'CROGUE', tenantTag: hex(randomBytes(32)) }),
    ).toBe(false);
    expect(await store.registered(NETWORK, first.contractId)).toEqual({
      network: NETWORK,
      contractId: first.contractId,
      factory: 'CFACTORY',
      tenantTag: first.tenantTag,
      flagged: false,
    });
  });

  it('answers nothing for a contract that was never registered', async () => {
    expect(await store.registered(NETWORK, `C${randomUUID()}`)).toBeNull();
  });

  it('keeps one contract id apart on each network', async () => {
    const first = registration();
    await store.register(first);
    expect(await store.registered('stellar:pubnet', first.contractId)).toBeNull();
    expect(await store.register({ ...first, network: 'stellar:pubnet' })).toBe(true);
  });

  it('flags a contract for good', async () => {
    const first = registration();
    await store.register(first);
    await store.flag(NETWORK, first.contractId, 'tenant_tag_mismatch');
    await store.register(first);
    expect((await store.registered(NETWORK, first.contractId))?.flagged).toBe(true);
  });

  it('says when there was nothing to flag', async () => {
    const found = await db.unscoped(
      async (tx) => mandateRegistry.flag(tx, NETWORK, `C${randomUUID()}`, 'public_test_attester'),
      'worker',
    );
    expect(found).toBe(false);
  });

  const alertsOf = async (contractId: string) => {
    const all = await db.unscoped(async (tx) => mandateRegistry.alertsAfter(tx, 0n, 100), 'worker');
    return all.filter((alert) => alert.contractId === contractId).map((alert) => alert.reason);
  };

  it('raises an alert with a flag, once per reason however often it is flagged', async () => {
    const first = registration();
    await store.register(first);
    await store.flag(NETWORK, first.contractId, 'public_test_attester');
    await store.flag(NETWORK, first.contractId, 'public_test_attester');
    expect(await alertsOf(first.contractId)).toEqual(['public_test_attester']);
    await store.flag(NETWORK, first.contractId, 'tenant_tag_mismatch');
    expect(await alertsOf(first.contractId)).toEqual([
      'public_test_attester',
      'tenant_tag_mismatch',
    ]);
  });

  it('commits a flag and its alert together or not at all', async () => {
    const first = registration();
    await store.register(first);
    const rolledBack = db.unscoped(async (tx) => {
      await mandateRegistry.flag(tx, NETWORK, first.contractId, 'public_test_attester');
      throw new Error('after the flag');
    }, 'worker');
    await expect(rolledBack).rejects.toThrow('after the flag');
    expect((await store.registered(NETWORK, first.contractId))?.flagged).toBe(false);
    expect(await alertsOf(first.contractId)).toEqual([]);
  });

  it('does not flag when the alert cannot be raised', async () => {
    const first = registration();
    await store.register(first);
    const unknown = 'no_such_reason' as MandateFlagReason;
    expect(await codeOf(store.flag(NETWORK, first.contractId, unknown))).toBe('23514');
    expect((await store.registered(NETWORK, first.contractId))?.flagged).toBe(false);
  });

  it('keeps raising an alert for the two argument form the last release calls', async () => {
    const first = registration();
    await store.register(first);
    await db.unscoped(
      async (tx) => sql`select ops.flag_mandate(${NETWORK}, ${first.contractId})`.execute(tx),
      'worker',
    );
    expect((await store.registered(NETWORK, first.contractId))?.flagged).toBe(true);
    expect(await alertsOf(first.contractId)).toEqual(['tenant_tag_mismatch']);
  });

  it('reads alerts from where the reader stopped, and only the indexer can', async () => {
    const first = registration();
    await store.register(first);
    await store.flag(NETWORK, first.contractId, 'public_test_attester');
    const read = (after: bigint) =>
      db.unscoped(async (tx) => mandateRegistry.alertsAfter(tx, after, 100), 'worker');
    const found = (await read(0n)).find((alert) => alert.contractId === first.contractId);
    expect(found).toMatchObject({ network: NETWORK, reason: 'public_test_attester' });
    expect(found?.raisedAt).toBeInstanceOf(Date);
    const ids = (await read(found?.id ?? 0n)).map((alert) => alert.id);
    expect(ids).not.toContain(found?.id);
    expect(await codeOf(db.unscoped(async (tx) => mandateRegistry.alertsAfter(tx, 0n, 10)))).toBe(
      '42501',
    );
  });

  it('refuses a tag or a transaction of the wrong length', async () => {
    const short = hex(randomBytes(31));
    expect(await codeOf(store.register(registration({ tenantTag: short })))).toBe('23514');
    expect(await codeOf(store.register(registration({ txHash: 'ab' })))).toBe('23514');
  });

  it('can be read by the app, and only the indexer can add to it or flag it', async () => {
    const first = registration();
    await store.register(first);
    const read = await db.unscoped(async (tx) =>
      mandateRegistry.find(tx, NETWORK, first.contractId),
    );
    expect(read?.factory).toBe('CFACTORY');
    expect(
      await codeOf(db.unscoped(async (tx) => mandateRegistry.register(tx, registration()))),
    ).toBe('42501');
    expect(
      await codeOf(
        db.unscoped(async (tx) =>
          mandateRegistry.flag(tx, NETWORK, first.contractId, 'public_test_attester'),
        ),
      ),
    ).toBe('42501');
  });

  it('cannot be read or written directly by the indexer or the app', async () => {
    for (const role of ['worker', 'app'] as const) {
      const run = (statement: RawBuilder<unknown>) =>
        codeOf(db.unscoped(async (tx) => statement.execute(tx), role));
      expect(await run(sql`select * from ops.mandate_registry`), role).toBe('42501');
      expect(await run(sql`update ops.mandate_registry set flagged_at = null`), role).toBe('42501');
      expect(await run(sql`select * from ops.mandate_alerts`), role).toBe('42501');
      expect(await run(sql`delete from ops.mandate_alerts`), role).toBe('42501');
    }
  });
});

describe('finding the tenant of a contract', () => {
  it('finds the tenant that claims it, and nothing when none does', async () => {
    const instance = await newInstance(tenant);
    expect(await store.tenantOf(NETWORK, instance.contractAddress)).toEqual({
      scope: { principalId: tenant.principalId, projectId: tenant.projectId },
      mandateInstanceId: instance.id,
    });
    expect(await store.tenantOf(NETWORK, `C${randomUUID()}`)).toBeNull();
  });
});

describe('payout bookings', () => {
  it('two mandates with an equal payout_id book as two payments', async () => {
    const payoutId = hex(randomBytes(32));
    const first = await newInstance(tenant);
    const second = await newInstance(tenant);
    expect(await store.book(booking(first, tenant, payoutId))).toBe(true);
    expect(await store.book(booking(second, tenant, payoutId))).toBe(true);
    const [a, b] = await Promise.all([listOf(tenant, first.id), listOf(tenant, second.id)]);
    expect(a.items.map((x) => x.contractAddress)).toEqual([first.contractAddress]);
    expect(b.items.map((x) => x.contractAddress)).toEqual([second.contractAddress]);
  });

  it('the same payout of one contract stays one booking, whatever moves it', async () => {
    const payoutId = hex(randomBytes(32));
    const instance = await newInstance(tenant);
    await store.book(booking(instance, tenant, payoutId));
    await store.book({ ...booking(instance, tenant, payoutId), name: 'payout_executed' });
    const page = await listOf(tenant, instance.id);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.lastEventType).toBe('payout_executed');
    expect(page.items[0]?.payoutId.toString('hex')).toBe(payoutId.slice(2));
  });

  it('a replayed event writes nothing and moves nothing', async () => {
    const payoutId = hex(randomBytes(32));
    const instance = await newInstance(tenant);
    const requested = booking(instance, tenant, payoutId);
    await store.book(requested);
    await store.book({ ...booking(instance, tenant, payoutId), name: 'payout_executed' });
    expect(await store.book(requested)).toBe(false);
    const page = await listOf(tenant, instance.id);
    expect(page.items[0]?.lastEventType).toBe('payout_executed');
  });

  it('stores an event with no payout, and books nothing for it', async () => {
    const instance = await newInstance(tenant);
    expect(
      await store.book({ ...booking(instance, tenant, hex(randomBytes(32))), payoutId: null }),
    ).toBe(true);
    expect((await listOf(tenant, instance.id)).items).toEqual([]);
    const events = await db
      .tenant(tenant)
      .transaction(async (tx) => chainEvents.list(tx, instance.id, { limit: 10 }));
    expect(events.items).toHaveLength(1);
  });

  it('enforces the key with a constraint, not with the code that calls it', async () => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const found = await admin.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
          where conname = 'payout_bookings_once'`,
      );
      expect(found.rows[0]?.definition).toBe('UNIQUE (chain, contract_address, payout_id)');
    } finally {
      await admin.end();
    }
  });

  it('refuses a booking that names a contract other than its instance', async () => {
    const first = await newInstance(tenant);
    const second = await newInstance(tenant);
    const payoutId = randomBytes(32);
    const code = await codeOf(
      db.withTenant('worker', { ...tenant, scope: 'project' }, async (tx) => {
        const event = await chainEvents.record(tx, {
          mandateInstanceId: first.id,
          chain: 'stellar',
          txHash: randomBytes(32),
          eventIndex: 0n,
          ledger: 1n,
          eventType: 'payout_requested',
          payload: {},
          finalizedAt: new Date(FINALIZED_AT),
        });
        return payoutBookings.apply(tx, {
          mandateInstanceId: first.id,
          chain: 'stellar',
          contractAddress: second.contractAddress,
          payoutId,
          eventId: event.id ?? '',
          eventType: 'payout_requested',
        });
      }),
    );
    expect(code).toBe('23503');
  });

  it('is written by the indexer and only read by the app', async () => {
    const instance = await newInstance(tenant);
    const code = await codeOf(
      db.tenant(tenant).transaction(async (tx) =>
        payoutBookings.apply(tx, {
          mandateInstanceId: instance.id,
          chain: 'stellar',
          contractAddress: instance.contractAddress,
          payoutId: randomBytes(32),
          eventId: randomUUID(),
          eventType: 'payout_requested',
        }),
      ),
    );
    expect(code).toBe('42501');
  });

  it('reads one booking back and pages them', async () => {
    const instance = await newInstance(tenant);
    await store.book(booking(instance, tenant, hex(randomBytes(32))));
    await store.book(booking(instance, tenant, hex(randomBytes(32))));
    const first = await db
      .tenant(tenant)
      .transaction(async (tx) => payoutBookings.list(tx, instance.id, { limit: 1 }));
    expect(first.items).toHaveLength(1);
    const after = first.items[0]?.id ?? '';
    const second = await db
      .tenant(tenant)
      .transaction(async (tx) => payoutBookings.list(tx, instance.id, { limit: 1, after }));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(after);
    const one = await db.tenant(tenant).transaction(async (tx) => payoutBookings.get(tx, after));
    expect(one?.id).toBe(after);
    const none = await db.tenant(other).transaction(async (tx) => payoutBookings.get(tx, after));
    expect(none).toBeUndefined();
  });
});
