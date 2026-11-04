// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The recipient methods the endpoints added. The unique key on a reference is what
// lets a second run of one request find the first run's recipient.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { payoutMethods, recipients } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let alpha: CreatedPrincipal;

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

async function newRecipient(): Promise<string> {
  const id = randomUUID();
  await db
    .tenant(alpha)
    .transaction(async (tx) =>
      recipients.createOnce(tx, { id, recipientRef: randomBytes(32), country: 'KE' }),
    );
  return id;
}

describe('recipients.createOnce', () => {
  it('takes the id it is given, and a reference once', async () => {
    const recipientRef = randomBytes(32);
    const id = randomUUID();
    const create = async (candidate: string): Promise<boolean> =>
      db
        .tenant(alpha)
        .transaction(async (tx) =>
          recipients.createOnce(tx, { id: candidate, recipientRef, country: 'KE' }),
        );
    expect(await create(id)).toBe(true);
    expect(await create(randomUUID())).toBe(false);
    const found = await db
      .tenant(alpha)
      .transaction(async (tx) => recipients.getByRef(tx, recipientRef));
    expect(found?.id).toBe(id);
  });

  it('finds nothing for a reference never used', async () => {
    expect(
      await db.tenant(alpha).transaction(async (tx) => recipients.getByRef(tx, randomBytes(32))),
    ).toBeUndefined();
  });
});

describe('payoutMethods.listOf', () => {
  it('lists one recipient only', async () => {
    const mine = await newRecipient();
    const other = await newRecipient();
    const add = async (recipientId: string, address: string): Promise<void> => {
      await db.tenant(alpha).transaction(async (tx) =>
        payoutMethods.create(tx, {
          recipientId,
          method: 'stellar_wallet',
          rail: 'wallet',
          chain: 'stellar',
          destinationAddress: address,
          destinationTag: null,
          details: null,
        }),
      );
    };
    await add(mine, 'GMINE');
    await add(other, 'GOTHER');
    const listed = await db.tenant(alpha).transaction(async (tx) => payoutMethods.listOf(tx, mine));
    expect(listed.map((method) => method.destinationAddress)).toEqual(['GMINE']);
  });
});
