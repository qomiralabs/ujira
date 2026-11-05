// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { IdempotencyConflictError, payoutAttempts, payouts } from './repositories/payouts.js';
import {
  ReceiptDocumentHashError,
  receiptDocumentIntact,
  ReceiptRevisionError,
  receipts,
  type NewReceipt,
} from './repositories/receipts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newAttempt,
  newLeg,
  newPayout,
  ONE_USDC,
  payoutFixture,
  receiptFields,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const FIRST_LEG = 3n * ONE_USDC;
const SECOND_LEG = 2n * ONE_USDC;
const TOTAL = FIRST_LEG + SECOND_LEG;
const MASKED = 'GABC...WXYZ';

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;
let payoutId: string;
let attemptId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function receipt(overrides: Partial<NewReceipt> = {}): NewReceipt {
  return {
    payoutId,
    attemptId,
    revision: 1,
    ...receiptFields(payoutId, 1),
    chainReceiptRef: 'receipt-ref',
    settlement: usdc(TOTAL),
    fee: 30n,
    legs: [
      {
        legIndex: 0,
        destinationMasked: MASKED,
        amount: FIRST_LEG,
        fee: 10n,
        chainReceiptRef: 'tx-0',
      },
      {
        legIndex: 1,
        destinationMasked: MASKED,
        amount: SECOND_LEG,
        fee: 20n,
        chainReceiptRef: 'tx-1',
      },
    ],
    ...overrides,
  };
}

async function record(overrides: Partial<NewReceipt> = {}) {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) => receipts.record(tx, receipt(overrides)));
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  const made = await db.tenant(fixture.tenant).transaction(async (tx) => {
    const { payout } = await payouts.create(tx, newPayout(fixture));
    const attempt = await payoutAttempts.create(
      tx,
      newAttempt(fixture, payout.id, {
        total: usdc(TOTAL),
        legs: [newLeg(fixture, FIRST_LEG, 0), newLeg(fixture, SECOND_LEG, 1)],
      }),
    );
    return { payoutId: payout.id, attemptId: attempt.id };
  });
  payoutId = made.payoutId;
  attemptId = made.attemptId;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('revisions', () => {
  it('a correction inserts revision 2 and keeps revision 1', async () => {
    const first = await record();
    const corrected = await record({
      ...receiptFields(payoutId, 2, first.receipt.documentSha256),
      revision: 2,
      chainReceiptRef: 'corrected-ref',
    });
    expect(corrected.created).toBe(true);
    const session = db.tenant(fixture.tenant);
    const all = await session.transaction(async (tx) => receipts.revisions(tx, payoutId));
    expect(all.map((row) => row.revision)).toEqual([1, 2]);
    expect(all[0]).toEqual(first.receipt);
    expect(all[1]?.chainReceiptRef).toBe('corrected-ref');
    expect(all[1]?.supersedesSha256).toBe(first.receipt.documentSha256);
    const latest = await session.transaction(async (tx) => receipts.latest(tx, payoutId));
    expect(latest?.revision).toBe(2);
  });

  it('a retry finds the first, and a different document is refused', async () => {
    const first = await record();
    expect(await record()).toEqual({ receipt: first.receipt, created: false });
    await expect(record(receiptFields(payoutId, 1, null, 'something else'))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('of parallel records of one revision, one writes', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, async () => record()));
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('refuses a revision that skips one, or that is below 1', async () => {
    await expect(record({ revision: 2 })).rejects.toBeInstanceOf(ReceiptRevisionError);
    await expect(record({ revision: 0 })).rejects.toBeInstanceOf(ReceiptRevisionError);
  });

  it('refuses a correction that names the wrong document, or none', async () => {
    await record();
    const fields = receiptFields(payoutId, 2, 'ab'.repeat(32));
    await expect(record({ ...fields, revision: 2 })).rejects.toBeInstanceOf(ReceiptRevisionError);
    await expect(record({ ...fields, revision: 2, supersedesSha256: null })).rejects.toBeInstanceOf(
      ReceiptRevisionError,
    );
  });

  it('holds the chain in the database too', async () => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const { tenant } = fixture;
      const fields = receiptFields(payoutId, 1);
      const insert = async (revision: number, supersedes: Buffer | null) =>
        admin.query(
          `insert into ujira.receipts
             (principal_id, project_id, payout_id, attempt_id, revision, receipt_number, network,
              issued_at, chain_receipt_ref, chain, asset, scale, settlement_amount,
              canonical_document, document_sha256, supersedes_sha256)
           values ($1, $2, $3, $4, $5, $6, 'stellar:testnet', now(), 'ref', 'stellar', 'USDC', 7, 1,
                   'doc', $7, $8)`,
          [
            tenant.principalId,
            tenant.projectId,
            payoutId,
            attemptId,
            revision,
            fields.receiptNumber,
            Buffer.alloc(32),
            supersedes,
          ],
        );
      expect(await codeOf(insert(1, Buffer.alloc(32)))).toBe('23514');
      expect(await codeOf(insert(2, null))).toBe('23514');
    } finally {
      await admin.end();
    }
  });

  it('has nothing for a payout with no receipt', async () => {
    const session = db.tenant(fixture.tenant);
    expect(await session.transaction(async (tx) => receipts.latest(tx, payoutId))).toBeUndefined();
    expect(await session.transaction(async (tx) => receipts.revisions(tx, payoutId))).toEqual([]);
  });
});

