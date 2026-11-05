// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A destination is an address and an optional tag. Plain uniqueness treats a missing
// tag as different from every other missing tag, which would let two untagged methods
// share one address.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { projects } from './repositories/tenancy.js';
import { payoutMethods, recipients } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TOP_TAG = 2n ** 64n - 1n;

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;
let recipientId: string;
let address: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function principal(): Promise<CreatedPrincipal> {
  return db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
}

async function recipientIn(context: { principalId: string; projectId: string }): Promise<string> {
  const recipient = await db
    .tenant(context)
    .transaction(async (tx) =>
      recipients.create(tx, { recipientRef: randomBytes(32), country: 'NG' }),
    );
  return recipient.id;
}

async function method(
  destinationTag: bigint | null,
  context: { principalId: string; projectId: string } = tenant,
  recipient = recipientId,
) {
  return db.tenant(context).transaction(async (tx) =>
    payoutMethods.create(tx, {
      recipientId: recipient,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress: address,
      destinationTag,
      details: null,
    }),
  );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  tenant = await principal();
  recipientId = await recipientIn(tenant);
  address = `G${randomUUID()}`;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the identity of a destination', () => {
  it('a second active untagged method on one address is refused', async () => {
    await method(null);
    expect(await codeOf(method(null))).toBe('23505');
  });

  it('a second active method with the same tag is refused', async () => {
    await method(5n);
    expect(await codeOf(method(5n))).toBe('23505');
    await method(TOP_TAG);
    expect(await codeOf(method(TOP_TAG))).toBe('23505');
  });

  it('one address with different tags, or with and without one, is several destinations', async () => {
    await method(null);
    await method(5n);
    await method(6n);
    await method(TOP_TAG);
  });

  it('holds across recipients and projects of one principal', async () => {
    await method(null);
    const secondRecipient = await recipientIn(tenant);
    expect(await codeOf(method(null, tenant, secondRecipient))).toBe('23505');
    const projectId = await db
      .tenant(tenant)
      .transaction(async (tx) => projects.create(tx, { name: 'Second' }));
    const other = { principalId: tenant.principalId, projectId };
    const inOtherProject = await recipientIn(other);
    expect(await codeOf(method(null, other, inOtherProject))).toBe('23505');
  });

  it('does not reach another principal', async () => {
    await method(null);
    const other = await principal();
    const theirs = await recipientIn(other);
    expect((await method(null, other, theirs)).destinationAddress).toBe(address);
  });

  it('a disabled method frees its destination', async () => {
    const first = await method(null);
    await db.tenant(tenant).transaction(async (tx) => payoutMethods.disable(tx, first.id));
    expect((await method(null)).id).not.toBe(first.id);
  });

  it('of parallel creates on one destination, one wins', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, async () => method(null)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
});
