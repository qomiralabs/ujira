// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mirror of what happened on chain, written the way the indexer writes it:
// find the tenant of a contract, then write under that tenant's context.

import { randomBytes, randomUUID } from 'node:crypto';

import { I128_MAX, tokenAmount } from '@ujira/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import {
  chainEvents,
  deposits,
  fundingSources,
  instanceRoles,
  mandateInstances,
  mandates,
  type MandateInstance,
} from './repositories/mandates.js';
import type { Schema } from './schema.generated.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const FINALIZED_AT = new Date('2026-10-31T00:00:00.000Z');

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;
let instance: MandateInstance;

async function asIndexer<T>(
  context: ProjectContext,
  work: (tx: Kysely<Schema>) => Promise<T>,
): Promise<T> {
  return db.withTenant('indexer', { ...context, scope: 'project' }, work);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function event(overrides: { txHash?: Buffer; eventIndex?: bigint; chain?: string } = {}) {
  return {
    mandateInstanceId: instance.id,
    chain: overrides.chain ?? 'stellar',
    txHash: overrides.txHash ?? randomBytes(32),
    eventIndex: overrides.eventIndex ?? 0n,
    ledger: 100n,
    eventType: 'deposit',
    payload: { items: [1, 2, 3], note: 'kept as written' },
    finalizedAt: FINALIZED_AT,
  };
}

async function newInstance(context: ProjectContext): Promise<MandateInstance> {
  return db.tenant(context).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: 'Payroll' });
    return mandateInstances.create(tx, {
      network: 'stellar:testnet',
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
  });
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  instance = await newInstance(tenant);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('chain events', () => {
  it('re-ingesting the same tx_hash and event_index is a no-op', async () => {
    const input = event();
    const first = await asIndexer(tenant, async (tx) => chainEvents.record(tx, input));
    expect(first.created).toBe(true);
    const again = await asIndexer(tenant, async (tx) => chainEvents.record(tx, input));
    expect(again).toEqual({ created: false, id: first.id });
    // A different index in the same transaction is a different event.
    const next = await asIndexer(tenant, async (tx) =>
      chainEvents.record(tx, { ...input, eventIndex: 1n }),
    );
    expect(next.created).toBe(true);
  });

  it('stores one row however many indexers present the event at once', async () => {
    const input = event();
    const results = await Promise.all(
      Array.from({ length: 12 }, async () =>
        asIndexer(tenant, async (tx) => chainEvents.record(tx, input)),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
  });

  it('reads an event back as it was written, with its big integers exact', async () => {
    const input = { ...event(), ledger: 9007199254740993n, eventIndex: 9007199254740995n };
    const { id } = await asIndexer(tenant, async (tx) => chainEvents.record(tx, input));
    const found = await db.tenant(tenant).transaction(async (tx) => chainEvents.get(tx, id ?? ''));
    expect(found).toEqual({
      id,
      mandateInstanceId: instance.id,
      chain: 'stellar',
      txHash: input.txHash,
      eventIndex: 9007199254740995n,
      ledger: 9007199254740993n,
      eventType: 'deposit',
      payload: input.payload,
      finalizedAt: FINALIZED_AT,
    });
  });

  it('refuses a hash that is not 32 bytes and a chain the instance is not on', async () => {
    const shortHash = event({ txHash: randomBytes(31) });
    expect(await codeOf(asIndexer(tenant, async (tx) => chainEvents.record(tx, shortHash)))).toBe(
      '23514',
    );
    const otherChain = event({ chain: 'celo' });
    expect(await codeOf(asIndexer(tenant, async (tx) => chainEvents.record(tx, otherChain)))).toBe(
      '23503',
    );
  });

  it('pages one instance in chain order', async () => {
    const own = await newInstance(tenant);
    for (const [ledger, eventIndex] of [
      [5n, 1n],
      [5n, 0n],
      [6n, 0n],
    ] as const) {
      await asIndexer(tenant, async (tx) =>
        chainEvents.record(tx, {
          ...event(),
          mandateInstanceId: own.id,
          ledger,
          eventIndex,
        }),
      );
    }
    const session = db.tenant(tenant);
    const first = await session.transaction(async (tx) =>
      chainEvents.list(tx, own.id, { limit: 2 }),
    );
    expect(first.items.map((item) => [item.ledger, item.eventIndex])).toEqual([
      [5n, 0n],
      [5n, 1n],
    ]);
    expect(first.next).toBe('5:1');
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) =>
      chainEvents.list(tx, own.id, { limit: 2, after }),
    );
    expect(rest.items.map((item) => item.ledger)).toEqual([6n]);
    expect(rest.next).toBeNull();
    await expect(
      session.transaction(async (tx) =>
        chainEvents.list(tx, own.id, { limit: 2, after: "1:1'; drop table x" }),
      ),
    ).rejects.toThrow('after is not a key this list returned');
  });

  it('is written by the indexer and only read by the app', async () => {
    const input = event();
    expect(
      await codeOf(db.tenant(tenant).transaction(async (tx) => chainEvents.record(tx, input))),
    ).toBe('42501');
  });
});