describe('the document', () => {
  it('keeps the exact text it was hashed from, whitespace and key order included', async () => {
    const document = '{ "z":1,  "a":[ 2,1 ],"m":"\\u00e9" }';
    const documentSha256 = createHash('sha256').update(document, 'utf8').digest('hex');
    const { receipt: written } = await record({ document, documentSha256 });
    expect(written.document).toBe(document);
    expect(written.documentSha256).toBe(documentSha256);
    expect(receiptDocumentIntact(written)).toBe(true);
  });

  it('refuses a document that does not match its hash', async () => {
    await expect(
      record({ document: '{"changed":true}', documentSha256: 'ab'.repeat(32) }),
    ).rejects.toBeInstanceOf(ReceiptDocumentHashError);
  });

  it('a stored document altered behind the rules no longer checks out', async () => {
    const { receipt: written } = await record();
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query('alter table ujira.receipts disable trigger receipts_append_only');
      await admin.query(
        `update ujira.receipts set canonical_document = '{"forged":1}' where id = $1`,
        [written.id],
      );
      await admin.query('alter table ujira.receipts enable trigger receipts_append_only');
    } finally {
      await admin.end();
    }
    const read = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => receipts.byNumber(tx, written.receiptNumber));
    expect(read).toBeDefined();
    if (read !== undefined) expect(receiptDocumentIntact(read)).toBe(false);
  });

  it('exports the stored documents in pages', async () => {
    const { receipt: written } = await record();
    const session = db.tenant(fixture.tenant);
    const page = await session.transaction(async (tx) => receipts.list(tx, { limit: 10 }));
    expect(page.items.map((row) => row.document)).toEqual([written.document]);
  });
});

describe('the receipt number', () => {
  it('finds a receipt by its number', async () => {
    const { receipt: written } = await record();
    const session = db.tenant(fixture.tenant);
    const found = await session.transaction(async (tx) =>
      receipts.byNumber(tx, written.receiptNumber),
    );
    expect(found).toEqual(written);
    expect(
      await session.transaction(async (tx) => receipts.byNumber(tx, 'R-000000000000')),
    ).toBeUndefined();
  });

  it('is unique within a tenant', async () => {
    const { receipt: written } = await record();
    const other = await db.tenant(fixture.tenant).transaction(async (tx) => {
      const { payout } = await payouts.create(tx, newPayout(fixture));
      const attempt = await payoutAttempts.create(
        tx,
        newAttempt(fixture, payout.id, {
          total: usdc(TOTAL),
          legs: [newLeg(fixture, FIRST_LEG, 0), newLeg(fixture, SECOND_LEG, 1)],
        }),
      );
      return { payoutId: payout.id, attemptId: attempt.id };
    });
    expect(
      await codeOf(
        record({
          ...other,
          ...receiptFields(other.payoutId, 1),
          receiptNumber: written.receiptNumber,
        }),
      ),
    ).toBe('23505');
  });

  it.each(['R-123', 'r-ABCDEFGHIJKL', 'R-ABCDEFGHIJK!', 'X-ABCDEFGHIJKL'])(
    'refuses %s',
    async (receiptNumber) => {
      expect(await codeOf(record({ receiptNumber }))).toBe('23514');
    },
  );
});

