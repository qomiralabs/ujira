// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The take rate is paid on chain as a fee on top of each payout, and the database
// holds the contract's own rules on it: charged is total plus fee, and the fee is never
// above the cap, computed the contract's way so a large total cannot overflow it.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { payoutAttempts, payouts } from './repositories/payouts.js';
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

const TERMS = randomUUID();

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;
let payoutId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function attemptWith(total: bigint, fee: bigint, bps: number) {
  return db.tenant(fixture.tenant).transaction(async (tx) =>
    payoutAttempts.create(
      tx,
      newAttempt(fixture, payoutId, {
        total: usdc(total),
        legs: [newLeg(fixture, total)],
        fee: { amount: fee, bps, termsId: fee === 0n ? null : TERMS },
      }),
    ),
  );
}

// What the contract computes, and what the check must agree with.
function cap(total: bigint, bps: bigint): bigint {
  return (total / 10_000n) * bps + ((total % 10_000n) * bps) / 10_000n;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  const { payout } = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
  payoutId = payout.id;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the fee on an attempt', () => {
  it('fee one unit over the cap is rejected, at the cap accepted', async () => {
    const total = 12_345n * ONE_USDC + 6789n;
    const atCap = cap(total, 50n);
    expect(await codeOf(attemptWith(total, atCap + 1n, 50))).toBe('23514');
    const accepted = await attemptWith(total, atCap, 50);
    expect(accepted.fee).toEqual(usdc(atCap));
    expect(accepted.feeBps).toBe(50);
    expect(accepted.feeTermsId).toBe(TERMS);
  });

  it('rounds the cap down the way the contract does', async () => {
    // 9_999 at 1 bp is 0.9999 of a unit, so the cap is 0 and any fee is over it.
    expect(await codeOf(attemptWith(9_999n, 1n, 1))).toBe('23514');
    expect((await attemptWith(10_000n, 1n, 1)).fee).toEqual(usdc(1n));
  });

  it('computes the cap without overflow at the largest total', async () => {
    const total = 2n ** 126n;
    const accepted = await attemptWith(total, cap(total, 100n), 100);
    expect(accepted.charged).toEqual(usdc(total + cap(total, 100n)));
  });

  it('charged is total plus fee, written for the caller', async () => {
    const total = 5n * ONE_USDC;
    const accepted = await attemptWith(total, 100n, 50);
    expect(accepted.charged).toEqual(usdc(total + 100n));
  });

  it('a fee of zero needs no terms', async () => {
    const accepted = await attemptWith(5n * ONE_USDC, 0n, 0);
    expect(accepted.fee).toEqual(usdc(0n));
    expect(accepted.feeTermsId).toBeNull();
    expect(accepted.charged).toEqual(usdc(5n * ONE_USDC));
  });

  it('an attempt that names no fee has none', async () => {
    const accepted = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutAttempts.create(tx, newAttempt(fixture, payoutId)));
    expect(accepted.fee).toEqual(usdc(0n));
    expect(accepted.feeBps).toBe(0);
    expect(accepted.charged).toEqual(accepted.total);
  });

  it('a fee above zero needs terms', async () => {
    const attempt = db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutAttempts.create(
          tx,
          newAttempt(fixture, payoutId, { fee: { amount: 100n, bps: 50, termsId: null } }),
        ),
      );
    expect(await codeOf(attempt)).toBe('23514');
  });

  it.each([
    ['a rate above 100', 10_000n, 101],
    ['a negative rate', 0n, -1],
    ['a negative fee', -1n, 50],
  ])('refuses %s', async (_name, fee, bps) => {
    expect(await codeOf(attemptWith(100n * ONE_USDC, fee, bps))).toBe('23514');
  });

  describe('directly in the database', () => {
    let admin: pg.Client;

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: database.url });
      await admin.connect();
    });

    afterAll(async () => {
      await admin.end();
    });

    // Triggers are off so only the checks on the row can answer, and nothing is kept.
    async function insert(total: bigint, fee: bigint, charged: bigint) {
      await admin.query('begin');
      try {
        await admin.query('set local session_replication_role = replica');
        await admin.query(
          `insert into ujira.payout_attempts
             (principal_id, project_id, payout_id, attempt_number, chain, network,
              mandate_instance_id, total_amount, asset, scale, deadline, fee_amount,
              fee_bps_applied, fee_terms_id, charged_amount)
           values ($1, $2, $3, 1, 'stellar', 'stellar:testnet', $4, $5::numeric, 'USDC', 7, now(),
                   $6::numeric, 100, $7, $8::numeric)`,
          [
            fixture.tenant.principalId,
            fixture.tenant.projectId,
            payoutId,
            fixture.instanceId,
            total.toString(),
            fee.toString(),
            TERMS,
            charged.toString(),
          ],
        );
      } finally {
        await admin.query('rollback');
      }
    }

    it('wrong charged_amount is rejected', async () => {
      expect(await codeOf(insert(1_000_000n, 100n, 1_000_101n))).toBe('23514');
      expect(await codeOf(insert(1_000_000n, 100n, 1_000_099n))).toBe('23514');
      expect(await codeOf(insert(1_000_000n, 100n, 1_000_100n))).toBeUndefined();
    });

    it('a fee over the cap is rejected for anyone who comes around the repository', async () => {
      expect(await codeOf(insert(10_000n, 2n, 10_002n))).toBeUndefined();
      expect(await codeOf(insert(10_000n, 101n, 10_101n))).toBe('23514');
    });
  });
});
