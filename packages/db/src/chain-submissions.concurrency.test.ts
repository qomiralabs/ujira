// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Two live submissions of one step could pay twice, so only the database can decide
// which job wins.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { chainSubmissions } from './repositories/chain-store.js';
import { entryPoints } from './repositories/entry-points.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('one live submission', () => {
  it('20 parallel records for the same network, mandate, payout id and op leave one live row', async () => {
    const tenant = await db.unscoped(async (tx) =>
      entryPoints.createPrincipal(tx, {
        name: 'Acme',
        projectName: 'Main',
        ownerUserId: randomUUID(),
      }),
    );
    const payoutId = `0x${randomBytes(32).toString('hex')}`;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, async () =>
        db.tenant(tenant).transaction(async (tx) =>
          chainSubmissions.record(tx, {
            network: 'stellar:testnet',
            txHash: randomBytes(32).toString('hex'),
            op: 'execute',
            mandate: 'CMANDATE',
            payoutId,
            attempt: 1,
            signerAddress: 'GSIGNER',
            sequenceOrNonce: 1n,
            maxTime: null,
            replacesTxHash: null,
            submittedAtLedger: null,
            reservationId: null,
            correlationId: 'corr',
            createdAt: new Date(),
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect((result.reason as { code?: string }).code).toBe('23505');
      }
    }
  }, 120_000);
});
