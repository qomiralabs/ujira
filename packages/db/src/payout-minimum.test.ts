// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import { moneyAt } from '@ujira/core';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  AmountBelowMinimumError,
  checkMinimum,
  MinimumNotComparableError,
  requiredMinimum,
  type MinimumAmount,
  type MinimumReason,
  type PayoutMinimumContext,
  type PayoutMinimumMethod,
} from './payout-minimum.js';
import { payoutBatches, payoutMinimums, payouts } from './repositories/payouts.js';
import { projects } from './repositories/tenancy.js';
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

function usd(cents: bigint): MinimumAmount {
  return { amount: cents, currency: 'USD', scale: 2 };
}

function usdcAt7(raw: bigint): MinimumAmount {
  return { amount: raw, currency: 'USDC', scale: 7 };
}

interface Row {
  readonly name: string;
  readonly method: PayoutMinimumMethod;
  readonly project?: readonly MinimumAmount[];
  readonly context?: PayoutMinimumContext;
  readonly minimum: MinimumAmount;
  readonly reason: MinimumReason;
  // Just under the minimum, and exactly at it.
  readonly below: MinimumAmount;
  readonly at: MinimumAmount;
}

const TABLE: readonly Row[] = [
  {
    name: 'the wallet floor, 1.00 USDC',
    method: 'stellar_wallet',
    minimum: { amount: 100n, currency: 'USDC', scale: 2 },
    reason: 'ujira_floor',
    below: usdcAt7(ONE_USDC - 1n),
    at: usdcAt7(ONE_USDC),
  },
  {
    name: 'the mobile money floor, the USD equivalent of 2.00',
    method: 'mobile_money',
    minimum: usd(200n),
    reason: 'ujira_floor',
    below: usdcAt7(2n * ONE_USDC - 1n),
    at: usdcAt7(2n * ONE_USDC),
  },
  {
    name: 'the bank floor, the USD equivalent of 5.00',
    method: 'bank',
    minimum: usd(500n),
    reason: 'ujira_floor',
    below: usd(499n),
    at: usd(500n),
  },
  {
    name: 'the cash pickup floor, the USD equivalent of 10.00',
    method: 'cash_pickup',
    minimum: usd(1000n),
    reason: 'ujira_floor',
    below: usd(999n),
    at: usd(1000n),
  },
  {
    name: 'the anchor minimum, when above the floor',
    method: 'bank',
    context: { anchorMinimum: usd(800n) },
    minimum: usd(800n),
    reason: 'anchor_min',
    below: usd(799n),
    at: usd(800n),
  },
  {
    name: 'the project minimum, when above the floor and the anchor',
    method: 'bank',
    project: [usd(1200n)],
    context: { anchorMinimum: usd(800n) },
    minimum: usd(1200n),
    reason: 'project_min',
    below: usd(1199n),
    at: usd(1200n),
  },
  {
    name: 'the network budget, when above everything else',
    method: 'stellar_wallet',
    project: [usd(300n)],
    context: { breakEvenMinimum: usd(450n) },
    minimum: usd(450n),
    reason: 'network_budget',
    below: usdcAt7(45_000_000n - 1n),
    at: usdcAt7(45_000_000n),
  },
];

describe('the payout minimum', () => {
  it.each(TABLE)('$name', (row) => {
    const project = row.project ?? [];
    const context = row.context ?? {};
    expect(requiredMinimum(row.method, project, context)).toEqual({
      minimum: row.minimum,
      reason: row.reason,
    });
    expect(() => {
      checkMinimum(row.method, row.at, project, context);
    }).not.toThrow();
    let refusal: unknown;
    try {
      checkMinimum(row.method, row.below, project, context);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AmountBelowMinimumError);
    expect(refusal).toMatchObject({
      code: 'AMOUNT_BELOW_MINIMUM',
      method: row.method,
      minimum: row.minimum,
      reason: row.reason,
    });
  });

  it('a project minimum can only raise', () => {
    expect(requiredMinimum('bank', [usd(1n)], {}).reason).toBe('ujira_floor');
    expect(requiredMinimum('bank', [usd(500n)], {}).reason).toBe('ujira_floor');
    expect(requiredMinimum('bank', [usd(501n)], {}).reason).toBe('project_min');
  });

  it('a tie names the more basic reason', () => {
    const required = requiredMinimum('bank', [usd(800n)], { anchorMinimum: usd(800n) });
    expect(required.reason).toBe('anchor_min');
  });

  it('compares across scales exactly, with no rounding', () => {
    expect(() => {
      checkMinimum('stellar_wallet', usdcAt7(9_999_999n), [], {});
    }).toThrow(AmountBelowMinimumError);
    expect(() => {
      checkMinimum(
        'stellar_wallet',
        { amount: 100_000_000_000n, currency: 'USDC', scale: 11 },
        [],
        {},
      );
    }).not.toThrow();
  });

  it('converts a local amount through the rate the caller brings', () => {
    const ngn = (amount: bigint): MinimumAmount => ({ amount, currency: 'NGN', scale: 2 });
    const toUsd = (value: MinimumAmount): MinimumAmount => usd(value.amount / 1500n);
    expect(() => {
      checkMinimum('bank', ngn(1500n * 499n), [], { toUsd });
    }).toThrow(AmountBelowMinimumError);
    expect(() => {
      checkMinimum('bank', ngn(1500n * 500n), [], { toUsd });
    }).not.toThrow();
    expect(requiredMinimum('bank', [ngn(1500n * 600n)], { toUsd }).reason).toBe('project_min');
  });

  it('with no rate a local amount is refused rather than let through', () => {
    const ngn: MinimumAmount = { amount: 10n ** 12n, currency: 'NGN', scale: 2 };
    expect(() => {
      checkMinimum('bank', ngn, [], {});
    }).toThrow(MinimumNotComparableError);
    expect(() => {
      checkMinimum('bank', usd(1000n), [ngn], {});
    }).toThrow(MinimumNotComparableError);
    expect(() => {
      checkMinimum('bank', ngn, [], { toUsd: () => undefined });
    }).toThrow(MinimumNotComparableError);
    expect(() => {
      checkMinimum('bank', ngn, [], { toUsd: (value) => value });
    }).toThrow(MinimumNotComparableError);
  });
});

