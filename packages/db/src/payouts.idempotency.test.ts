// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  IdempotencyConflictError,
  payoutBatches,
  payoutMinimums,
  payouts,
} from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newPayout,
  ONE_USDC,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 12);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('payout idempotency', () => {
  it('50 parallel creates give 1 payout and 49 existing', async () => {
    const request = newPayout(fixture);
    const results = await Promise.all(
      Array.from({ length: 50 }, async () =>
        db.tenant(fixture.tenant).transaction(async (tx) => payouts.create(tx, request)),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(49);
    expect(new Set(results.map((result) => result.payout.id)).size).toBe(1);
    const page = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.list(tx, { limit: 100 }));
    expect(page.items).toHaveLength(1);
  });

  it('same key different body raises conflict', async () => {
    const request = newPayout(fixture);
    const session = db.tenant(fixture.tenant);
    await session.transaction(async (tx) => payouts.create(tx, request));
    for (const changed of [
      { ...request, requested: usdc(6n * ONE_USDC) },
      { ...request, recipientId: randomUUID() },
      { ...request, method: 'bank' as const, requested: usdc(50n * ONE_USDC) },
    ]) {
      await expect(
        session.transaction(async (tx) => payouts.create(tx, changed)),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    }
  });

  it('raises the same conflict when the different body loses a race', async () => {
    const request = newPayout(fixture);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, async (_, index) =>
        db.tenant(fixture.tenant).transaction(async (tx) =>
          payouts.create(tx, {
            ...request,
            requested: usdc((5n + BigInt(index)) * ONE_USDC),
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(IdempotencyConflictError);
      }
    }
  });

  it('a retry finds its payout even after the project minimum rose above it', async () => {
    const request = newPayout(fixture);
    const session = db.tenant(fixture.tenant);
    const first = await session.transaction(async (tx) => payouts.create(tx, request));
    await session.transaction(async (tx) =>
      payoutMinimums.set(tx, {
        method: 'stellar_wallet',
        minimum: { amount: 10_000n, currency: 'USD', scale: 2 },
        memberId: fixture.memberId,
      }),
    );
    const retry = await session.transaction(async (tx) => payouts.create(tx, request));
    expect(retry).toEqual({ payout: first.payout, created: false });
  });

  it('a key is the tenant own: another project uses it freely', async () => {
    const other = await payoutFixture(db);
    const key = randomUUID();
    const mine = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture, { idempotencyKey: key })));
    const theirs = await db
      .tenant(other.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(other, { idempotencyKey: key })));
    expect(mine.created).toBe(true);
    expect(theirs.created).toBe(true);
    expect(theirs.payout.id).not.toBe(mine.payout.id);
  });
});

describe('batch idempotency', () => {
  it('a retried batch finds its batch and every item', async () => {
    const input = {
      idempotencyKey: randomUUID(),
      items: [newPayout(fixture), newPayout(fixture)],
    };
    const session = db.tenant(fixture.tenant);
    const first = await session.transaction(async (tx) => payoutBatches.create(tx, input));
    expect(first.created).toBe(true);
    expect(first.items.map((item) => item.outcome)).toEqual(['created', 'created']);
    const retry = await session.transaction(async (tx) => payoutBatches.create(tx, input));
    expect(retry.created).toBe(false);
    expect(retry.batch.id).toBe(first.batch.id);
    expect(retry.items.map((item) => item.outcome)).toEqual(['existing', 'existing']);
  });

  it('the same batch key with different items raises conflict', async () => {
    const idempotencyKey = randomUUID();
    const session = db.tenant(fixture.tenant);
    await session.transaction(async (tx) =>
      payoutBatches.create(tx, { idempotencyKey, items: [newPayout(fixture)] }),
    );
    await expect(
      session.transaction(async (tx) =>
        payoutBatches.create(tx, { idempotencyKey, items: [newPayout(fixture)] }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('refuses one item that reuses a key for something else, and creates the rest', async () => {
    const taken = newPayout(fixture);
    const session = db.tenant(fixture.tenant);
    await session.transaction(async (tx) => payouts.create(tx, taken));
    const result = await session.transaction(async (tx) =>
      payoutBatches.create(tx, {
        idempotencyKey: randomUUID(),
        items: [taken, newPayout(fixture)],
      }),
    );
    const [refused, created] = result.items;
    expect(refused?.outcome).toBe('refused');
    if (refused?.outcome === 'refused') {
      expect(refused.error).toBeInstanceOf(IdempotencyConflictError);
    }
    expect(created?.outcome).toBe('created');
  });
});