describe('what a receipt lists', () => {
  it('lists every leg with a masked destination and its chain reference', async () => {
    const { receipt: written } = await record();
    const legs = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => receipts.legs(tx, written.id));
    expect(
      legs.map((leg) => [
        leg.legIndex,
        leg.destinationMasked,
        leg.amount,
        leg.fee,
        leg.chainReceiptRef,
      ]),
    ).toEqual([
      [0, MASKED, usdc(FIRST_LEG), usdc(10n), 'tx-0'],
      [1, MASKED, usdc(SECOND_LEG), usdc(20n), 'tx-1'],
    ]);
    expect(written.settlement).toEqual(usdc(TOTAL));
    expect(written.fee).toEqual(usdc(30n));
  });

  it('cannot hold a full address, so a receipt can be kept for good', async () => {
    const whole = receipt();
    const [first, second] = whole.legs;
    if (first === undefined || second === undefined) throw new Error('the fixture has legs');
    const full = `G${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '').slice(0, 23)}`;
    expect(full).toHaveLength(56);
    expect(await codeOf(record({ legs: [{ ...first, destinationMasked: full }, second] }))).toBe(
      '23514',
    );
  });

  it('a receipt missing a leg is refused at commit', async () => {
    const whole = receipt();
    expect(
      await codeOf(record({ settlement: usdc(FIRST_LEG), fee: 10n, legs: whole.legs.slice(0, 1) })),
    ).toBe('UJ016');
  });

  it('a receipt with no legs is refused at commit', async () => {
    expect(await codeOf(record({ legs: [] }))).toBe('UJ016');
  });

  it('totals that are not the sums of the legs are refused at commit', async () => {
    expect(await codeOf(record({ settlement: usdc(TOTAL - 1n) }))).toBe('UJ016');
    expect(await codeOf(record({ fee: 31n }))).toBe('UJ016');
  });

  it('refuses a leg its attempt does not have', async () => {
    const whole = receipt();
    const [first] = whole.legs;
    if (first === undefined) throw new Error('the fixture has legs');
    expect(await codeOf(record({ legs: [first, { ...first, legIndex: 2 }] }))).toBe('23503');
  });

  it('refuses another payout attempt, by foreign key', async () => {
    const other = await db.tenant(fixture.tenant).transaction(async (tx) => {
      const { payout } = await payouts.create(tx, newPayout(fixture));
      return payoutAttempts.create(tx, newAttempt(fixture, payout.id));
    });
    expect(await codeOf(record({ attemptId: other.id }))).toBe('23503');
  });

  it('refuses a network on another chain than its unit, or a name that is no network', async () => {
    expect(await codeOf(record({ network: 'stellar' }))).toBe('23514');
  });

  it('is untouchable by the owner', async () => {
    const { receipt: written } = await record();
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      for (const statement of [
        `update ujira.receipts set chain_receipt_ref = 'x' where id = '${written.id}'`,
        `delete from ujira.receipts where id = '${written.id}'`,
        `update ujira.receipt_legs set chain_receipt_ref = 'x' where receipt_id = '${written.id}'`,
        `delete from ujira.receipt_legs where receipt_id = '${written.id}'`,
      ]) {
        await admin.query('begin');
        await admin.query('set local role ujira_owner');
        expect(await codeOf(admin.query(statement)), statement).toBe('UJ002');
        await admin.query('rollback');
      }
    } finally {
      await admin.end();
    }
  });
});