describe('resolve_mandate_instance', () => {
  it('finds the tenant of a contract, and nothing for one that is not ours', async () => {
    const found = await db.unscoped(
      async (tx) => entryPoints.resolveMandateInstance(tx, 'stellar', instance.contractAddress),
      'indexer',
    );
    expect(found).toEqual({
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      mandateInstanceId: instance.id,
      asset: 'USDC',
      scale: 7,
    });
    expect(
      await db.unscoped(
        async (tx) => entryPoints.resolveMandateInstance(tx, 'stellar', 'Cnot-ours'),
        'indexer',
      ),
    ).toBeUndefined();
  });

  it('is for the indexer alone', async () => {
    expect(
      await codeOf(
        db.unscoped(async (tx) =>
          entryPoints.resolveMandateInstance(tx, 'stellar', instance.contractAddress),
        ),
      ),
    ).toBe('42501');
  });
});

describe('instance roles', () => {
  it('mirrors a grant, a revocation and a grant again', async () => {
    const own = await newInstance(tenant);
    const input = { ...event(), mandateInstanceId: own.id };
    const { id: grantedId } = await asIndexer(tenant, async (tx) => chainEvents.record(tx, input));
    const { id: revokedId } = await asIndexer(tenant, async (tx) =>
      chainEvents.record(tx, { ...input, eventIndex: 1n }),
    );
    const held = {
      mandateInstanceId: own.id,
      role: 'agent' as const,
      address: 'GAGENT',
    };
    const read = async () =>
      db.tenant(tenant).transaction(async (tx) => instanceRoles.list(tx, own.id, { limit: 10 }));

    await asIndexer(tenant, async (tx) =>
      instanceRoles.grant(tx, { ...held, eventId: grantedId ?? '' }),
    );
    expect((await read()).items).toEqual([
      { role: 'agent', address: 'GAGENT', grantedEventId: grantedId, revokedEventId: null },
    ]);

    expect(
      await asIndexer(tenant, async (tx) =>
        instanceRoles.revoke(tx, { ...held, eventId: revokedId ?? '' }),
      ),
    ).toBe(true);
    expect((await read()).items[0]?.revokedEventId).toBe(revokedId);
    // Already revoked: nothing left to change.
    expect(
      await asIndexer(tenant, async (tx) =>
        instanceRoles.revoke(tx, { ...held, eventId: grantedId ?? '' }),
      ),
    ).toBe(false);

    await asIndexer(tenant, async (tx) =>
      instanceRoles.grant(tx, { ...held, eventId: revokedId ?? '' }),
    );
    expect((await read()).items[0]).toEqual({
      role: 'agent',
      address: 'GAGENT',
      grantedEventId: revokedId,
      revokedEventId: null,
    });
  });

  it('refuses a role the contract does not have, and pages by role and address', async () => {
    const own = await newInstance(tenant);
    const input = { ...event(), mandateInstanceId: own.id };
    const { id } = await asIndexer(tenant, async (tx) => chainEvents.record(tx, input));
    const eventId = id ?? '';
    expect(
      await codeOf(
        asIndexer(tenant, async (tx) =>
          instanceRoles.grant(tx, {
            mandateInstanceId: own.id,
            role: 'admin' as 'agent',
            address: 'G1',
            eventId,
          }),
        ),
      ),
    ).toBe('23514');
    for (const address of ['G1', 'G2', 'G3']) {
      await asIndexer(tenant, async (tx) =>
        instanceRoles.grant(tx, { mandateInstanceId: own.id, role: 'approver', address, eventId }),
      );
    }
    const session = db.tenant(tenant);
    const first = await session.transaction(async (tx) =>
      instanceRoles.list(tx, own.id, { limit: 2 }),
    );
    expect(first.next).toBe('approver:G2');
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) =>
      instanceRoles.list(tx, own.id, { limit: 2, after }),
    );
    expect(rest.items.map((held) => held.address)).toEqual(['G3']);
    await expect(
      session.transaction(async (tx) =>
        instanceRoles.list(tx, own.id, { limit: 2, after: 'no colon here' }),
      ),
    ).rejects.toThrow('after is not a key this list returned');
  });
});

