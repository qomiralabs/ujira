// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a mandate agreed, and the requests handed out for it. The unique keys here
// are what stops a handler running twice from doing its work twice.

import { randomUUID } from 'node:crypto';

import { money } from '@ujira/core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import {
  mandateActionRequests,
  mandateTerms,
  type NewMandateTerms,
} from './repositories/mandate-terms.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let alpha: CreatedPrincipal;

const LIMITS = {
  totalBudget: money('1000000', 'USD'),
  perPaymentCap: money('100000', 'USD'),
  perRecipientDailyCap: money('200000', 'USD'),
  approvalThreshold: money('50000', 'USD'),
};

function terms(mandateId: string, overrides: Partial<NewMandateTerms> = {}): NewMandateTerms {
  return {
    mandateId,
    creationKey: randomUUID(),
    recipientMode: 'allowlist',
    limits: LIMITS,
    countryPolicy: { mode: 'allow', countries: ['KE'] },
    countryPolicyHash: Buffer.alloc(32, 7),
    maxFeeBps: 100,
    agreedFeeBps: 50,
    payoutTtlSeconds: 86_400,
    expiresAt: new Date('2100-01-01T00:00:00Z'),
    ...overrides,
  };
}

async function newMandate(): Promise<string> {
  return (await db.tenant(alpha).transaction(async (tx) => mandates.create(tx, { name: 'M' }))).id;
}

async function newInstance(mandateId: string): Promise<string> {
  const instance = await db.tenant(alpha).transaction(async (tx) =>
    mandateInstances.create(tx, {
      mandateId,
      chain: 'stellar',
      contractAddress: `C${randomUUID()}`,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    }),
  );
  return instance.id;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  alpha = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name: 'A', projectName: 'A', ownerUserId: randomUUID() }),
  );
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('mandate terms', () => {
  it('reads back what was agreed, in exact money', async () => {
    const id = await newMandate();
    const input = terms(id);
    expect(await db.tenant(alpha).transaction(async (tx) => mandateTerms.create(tx, input))).toBe(
      true,
    );
    const read = await db.tenant(alpha).transaction(async (tx) => mandateTerms.get(tx, id));
    expect(read).toMatchObject({
      mandateId: id,
      creationKey: input.creationKey,
      recipientMode: 'allowlist',
      countryPolicy: input.countryPolicy,
      countryPolicyHash: input.countryPolicyHash,
      maxFeeBps: 100,
      agreedFeeBps: 50,
      payoutTtlSeconds: 86_400,
    });
    expect(read?.limits.totalBudget).toEqual(LIMITS.totalBudget);
    expect(read?.limits.approvalThreshold).toEqual(LIMITS.approvalThreshold);
    expect(
      await db
        .tenant(alpha)
        .transaction(async (tx) => mandateTerms.getByCreationKey(tx, input.creationKey)),
    ).toEqual(read);
  });

  it('gives a creation key to one mandate only', async () => {
    const key = randomUUID();
    const create = async (id: string): Promise<boolean> =>
      db
        .tenant(alpha)
        .transaction(async (tx) => mandateTerms.create(tx, terms(id, { creationKey: key })));
    expect(await create(await newMandate())).toBe(true);
    expect(await create(await newMandate())).toBe(false);
  });

  it.each([
    ['a fee cap above 100', { maxFeeBps: 101 }],
    ['an agreed rate above 100', { agreedFeeBps: 101 }],
    ['a payout life under an hour', { payoutTtlSeconds: 60 }],
    ['a key with an email in it', { creationKey: 'someone@example.com' }],
  ])('refuses %s', async (_name, overrides) => {
    const id = await newMandate();
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) => mandateTerms.create(tx, terms(id, overrides))),
      ),
    ).toBe('23514');
  });
});

describe('mandate action requests', () => {
  const request = (mandateId: string, instanceId: string, key: string, requestId: string) => ({
    mandateId,
    mandateInstanceId: instanceId,
    op: 'withdraw' as const,
    idempotencyKey: key,
    signingRequest: { requestId },
    instancePlan: null,
  });

  it('gives every run of one request the first thing it prepared', async () => {
    const mandateId = await newMandate();
    const instanceId = await newInstance(mandateId);
    const key = randomUUID();
    const record = async (requestId: string) =>
      db
        .tenant(alpha)
        .transaction(async (tx) =>
          mandateActionRequests.record(tx, request(mandateId, instanceId, key, requestId)),
        );
    expect((await record('first')).signingRequest).toEqual({ requestId: 'first' });
    expect((await record('second')).signingRequest).toEqual({ requestId: 'first' });
    expect(
      (
        await db
          .tenant(alpha)
          .transaction(async (tx) => mandateActionRequests.find(tx, key, instanceId))
      )?.signingRequest,
    ).toEqual({ requestId: 'first' });
  });

  it('keeps a key apart per instance', async () => {
    const mandateId = await newMandate();
    const one = await newInstance(mandateId);
    const key = randomUUID();
    await db
      .tenant(alpha)
      .transaction(async (tx) =>
        mandateActionRequests.record(tx, request(mandateId, one, key, 'one')),
      );
    expect(
      await db
        .tenant(alpha)
        .transaction(async (tx) => mandateActionRequests.find(tx, key, randomUUID())),
    ).toBeUndefined();
  });

  it('holds a plan on a create and only there, and lists creates by mandate', async () => {
    const mandateId = await newMandate();
    const instanceId = await newInstance(mandateId);
    const record = async (op: 'create' | 'revoke', instancePlan: unknown) =>
      db.tenant(alpha).transaction(async (tx) =>
        mandateActionRequests.record(tx, {
          mandateId,
          mandateInstanceId: instanceId,
          op,
          idempotencyKey: randomUUID(),
          signingRequest: {},
          instancePlan,
        }),
      );
    expect(await codeOf(record('create', null))).toBe('23514');
    expect(await codeOf(record('revoke', { network: 'x' }))).toBe('23514');
    await record('create', { network: 'x' });
    await record('revoke', null);
    const creates = await db
      .tenant(alpha)
      .transaction(async (tx) => mandateActionRequests.createsOf(tx, mandateId));
    expect(creates.map((row) => row.op)).toEqual(['create']);
    expect(creates[0]?.instancePlan).toEqual({ network: 'x' });
  });

  it('refuses an op outside the list', async () => {
    const mandateId = await newMandate();
    const instanceId = await newInstance(mandateId);
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) =>
          mandateActionRequests.record(tx, {
            ...request(mandateId, instanceId, randomUUID(), 'x'),
            op: 'sweep' as 'withdraw',
          }),
        ),
      ),
    ).toBe('23514');
  });
});
