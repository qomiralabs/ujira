// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reading payouts as the API lists them: newest first, a page at a time, under
// filters, and one payout with its live attempt.

import { randomBytes, randomUUID } from 'node:crypto';

import { money } from '@ujira/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { mandateTerms } from './repositories/mandate-terms.js';
import { approvals } from './repositories/payout-legs.js';
import {
  PayoutPositionError,
  payoutViews,
  type PayoutListFilter,
  type PayoutPosition,
} from './repositories/payout-views.js';
import { payoutAttempts, payouts } from './repositories/payouts.js';
import { payoutMethods, recipients } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newAttempt,
  newLeg,
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

async function createMany(fixture: PayoutFixture, count: number): Promise<void> {
  // One transaction, so every row has the same creation time and only the id
  // tells them apart.
  await db.tenant(fixture.tenant).transaction(async (tx) => {
    for (let i = 0; i < count; i += 1) await payouts.create(tx, newPayout(fixture));
  });
}

async function readAll(
  fixture: PayoutFixture,
  filter: PayoutListFilter,
  limit: number,
  between?: () => Promise<void>,
): Promise<string[]> {
  const seen: string[] = [];
  let after: PayoutPosition | undefined;
  for (;;) {
    const page = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutViews.page(tx, filter, { limit, ...(after === undefined ? {} : { after }) }),
      );
    seen.push(...page.items.map((listing) => listing.payout.id));
    if (page.next === null) return seen;
    after = page.next;
    if (between !== undefined) await between();
  }
}

async function newestFirst(fixture: PayoutFixture): Promise<string[]> {
  const rows = await admin.query<{ id: string }>(
    `select id from ujira.payouts
      where principal_id = $1 and project_id = $2
      order by created_at desc, id desc`,
    [fixture.tenant.principalId, fixture.tenant.projectId],
  );
  return rows.rows.map((row) => row.id);
}

describe('a page of payouts', () => {
  it('cursor pages never repeat or skip', async () => {
    const fixture = await payoutFixture(db);
    await createMany(fixture, 7);
    await createMany(fixture, 5);
    const expected = await newestFirst(fixture);
    expect(expected).toHaveLength(12);
    for (const limit of [1, 3, 5, 12, 50]) {
      const seen = await readAll(fixture, {}, limit);
      expect(seen, `pages of ${String(limit)}`).toEqual(expected);
    }
  });

  it('a payout created while paging does not shift the pages after it', async () => {
    const fixture = await payoutFixture(db);
    await createMany(fixture, 6);
    const before = await newestFirst(fixture);
    const seen = await readAll(fixture, {}, 2, () => createMany(fixture, 1));
    expect(seen).toEqual(before);
  });

  it('refuses a position that is not one', async () => {
    const fixture = await payoutFixture(db);
    const read = db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutViews.page(
        tx,
        {},
        {
          limit: 10,
          after: { createdAt: '2026-01-01 00:00:00', id: randomUUID() },
        },
      ),
    );
    await expect(read).rejects.toBeInstanceOf(PayoutPositionError);
  });

  it('keeps the microseconds of a position', async () => {
    const fixture = await payoutFixture(db);
    await createMany(fixture, 2);
    const page = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutViews.page(tx, {}, { limit: 1 }));
    expect(page.next?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });
});

