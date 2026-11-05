// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What was expected, what the chain says and what actually arrived, one row per
// executed attempt and revision. The outcome and shortfall follow from the figures, so
// the database refuses a row whose words disagree with its numbers.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { fees, type NewFeeReconciliation } from './repositories/fees.js';
import { IdempotencyConflictError, payoutAttempts, payouts } from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  feeTerms,
  newAttempt,
  newPayout,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const FEE = 25_000n;

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;
let attemptId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function record(overrides: Partial<NewFeeReconciliation> = {}) {
  return db.tenant(fixture.tenant).transaction(async (tx) =>
    fees.recordReconciliation(tx, {
      attemptId,
      revision: 1,
      expected: FEE,
      onChain: FEE,
      received: FEE,
      ...overrides,
    }),
  );
}

async function settle(id: string): Promise<void> {
  await db.tenant(fixture.tenant).transaction(async (tx) => {
    await payoutAttempts.transition(tx, id, { from: 'created', to: 'requested' });
    await payoutAttempts.transition(tx, id, {
      from: 'requested',
      to: 'executing',
      onChainPayoutId: '1',
    });
    await payoutAttempts.transition(tx, id, { from: 'executing', to: 'settled' });
  });
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  const termsId = await feeTerms(db, fixture);
  attemptId = await db.tenant(fixture.tenant).transaction(async (tx) => {
    const { payout } = await payouts.create(tx, newPayout(fixture));
    const attempt = await payoutAttempts.create(
      tx,
      newAttempt(fixture, payout.id, { fee: { amount: FEE, bps: 50, termsId } }),
    );
    return attempt.id;
  });
  await settle(attemptId);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('fee reconciliations', () => {
  it('matches when all three figures agree', async () => {
    const result = await record();
    expect(result?.created).toBe(true);
    expect(result?.reconciliation).toMatchObject({
      attemptId,
      revision: 1,
      expected: usdc(FEE),
      onChain: usdc(FEE),
      received: usdc(FEE),
      shortfall: usdc(0n),
      outcome: 'matched',
      resolution: 'none',
      invoiceReference: null,
    });
  });

  it('is underpaid by what did not arrive', async () => {
    const result = await record({ received: FEE - 7n });
    expect(result?.reconciliation).toMatchObject({
      shortfall: usdc(7n),
      outcome: 'underpaid',
    });
  });

  it.each([
    ['more arrived than expected', { received: FEE + 1n }],
    ['the chain disagrees with what arrived', { onChain: FEE - 1n }],
  ])('is a mismatch with no shortfall when %s', async (_name, figures) => {
    const result = await record(figures);
    expect(result?.reconciliation).toMatchObject({ shortfall: usdc(0n), outcome: 'mismatch' });
  });

  it('records a shortfall invoiced or waived', async () => {
    const invoiced = await record({
      received: 0n,
      resolution: { kind: 'invoiced', invoiceReference: 'INV-204' },
    });
    expect(invoiced?.reconciliation).toMatchObject({
      resolution: 'invoiced',
      invoiceReference: 'INV-204',
    });
    const waived = await record({ revision: 2, received: 0n, resolution: { kind: 'waived' } });
    expect(waived?.reconciliation).toMatchObject({ resolution: 'waived', invoiceReference: null });
  });

  it('refuses a resolution on a fee that matched', async () => {
    expect(await codeOf(record({ resolution: { kind: 'waived' } }))).toBe('23514');
  });

  it('keeps one row per attempt and revision, and a retry finds it', async () => {
    const first = await record();
    const retry = await record();
    expect(retry?.created).toBe(false);
    expect(retry?.reconciliation.id).toBe(first?.reconciliation.id);
    const next = await record({ revision: 2, received: FEE - 1n });
    expect(next?.created).toBe(true);
    const found = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => fees.reconciliation(tx, attemptId, 2));
    expect(found?.outcome).toBe('underpaid');
  });

  it('refuses the same revision with other figures', async () => {
    await record();
    await expect(record({ received: FEE - 1n })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('needs an executed attempt', async () => {
    const live = await db.tenant(fixture.tenant).transaction(async (tx) => {
      const { payout } = await payouts.create(tx, newPayout(fixture));
      return payoutAttempts.create(tx, newAttempt(fixture, payout.id));
    });
    expect(await codeOf(record({ attemptId: live.id }))).toBe('UJ019');
  });

  it('accepts an attempt that has gone final', async () => {
    await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutAttempts.transition(tx, attemptId, { from: 'settled', to: 'final' }),
      );
    expect((await record())?.created).toBe(true);
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

    async function insert(row: {
      readonly expected: bigint;
      readonly onChain: bigint;
      readonly received: bigint;
      readonly shortfall: bigint;
      readonly outcome: string;
      readonly resolution?: string;
      readonly invoice?: string | null;
    }) {
      await admin.query('begin');
      try {
        // Triggers off, so only the row's own checks can answer.
        await admin.query('set local session_replication_role = replica');
        await admin.query(
          `insert into ujira.fee_reconciliations
             (principal_id, project_id, payout_id, attempt_id, revision, chain, asset, scale,
              expected_fee_amount, on_chain_fee_amount, received_fee_amount, shortfall_amount,
              outcome, resolution, invoice_reference)
           values ($1, $2, gen_random_uuid(), $3, 1, 'stellar', 'USDC', 7, $4::numeric, $5::numeric,
                   $6::numeric, $7::numeric, $8, $9, $10)`,
          [
            fixture.tenant.principalId,
            fixture.tenant.projectId,
            attemptId,
            row.expected.toString(),
            row.onChain.toString(),
            row.received.toString(),
            row.shortfall.toString(),
            row.outcome,
            row.resolution ?? 'none',
            row.invoice ?? null,
          ],
        );
      } finally {
        await admin.query('rollback');
      }
    }

    it('accepts figures that tie to their outcome', async () => {
      const row = {
        expected: 10n,
        onChain: 10n,
        received: 7n,
        shortfall: 3n,
        outcome: 'underpaid',
      };
      expect(await codeOf(insert(row))).toBeUndefined();
    });

    it.each([
      [
        'a shortfall that is not what is missing',
        { received: 7n, shortfall: 2n, outcome: 'underpaid' },
      ],
      ['a shortfall on nothing missing', { shortfall: 1n, outcome: 'matched' }],
      ['matched when it did not', { received: 7n, shortfall: 3n, outcome: 'matched' }],
      ['underpaid when it was not', { outcome: 'underpaid' }],
      ['mismatch when all agree', { outcome: 'mismatch' }],
      ['a negative amount', { received: -1n, shortfall: 11n, outcome: 'underpaid' }],
      ['an outcome it does not know', { outcome: 'close_enough' }],
      [
        'an invoice reference without invoiced',
        { received: 7n, shortfall: 3n, outcome: 'underpaid', invoice: 'INV-1' },
      ],
      [
        'invoiced without a reference',
        { received: 7n, shortfall: 3n, outcome: 'underpaid', resolution: 'invoiced' },
      ],
    ])('refuses %s', async (_name, overrides) => {
      const row = { expected: 10n, onChain: 10n, received: 10n, shortfall: 0n, outcome: 'matched' };
      expect(await codeOf(insert({ ...row, ...overrides }))).toBe('23514');
    });

    it('is append only for everyone, the superuser included', async () => {
      const result = await record();
      const id = result?.reconciliation.id;
      expect(
        await codeOf(admin.query('delete from ujira.fee_reconciliations where id = $1', [id])),
      ).toBe('UJ002');
      expect(
        await codeOf(
          admin.query(`update ujira.fee_reconciliations set resolution = 'none' where id = $1`, [
            id,
          ]),
        ),
      ).toBe('UJ002');
    });
  });
});