describe('at creation', () => {
  let database: TestDatabase;
  let db: Database;
  let fixture: PayoutFixture;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl, import.meta.url);
    db = databaseAsServiceRoles(roleUrls, database, 4);
  });

  beforeEach(async () => {
    fixture = await payoutFixture(db);
  });

  afterAll(async () => {
    await db.close();
    await database.drop();
  });

  it.each([
    ['the wallet floor', { method: 'stellar_wallet' as const }, 'ujira_floor'],
    [
      'the anchor minimum',
      { method: 'bank' as const, minimum: { anchorMinimum: usd(10_000n) } },
      'anchor_min',
    ],
    [
      'the network budget',
      { method: 'stellar_wallet' as const, minimum: { breakEvenMinimum: usd(10_000n) } },
      'network_budget',
    ],
  ])('refuses below %s', async (_name, overrides, reason) => {
    await expect(
      db
        .tenant(fixture.tenant)
        .transaction(async (tx) =>
          payouts.create(tx, newPayout(fixture, { requested: usdc(1n), ...overrides })),
        ),
    ).rejects.toMatchObject({ code: 'AMOUNT_BELOW_MINIMUM', reason });
  });

  it('checks a local ask in principal mode against the floor', async () => {
    const session = db.tenant(fixture.tenant);
    await session.transaction(async (tx) =>
      projects.setCashoutBearer(tx, 'principal', { kind: 'member', id: fixture.memberId }),
    );
    await expect(
      session.transaction(async (tx) =>
        payouts.create(
          tx,
          newPayout(fixture, {
            method: 'bank',
            requested: moneyAt(100_000n, 'NGN', 2),
            minimum: { toUsd: () => usd(66n) },
          }),
        ),
      ),
    ).rejects.toMatchObject({ reason: 'ujira_floor' });
  });

  it('a refused batch item leaves the other items created', async () => {
    const session = db.tenant(fixture.tenant);
    await session.transaction(async (tx) =>
      payoutMinimums.set(tx, {
        method: 'stellar_wallet',
        minimum: usd(300n),
        memberId: fixture.memberId,
      }),
    );
    const good = newPayout(fixture, { requested: usdc(3n * ONE_USDC) });
    const belowFloor = newPayout(fixture, { requested: usdc(1n) });
    const alsoGood = newPayout(fixture, { requested: usdc(4n * ONE_USDC) });
    const result = await session.transaction(async (tx) =>
      payoutBatches.create(tx, {
        idempotencyKey: randomUUID(),
        items: [good, belowFloor, alsoGood],
      }),
    );
    expect(result.items.map((item) => item.outcome)).toEqual(['created', 'refused', 'created']);
    const refused = result.items[1];
    expect(refused?.key).toBe(belowFloor.idempotencyKey);
    if (refused?.outcome === 'refused') {
      expect(refused.error).toMatchObject({
        code: 'AMOUNT_BELOW_MINIMUM',
        method: 'stellar_wallet',
        reason: 'project_min',
        minimum: usd(300n),
      });
    }
    const page = await session.transaction(async (tx) => payouts.list(tx, { limit: 10 }));
    expect(page.items).toHaveLength(2);
    for (const payout of page.items) expect(payout.batchId).toBe(result.batch.id);
  });
});
