// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The agreed rate over time. An attempt names the terms it was charged under, so terms
// are append only, and setting them always leaves an audit row.

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { sql } from 'kysely';
import { audit } from './repositories/audit.js';
import { fees, FeeTermsExistError, type NewFeeTerms } from './repositories/fees.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { payoutFixture, type PayoutFixture } from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const JANUARY = new Date('2026-01-01T00:00:00.000Z');
const MARCH = new Date('2026-03-01T00:00:00.000Z');

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function record(overrides: Partial<NewFeeTerms> = {}) {
  return db.tenant(fixture.tenant).transaction(async (tx) =>
    fees.recordTerms(tx, {
      rateBps: 50,
      basis: 'standard',
      validFrom: JANUARY,
      contractReference: null,
      actor: { kind: 'member', id: fixture.memberId },
      ...overrides,
    }),
  );
}

async function termsAt(at: Date) {
  return db.tenant(fixture.tenant).transaction(async (tx) => fees.termsAt(tx, at));
}

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

describe('fee terms', () => {
  it('termsAt returns the latest valid_from at or before the instant', async () => {
    const first = await record({ rateBps: 50, validFrom: JANUARY });
    const second = await record({
      rateBps: 30,
      basis: 'committed_volume',
      validFrom: MARCH,
      contractReference: 'MSA-2026-014',
    });

    expect(await termsAt(new Date('2025-12-31T23:59:59.999Z'))).toBeUndefined();
    expect((await termsAt(JANUARY))?.id).toBe(first.id);
    expect((await termsAt(new Date('2026-02-28T23:59:59.999Z')))?.id).toBe(first.id);
    const latest = await termsAt(MARCH);
    expect(latest).toMatchObject({
      id: second.id,
      rateBps: 30,
      basis: 'committed_volume',
      contractReference: 'MSA-2026-014',
    });
    expect(latest?.validFrom).toEqual(MARCH);
  });

  it('writes the audit row with the terms, naming only the terms and the rate', async () => {
    const terms = await record({ rateBps: 25 });
    const page = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => audit.list(tx, { limit: 100 }));
    const entry = page.items.find((item) => item.action === 'fee_terms.recorded');
    expect(entry).toMatchObject({
      actorKind: 'member',
      actorId: fixture.memberId,
      metadata: { target_type: 'fee_terms', target_id: terms.id, new_value: '25' },
    });
  });

  it('allows one set of terms per project and instant, refused with a typed error', async () => {
    await record();
    await expect(record({ rateBps: 10 })).rejects.toBeInstanceOf(FeeTermsExistError);
  });

  it.each([101, -1])('refuses a rate of %s', async (rateBps) => {
    expect(await codeOf(record({ rateBps }))).toBe('23514');
  });

  it('refuses a basis it does not know', async () => {
    const attempt = record({ basis: 'friends_and_family' as NewFeeTerms['basis'] });
    expect(await codeOf(attempt)).toBe('23514');
  });

  // Terms reach the table through the audited function or not at all.
  it('has no way in for the app but that function', async () => {
    const attempt = db.tenant(fixture.tenant).transaction(async (tx) =>
      tx
        .insertInto('ujira.fee_terms')
        .values({
          principal_id: sql<string>`ujira.current_principal_id()`,
          project_id: sql<string>`ujira.current_project_id()`,
          rate_bps: 1,
          basis: 'standard',
          valid_from: JANUARY,
        })
        .execute(),
    );
    expect(await codeOf(attempt)).toBe('42501');
  });

  it('is append only', async () => {
    const terms = await record();
    const change = db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        tx.updateTable('ujira.fee_terms').set({ rate_bps: 1 }).where('id', '=', terms.id).execute(),
      );
    expect(await codeOf(change)).toBe('42501');
  });
});