describe('the filters', () => {
  let fixture: PayoutFixture;
  let plain: string;
  let kenyan: string;
  let cancelled: string;
  let routed: string;
  let large: string;

  beforeAll(async () => {
    fixture = await payoutFixture(db);
    const session = db.tenant(fixture.tenant);
    plain = (await session.transaction(async (tx) => payouts.create(tx, newPayout(fixture)))).payout
      .id;
    kenyan = await session.transaction(async (tx) => {
      const recipient = await recipients.create(tx, {
        recipientRef: randomBytes(32),
        country: 'KE',
      });
      await payoutMethods.create(tx, {
        recipientId: recipient.id,
        method: 'mobile_money',
        rail: 'anchor',
        chain: 'stellar',
        destinationAddress: `G${randomUUID()}`,
        destinationTag: null,
        details: null,
      });
      const { payout } = await payouts.create(
        tx,
        newPayout(fixture, { recipientId: recipient.id, method: 'mobile_money' }),
      );
      return payout.id;
    });
    cancelled = await session.transaction(async (tx) => {
      const { payout } = await payouts.create(tx, newPayout(fixture));
      await payouts.transition(tx, payout.id, { from: 'received', to: 'cancelled' });
      return payout.id;
    });
    routed = await session.transaction(async (tx) => {
      const { payout } = await payouts.create(tx, newPayout(fixture));
      await payoutAttempts.create(tx, newAttempt(fixture, payout.id));
      return payout.id;
    });
    large = (
      await session.transaction(async (tx) =>
        payouts.create(tx, newPayout(fixture, { requested: usdc(900n * ONE_USDC) })),
      )
    ).payout.id;
  });

  const ids = async (filter: PayoutListFilter): Promise<string[]> =>
    (await readAll(fixture, filter, 50)).sort();

  it('by public status', async () => {
    expect(await ids({ statuses: ['cancelled'] })).toEqual([cancelled]);
    expect(await ids({ statuses: ['queued'] })).toEqual([plain, kenyan, routed, large].sort());
  });

  it('by corridor, method and mandate', async () => {
    expect(await ids({ corridors: ['KE'] })).toEqual([kenyan]);
    expect(await ids({ methods: ['mobile_money'] })).toEqual([kenyan]);
    expect(await ids({ mandateIds: [randomUUID()] })).toEqual([]);
    expect(await ids({ mandateIds: [fixture.mandateId] })).toHaveLength(5);
  });

  it('by the network of the live attempt', async () => {
    expect(await ids({ networks: ['stellar:testnet'] })).toEqual([routed]);
    expect(await ids({ networks: ['stellar:pubnet'] })).toEqual([]);
  });

  it('by the requested amount in its own unit', async () => {
    const token = { kind: 'token', asset: 'USDC', chain: 'stellar' } as const;
    expect(await ids({ amounts: [{ ...token, min: 100n * ONE_USDC }] })).toEqual([large]);
    expect(await ids({ amounts: [{ ...token, max: 5n * ONE_USDC }] })).toHaveLength(4);
    expect(await ids({ amounts: [{ ...token, chain: 'other', min: 1n }] })).toEqual([]);
    expect(await ids({ amounts: [{ kind: 'fiat', currency: 'USD', min: 1n }] })).toEqual([]);
  });

  it('by creation time', async () => {
    expect(await ids({ createdTo: new Date('2000-01-01T00:00:00Z') })).toEqual([]);
    expect(await ids({ createdFrom: new Date('2000-01-01T00:00:00Z') })).toHaveLength(5);
  });

  it('every one given at once', async () => {
    expect(await ids({ statuses: ['queued'], corridors: ['KE'], methods: ['bank'] })).toEqual([]);
  });

  it('says what the live attempt carries', async () => {
    const page = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutViews.page(tx, { networks: ['stellar:testnet'] }, { limit: 5 }),
      );
    expect(page.items[0]).toMatchObject({
      recipientCountry: 'NG',
      mandateName: 'Payroll',
      attempt: { network: 'stellar:testnet', legCount: 1, firstMethod: 'stellar_wallet' },
    });
  });
});

describe('one payout', () => {
  it('comes with its legs, its approvals and the rate the mandate agreed', async () => {
    const fixture = await payoutFixture(db);
    const id = await db.tenant(fixture.tenant).transaction(async (tx) => {
      await mandateTerms.create(tx, {
        mandateId: fixture.mandateId,
        creationKey: randomUUID(),
        recipientMode: 'allowlist',
        limits: {
          totalBudget: money('1000000', 'USD'),
          perPaymentCap: money('100000', 'USD'),
          perRecipientDailyCap: money('200000', 'USD'),
          approvalThreshold: money('50000', 'USD'),
        },
        countryPolicyHash: Buffer.alloc(32, 7),
        maxFeeBps: 100,
        agreedFeeBps: 40,
        payoutTtlSeconds: 86_400,
        expiresAt: new Date('2100-01-01T00:00:00Z'),
      });
      const { payout } = await payouts.create(tx, newPayout(fixture));
      const attempt = await payoutAttempts.create(
        tx,
        newAttempt(fixture, payout.id, {
          total: usdc(5n * ONE_USDC),
          legs: [
            { ...newLeg(fixture, 3n * ONE_USDC, 0), fee: 12_000n },
            { ...newLeg(fixture, 2n * ONE_USDC, 1), fee: 8_000n },
          ],
        }),
      );
      for (const decision of ['approved', 'approved', 'rejected'] as const) {
        await approvals.record(tx, {
          attemptId: attempt.id,
          approver: `G${randomUUID()}`,
          decision,
          signedMessageHash: randomBytes(32),
          signature: randomBytes(64),
        });
      }
      return payout.id;
    });
    const view = await db.tenant(fixture.tenant).transaction(async (tx) => payoutViews.get(tx, id));
    expect(view).toMatchObject({
      agreedFeeBps: 40,
      approvalsGiven: 2,
      attempt: { legCount: 2, firstMethod: 'stellar_wallet' },
    });
    expect(view?.legs.map((leg) => [leg.index, leg.amount.amount, leg.fee.amount])).toEqual([
      [0, 3n * ONE_USDC, 12_000n],
      [1, 2n * ONE_USDC, 8_000n],
    ]);
  });

  it('has no rate when its mandate has no terms, and no legs before routing', async () => {
    const fixture = await payoutFixture(db);
    const { payout } = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    const view = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutViews.get(tx, payout.id));
    expect(view).toMatchObject({ agreedFeeBps: null, approvalsGiven: 0, attempt: null, legs: [] });
  });

  it('is not found under another id', async () => {
    const fixture = await payoutFixture(db);
    expect(
      await db.tenant(fixture.tenant).transaction(async (tx) => payoutViews.get(tx, randomUUID())),
    ).toBeUndefined();
  });
});