describe('deposits', () => {
  it('records one deposit per event, as the exact amount in the instance unit', async () => {
    const source = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        fundingSources.create(tx, { mandateInstanceId: instance.id, kind: 'stablecoin_deposit' }),
      );
    const input = event();
    const { id: chainEventId } = await asIndexer(tenant, async (tx) =>
      chainEvents.record(tx, input),
    );
    const deposit = {
      mandateInstanceId: instance.id,
      fundingSourceId: source.id,
      chainEventId: chainEventId ?? '',
      amount: tokenAmount(I128_MAX, 'USDC', 'stellar'),
      fromAddress: 'GFROM',
    };
    const first = await asIndexer(tenant, async (tx) => deposits.record(tx, deposit));
    expect(first.created).toBe(true);
    expect(await asIndexer(tenant, async (tx) => deposits.record(tx, deposit))).toEqual({
      created: false,
      id: first.id,
    });
    const found = await db
      .tenant(tenant)
      .transaction(async (tx) => deposits.get(tx, first.id ?? ''));
    expect(found?.amount.amount).toBe(I128_MAX);
    expect(found?.amount.scale).toBe(7);
    expect(found?.fundingSourceId).toBe(source.id);
  });

  it('refuses a zero amount and a deposit naming an event it has no right to', async () => {
    const input = event();
    const { id } = await asIndexer(tenant, async (tx) => chainEvents.record(tx, input));
    const zero = {
      mandateInstanceId: instance.id,
      fundingSourceId: null,
      chainEventId: id ?? '',
      amount: tokenAmount(0n, 'USDC', 'stellar'),
      fromAddress: 'GFROM',
    };
    expect(await codeOf(asIndexer(tenant, async (tx) => deposits.record(tx, zero)))).toBe('23514');
    const noEvent = {
      ...zero,
      chainEventId: randomUUID(),
      amount: tokenAmount(1n, 'USDC', 'stellar'),
    };
    expect(await codeOf(asIndexer(tenant, async (tx) => deposits.record(tx, noEvent)))).toBe(
      '23503',
    );
  });

  it('pages deposits', async () => {
    const page = await db.tenant(tenant).transaction(async (tx) => deposits.list(tx, { limit: 1 }));
    expect(page.items).toHaveLength(1);
    const after = page.items[0]?.id ?? '';
    const none = await db
      .tenant(tenant)
      .transaction(async (tx) => deposits.list(tx, { limit: 100, after }));
    expect(none.items.map((item) => item.id)).not.toContain(after);
  });
});
