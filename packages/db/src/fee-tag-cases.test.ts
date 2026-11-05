// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One test per edge of the fee and tag rules, each naming the contract rule or the
// contract exploit test it mirrors, so the database and the contract can be read side by
// side. A database that accepts what the contract refuses would plan a payout that can
// never execute.

import { randomUUID } from 'node:crypto';

import { I128_MAX } from '@ujira/core';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { mandateInstances } from './repositories/mandates.js';
import { payoutAttempts, payouts, type NewPayoutLeg } from './repositories/payouts.js';
import { payoutMethods } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  feeTerms,
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

const TOP_TAG = 2n ** 64n - 1n;

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;
let termsId: string;
let payoutId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function cap(total: bigint, bps: bigint): bigint {
  return (total / 10_000n) * bps + ((total % 10_000n) * bps) / 10_000n;
}

async function attempt(total: bigint, fee: bigint, bps: number, terms: string | null = termsId) {
  return db.tenant(fixture.tenant).transaction(async (tx) =>
    payoutAttempts.create(
      tx,
      newAttempt(fixture, payoutId, {
        total: usdc(total),
        legs: [newLeg(fixture, total)],
        fee: { amount: fee, bps, termsId: fee === 0n ? null : terms },
      }),
    ),
  );
}

async function tagged(tag: bigint | null, address = fixture.destinationAddress) {
  return db.tenant(fixture.tenant).transaction(async (tx) =>
    payoutMethods.create(tx, {
      recipientId: fixture.recipientId,
      method: 'stellar_wallet',
      rail: 'wallet',
      chain: 'stellar',
      destinationAddress: address,
      destinationTag: tag,
      details: null,
    }),
  );
}

function legTo(payoutMethodId: string, tag: bigint | null, amount: bigint): NewPayoutLeg {
  return {
    payoutMethodId,
    method: 'stellar_wallet',
    destinationAddress: fixture.destinationAddress,
    destinationTag: tag,
    amount,
  };
}

async function attemptWith(legs: readonly NewPayoutLeg[]) {
  const total = legs.reduce((sum, item) => sum + item.amount, 0n);
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) =>
      payoutAttempts.create(tx, newAttempt(fixture, payoutId, { total: usdc(total), legs })),
    );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  termsId = await feeTerms(db, fixture);
  const { payout } = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
  payoutId = payout.id;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('fee cases', () => {
  // MANDATE-FEE-001: paid on top, and the recipient receives exactly the total.
  it('the fee is on top of the total, so the legs sum to the total', async () => {
    const accepted = await attempt(ONE_USDC, 100n, 50);
    expect(accepted.total).toEqual(usdc(ONE_USDC));
    expect(accepted.charged).toEqual(usdc(ONE_USDC + 100n));
  });

  // MANDATE-FEE-001: the fee is not a leg.
  it('legs that sum to the charge rather than the total are refused', async () => {
    const legs = db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutAttempts.create(
        tx,
        newAttempt(fixture, payoutId, {
          total: usdc(ONE_USDC),
          legs: [newLeg(fixture, ONE_USDC + 100n)],
          fee: { amount: 100n, bps: 50, termsId },
        }),
      ),
    );
    expect(await codeOf(legs)).toBe('UJ005');
  });

  // MANDATE-FEE-003: with a rate of 0 every non-zero fee fails.
  it('a rate of 0 allows no fee at all', async () => {
    expect(await codeOf(attempt(ONE_USDC, 1n, 0))).toBe('23514');
    expect((await attempt(ONE_USDC, 0n, 0)).fee).toEqual(usdc(0n));
  });

  // MANDATE-CONFIG: MAX_FEE_BPS is 100, one percent.
  it('the top rate is one percent, exactly', async () => {
    expect(await codeOf(attempt(10_000n, 101n, 100))).toBe('23514');
    expect((await attempt(10_000n, 100n, 100)).fee).toEqual(usdc(100n));
  });

  // exploit_fee_rounding_favours_the_principal: 99 is too small for any fee.
  it('a total too small for any fee can carry none', async () => {
    expect(await codeOf(attempt(99n, 1n, 100))).toBe('23514');
    expect((await attempt(99n, 0n, 100)).charged).toEqual(usdc(99n));
  });

  // exploit_fee_rounding_favours_the_principal: the same total at once rounds down too.
  it('rounds down, in the principal favour', async () => {
    expect(await codeOf(attempt(990n, 10n, 100))).toBe('23514');
    expect((await attempt(990n, 9n, 100)).fee).toEqual(usdc(9n));
  });

  // MANDATE-AMOUNT: a fee past I128_MAX - total is an amount error.
  it('a charge that would pass the top of the range is refused', async () => {
    expect(await codeOf(attempt(I128_MAX, cap(I128_MAX, 100n), 100))).toBe('23514');
  });

  // exploit_fee_overflow_at_the_i128_edges: the largest total whose full fee fits.
  it('the largest total whose full fee fits goes through, and the next does not', async () => {
    let low = 1n;
    let high = I128_MAX;
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if (middle + cap(middle, 100n) <= I128_MAX) low = middle;
      else high = middle - 1n;
    }
    expect(await codeOf(attempt(low + 1n, cap(low + 1n, 100n), 100))).toBe('23514');
    expect((await attempt(low, cap(low, 100n), 100)).charged.amount).toBeLessThanOrEqual(I128_MAX);
  });

  // MANDATE-FEE-005: a rate outside 0 to 100 cannot be set at creation.
  it('an instance cannot be made with a cap above the ceiling', async () => {
    const created = db.tenant(fixture.tenant).transaction(async (tx) =>
      mandateInstances.create(tx, {
        mandateId: fixture.mandateId,
        chain: 'stellar',
        contractAddress: `C${randomUUID()}`,
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
        maxFeeBps: 101,
      }),
    );
    expect(await codeOf(created)).toBe('23514');
  });

  it('a fee must name terms that exist', async () => {
    expect(await codeOf(attempt(ONE_USDC, 100n, 50, randomUUID()))).toBe('23503');
  });

  it('a fee cannot name the terms of another tenant', async () => {
    const other = await payoutFixture(db);
    const theirs = await feeTerms(db, other);
    expect(await codeOf(attempt(ONE_USDC, 100n, 50, theirs))).toBe('23503');
  });
});

