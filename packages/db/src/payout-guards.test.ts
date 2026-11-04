// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Two rules that protect money, held by the database so that no code path can skip
// them: no new attempt on a terminal payout, and no attempt committed without legs.

import { randomUUID } from 'node:crypto';

import { TERMINAL_PAYOUT_STATUSES } from '@ujira/api-schema';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import type { Database } from './database.js';
import { PAYOUT_STATUS_VALUES, payoutAttempts, payouts } from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newAttempt,
  payoutFixture,
  newPayout,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TERMINAL = [...TERMINAL_PAYOUT_STATUSES];
const OPEN = PAYOUT_STATUS_VALUES.filter((status) => !(TERMINAL as string[]).includes(status));

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let fixture: PayoutFixture;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// Written directly, because no path through the repository reaches every status
// with a payout that has never had an attempt.
async function payoutAt(status: string): Promise<string> {
  const { tenant, recipientId, mandateId } = fixture;
  const inserted = await admin.query<{ id: string }>(
    `insert into ujira.payouts
       (principal_id, project_id, idempotency_key, request_hash, recipient_id, mandate_id, method,
        cashout_cost_bearer, requested_amount, requested_asset, requested_chain,
        requested_token_scale, status)
     values ($1, $2, gen_random_uuid()::text, $3, $4, $5, 'stellar_wallet', 'recipient', 1,
             'USDC', 'stellar', 7, $6)
     returning id`,
    [tenant.principalId, tenant.projectId, Buffer.alloc(32), recipientId, mandateId, status],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('the fixture payout was not stored');
  return id;
}

const INSERT_ATTEMPT = `
  insert into ujira.payout_attempts
    (principal_id, project_id, payout_id, attempt_number, chain, network, mandate_instance_id,
     total_amount, asset, scale, deadline)
  values ($1, $2, $3, 1, 'stellar', 'stellar:testnet', $4, 10, 'USDC', 7, now())
  returning id`;

function attemptValues(payoutId: string): unknown[] {
  return [fixture.tenant.principalId, fixture.tenant.projectId, payoutId, fixture.instanceId];
}

const INSERT_LEG = `
  insert into ujira.payout_legs
    (principal_id, project_id, payout_id, attempt_id, leg_index, payout_method_id, method,
     destination_address, amount, chain, asset, scale)
  values ($1, $2, $3, $4, 0, $5, 'stellar_wallet', 'G', 10, 'stellar', 'USDC', 7)`;

function legValues(payoutId: string, attemptId: string): unknown[] {
  return [
    fixture.tenant.principalId,
    fixture.tenant.projectId,
    payoutId,
    attemptId,
    fixture.methodId,
  ];
}

async function attemptCount(payoutId: string): Promise<number> {
  const rows = await admin.query<{ count: string }>(
    'select count(*)::text as count from ujira.payout_attempts where payout_id = $1',
    [payoutId],
  );
  return Number(rows.rows[0]?.count);
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('a new attempt on a terminal payout', () => {
  it('covers every status the API calls terminal, and they are all real statuses', () => {
    expect(TERMINAL.length).toBeGreaterThan(0);
    for (const status of TERMINAL) expect(PAYOUT_STATUS_VALUES).toContain(status);
  });

  it.each(TERMINAL)('a %s payout refuses a new attempt through the repository', async (status) => {
    const payoutId = await payoutAt(status);
    expect(
      await codeOf(
        db
          .tenant(fixture.tenant)
          .transaction(async (tx) => payoutAttempts.create(tx, newAttempt(fixture, payoutId))),
      ),
    ).toBe('UJ017');
    expect(await attemptCount(payoutId)).toBe(0);
  });

  it.each(TERMINAL)('a %s payout refuses a direct insert, even by the owner', async (status) => {
    const payoutId = await payoutAt(status);
    await admin.query('begin');
    try {
      await admin.query('set local role ujira_owner');
      expect(await codeOf(admin.query(INSERT_ATTEMPT, attemptValues(payoutId)))).toBe('UJ017');
    } finally {
      await admin.query('rollback');
    }
  });

  it.each(OPEN)('a %s payout accepts one', async (status) => {
    const payoutId = await payoutAt(status);
    const attempt = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutAttempts.create(tx, newAttempt(fixture, payoutId)));
    expect(attempt.payoutId).toBe(payoutId);
  });

  // The race a read alone would lose: the cancel has not committed when the attempt
  // starts, so without the lock the attempt would read the old status and go through.
  it('an attempt waiting on a cancel that commits is refused', async () => {
    const { payout } = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    const canceller = new pg.Client({ connectionString: database.url });
    await canceller.connect();
    try {
      await canceller.query('begin');
      await canceller.query(`update ujira.payouts set status = 'cancelled' where id = $1`, [
        payout.id,
      ]);
      const attempt = codeOf(
        db
          .tenant(fixture.tenant)
          .transaction(async (tx) => payoutAttempts.create(tx, newAttempt(fixture, payout.id))),
      );
      await vi.waitFor(async () => {
        const waiting = await admin.query<{ count: string }>(
          `select count(*)::text as count from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
        );
        expect(waiting.rows[0]?.count).toBe('1');
      });
      await canceller.query('commit');
      expect(await attempt).toBe('UJ017');
    } finally {
      await canceller.end();
    }
    expect(await attemptCount(payout.id)).toBe(0);
  });

  it('an attempt waiting on a move that rolls back goes through', async () => {
    const { payout } = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    const canceller = new pg.Client({ connectionString: database.url });
    await canceller.connect();
    try {
      await canceller.query('begin');
      await canceller.query(`update ujira.payouts set status = 'cancelled' where id = $1`, [
        payout.id,
      ]);
      const attempt = db
        .tenant(fixture.tenant)
        .transaction(async (tx) => payoutAttempts.create(tx, newAttempt(fixture, payout.id)));
      await vi.waitFor(async () => {
        const waiting = await admin.query<{ count: string }>(
          `select count(*)::text as count from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
        );
        expect(waiting.rows[0]?.count).toBe('1');
      });
      await canceller.query('rollback');
      expect((await attempt).payoutId).toBe(payout.id);
    } finally {
      await canceller.end();
    }
  });

  it('leaves a live attempt alone when its payout moves to a terminal status', async () => {
    const { payout } = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    const session = db.tenant(fixture.tenant);
    await session.transaction(async (tx) =>
      payoutAttempts.create(tx, newAttempt(fixture, payout.id)),
    );
    const moved = await session.transaction(async (tx) =>
      payouts.transition(tx, payout.id, { from: 'received', to: 'cancelled' }),
    );
    expect(moved?.status).toBe('cancelled');
    expect(await attemptCount(payout.id)).toBe(1);
  });
});

describe('an attempt with no legs', () => {
  it('is refused at commit', async () => {
    const payoutId = await payoutAt('routed');
    await admin.query('begin');
    await admin.query(INSERT_ATTEMPT, attemptValues(payoutId));
    expect(await codeOf(admin.query('commit'))).toBe('UJ005');
    expect(await attemptCount(payoutId)).toBe(0);
  });

  it('is refused when written alone, outside any explicit transaction', async () => {
    const payoutId = await payoutAt('routed');
    expect(await codeOf(admin.query(INSERT_ATTEMPT, attemptValues(payoutId)))).toBe('UJ005');
    expect(await attemptCount(payoutId)).toBe(0);
  });

  it('commits when its legs follow it in the same transaction', async () => {
    const payoutId = await payoutAt('routed');
    await admin.query('begin');
    const inserted = await admin.query<{ id: string }>(INSERT_ATTEMPT, attemptValues(payoutId));
    await admin.query(INSERT_LEG, legValues(payoutId, inserted.rows[0]?.id ?? randomUUID()));
    await admin.query('commit');
    expect(await attemptCount(payoutId)).toBe(1);
  });

  it('a retry after dead still needs legs of its own', async () => {
    const payoutId = await payoutAt('routed');
    const session = db.tenant(fixture.tenant);
    const first = await session.transaction(async (tx) =>
      payoutAttempts.create(tx, newAttempt(fixture, payoutId)),
    );
    await session.transaction(async (tx) =>
      payoutAttempts.markDead(tx, first.id, { from: 'created', proof: { kind: 'tombstone' } }),
    );
    const second = admin.query(
      `insert into ujira.payout_attempts
         (principal_id, project_id, payout_id, attempt_number, chain, network, mandate_instance_id,
          total_amount, asset, scale, deadline)
       values ($1, $2, $3, 2, 'stellar', 'stellar:testnet', $4, 10, 'USDC', 7, now())`,
      attemptValues(payoutId),
    );
    expect(await codeOf(second)).toBe('UJ005');
  });
});
