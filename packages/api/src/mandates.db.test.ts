// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate endpoints on the real tables, as the role the API runs as: the unique
// constraints that stop a second run, and row level security on every read.

import { randomUUID } from 'node:crypto';

import { MandateCreated, MandateDetail } from '@ujira/api-schema';
import type { SigningRequestWire } from '@ujira/api-schema';
import { money } from '@ujira/core';
import { entryPoints, mandates } from '@ujira/db';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { databaseMandateRecords } from './postgres-stores.js';
import { PreparedShape, mandateWorld } from './mandates.test-support.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;

async function newTenant(name: string) {
  return db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: 'Main', ownerUserId: randomUUID() }),
  );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('against the tables', () => {
  it('keeps the shape of a mandate through a round trip of its row', async () => {
    const records = databaseMandateRecords(db);
    const tenant = await newTenant('Owner');
    const world = mandateWorld();
    const key = randomUUID();
    const signingRequest: SigningRequestWire = {
      kind: 'stellar_transaction',
      network: 'stellar:testnet',
      xdr: 'AAAA',
      signer: world.principal().value,
      validUntil: new Date(0).toISOString(),
      sponsored: true,
      summary: { action: 'create', feePaidBy: 'ujira' },
      requestId: 'request-1',
    };
    const instance = {
      address: `C${randomUUID()}`,
      plan: {
        network: 'stellar:testnet' as const,
        asset: 'USDC',
        roles: [{ role: 'agent' as const, address: 'GAGENT' }],
        principal: world.principal().value,
        approvalsRequired: 0,
        operationsGuardian: 'present' as const,
        warnings: ['single_key_principal' as const],
      },
      signingRequest,
    };
    const input = {
      id: randomUUID(),
      creationKey: key,
      name: 'Round trip',
      recipientMode: 'allowlist' as const,
      limits: {
        totalBudget: money('1000000', 'USD'),
        perPaymentCap: money('100000', 'USD'),
        perRecipientDailyCap: money('200000', 'USD'),
        approvalThreshold: money('50000', 'USD'),
      },
      countryPolicy: { mode: 'allow' as const, countries: ['KE'] },
      countryPolicyHash: Buffer.alloc(32, 9),
      maxFeeBps: 100,
      agreedFeeBps: 50,
      payoutTtlSeconds: 86_400,
      expiresAt: new Date('2100-01-01T00:00:00Z'),
      instances: [instance],
    };
    const stored = await records.createOnce(tenant, input);
    expect(stored).toMatchObject({
      id: input.id,
      name: 'Round trip',
      recipientMode: 'allowlist',
      maxFeeBps: 100,
      agreedFeeBps: 50,
      payoutTtlSeconds: 86_400,
      countryPolicy: input.countryPolicy,
    });
    expect(stored.limits.totalBudget.amount).toBe(1_000_000n);
    expect(stored.instances[0]).toMatchObject({
      address: input.instances[0]?.address,
      plan: input.instances[0]?.plan,
      signingRequest,
    });
    expect(await records.find(tenant, input.id)).toEqual(stored);
    expect(await records.findByCreationKey(tenant, key)).toEqual(stored);

    // The attester checks a recipient against this row, so a mandate that left it
    // at its default would allow nobody while reading as though it allowed Kenya.
    const row = await db.tenant(tenant).transaction((tx) => mandates.get(tx, input.id));
    expect(row?.countryPolicy).toEqual({ mode: 'allow', countries: ['KE'] });

    const blocking = await records.createOnce(tenant, {
      ...input,
      id: randomUUID(),
      creationKey: randomUUID(),
      countryPolicy: { mode: 'block', countries: ['KE'] },
      instances: [],
    });
    expect(blocking.countryPolicy).toEqual({ mode: 'block', countries: ['KE'] });
    const blockingRow = await db.tenant(tenant).transaction((tx) => mandates.get(tx, blocking.id));
    expect(blockingRow?.countryPolicy).toEqual({ mode: 'deny', countries: ['KE'] });

    // The same key again: the first stands, and no second mandate is written.
    const second = await records.createOnce(tenant, {
      ...input,
      id: randomUUID(),
      name: 'Should lose',
      instances: [{ ...instance, address: 'Cother' }],
    });
    expect(second.id).toBe(input.id);
    expect(second.name).toBe('Round trip');

    // A second tenant sees none of it.
    const other = await newTenant('Other');
    expect(await records.find(other, input.id)).toBeUndefined();
    expect(await records.findByCreationKey(other, key)).toBeUndefined();

    // Actions: the first request a key records is the one every later run gets.
    const instanceId = stored.instances[0]?.id ?? '';
    const action = {
      mandateId: stored.id,
      instanceId,
      op: 'withdraw' as const,
      key: randomUUID(),
      signingRequest: { ...signingRequest, requestId: 'first' },
    };
    expect(await records.findAction(tenant, action.key, instanceId)).toBeUndefined();
    expect((await records.recordAction(tenant, action)).requestId).toBe('first');
    expect(
      (
        await records.recordAction(tenant, {
          ...action,
          signingRequest: { ...signingRequest, requestId: 'second' },
        })
      ).requestId,
    ).toBe('first');
    expect((await records.findAction(tenant, action.key, instanceId))?.requestId).toBe('first');
    expect(await records.findAction(other, action.key, instanceId)).toBeUndefined();
  });
});

describe('the endpoints on the tables', () => {
  function worldOnTables(tenant: { principalId: string; projectId: string }) {
    // The fake adapter checks its own two scopes, so the records see the real tenant.
    const inner = databaseMandateRecords(db);
    return mandateWorld({
      records: {
        find: (_t, id) => inner.find(tenant, id),
        findByCreationKey: (_t, key) => inner.findByCreationKey(tenant, key),
        createOnce: (_t, mandate) => inner.createOnce(tenant, mandate),
        findAction: (_t, key, instanceId) => inner.findAction(tenant, key, instanceId),
        recordAction: (_t, action) => inner.recordAction(tenant, action),
      },
    });
  }

  it('creates, reads, revokes and withdraws through real rows', async () => {
    const tenant = await newTenant('Endpoints');
    const world = worldOnTables(tenant);
    const created = MandateCreated.parse(
      await (await world.request('POST', '/v1/mandates', world.createBody())).json(),
    );
    const [instance] = created.instances;
    if (instance === undefined) throw new Error('no instance');
    await world.signAndSubmit(instance.signingRequest);
    await world.h.fund({ network: instance.network, value: instance.address }, 5_000_000n);

    const detail = MandateDetail.parse(
      await (await world.request('GET', `/v1/mandates/${created.id}`)).json(),
    );
    expect(detail).toMatchObject({ status: 'active', countryPolicyHashMatches: true });

    const revoke = PreparedShape.parse(
      await (await world.request('POST', `/v1/mandates/${created.id}/revoke`)).json(),
    );
    await world.signAndSubmit(revoke.instances[0]?.signingRequest as SigningRequestWire);
    const withdraw = await world.request('POST', `/v1/mandates/${created.id}/withdraw`);
    expect(withdraw.status).toBe(200);
  });
});