describe('tag cases', () => {
  it('the largest tag is accepted and one more is refused', async () => {
    expect((await tagged(TOP_TAG)).destinationTag).toBe(TOP_TAG);
    expect(await codeOf(tagged(TOP_TAG + 1n))).toBe('23514');
  });

  it('a negative tag is refused', async () => {
    expect(await codeOf(tagged(-1n))).toBe('23514');
  });

  it('a tag of 0 is a tag, and is a different destination from having none', async () => {
    const address = `G${randomUUID()}`;
    await tagged(null, address);
    expect((await tagged(0n, address)).destinationTag).toBe(0n);
    expect(await codeOf(tagged(0n, address))).toBe('23505');
    expect(await codeOf(tagged(null, address))).toBe('23505');
  });

  it('one attempt may pay an address untagged and tagged, but not twice the same way', async () => {
    const zero = await tagged(0n);
    const accepted = await attemptWith([
      legTo(fixture.methodId, null, ONE_USDC),
      legTo(zero.id, 0n, ONE_USDC),
    ]);
    expect(accepted.total).toEqual(usdc(2n * ONE_USDC));
    const { payout } = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    payoutId = payout.id;
    const twice = attemptWith([
      legTo(fixture.methodId, null, ONE_USDC),
      legTo(fixture.methodId, null, ONE_USDC),
    ]);
    expect(await codeOf(twice)).toBe('23505');
  });

  it('a leg that leaves off the tag its method has is refused', async () => {
    const seven = await tagged(7n);
    expect(await codeOf(attemptWith([legTo(seven.id, null, ONE_USDC)]))).toBe('UJ010');
  });

  it('a leg that adds a tag its method does not have is refused', async () => {
    expect(await codeOf(attemptWith([legTo(fixture.methodId, 7n, ONE_USDC)]))).toBe('UJ010');
  });

  it('a leg with another tag than its method is refused, at the top of the range too', async () => {
    const top = await tagged(TOP_TAG);
    expect(await codeOf(attemptWith([legTo(top.id, TOP_TAG - 1n, ONE_USDC)]))).toBe('UJ010');
  });
});
