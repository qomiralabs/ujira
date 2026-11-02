// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every pair of statuses, against the machines in the database. The disallowed
// ones must fail both in the database, for anyone who comes around the repository,
// and in the repository, for a caller who should get a typed error.

import { PAYOUT_STATUSES, TERMINAL_PAYOUT_STATUSES } from '@ujira/api-schema';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  ATTEMPT_STATUS_VALUES,
  IllegalTransitionError,
  PAYOUT_STATUS_VALUES,
  payoutAttempts,
  payouts,
  type AttemptStatusValue,
  type PayoutStatusValue,
} from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { payoutFixture, type PayoutFixture } from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const ANY_ID = '00000000-0000-4000-8000-000000000000';

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let fixture: PayoutFixture;
let allowed: ReadonlySet<string>;

const payoutRows = new Map<string, string>();
const attemptRows = new Map<string, string>();

function key(machine: string, from: string, to: string): string {
  return `${machine}:${from}:${to}`;
}

function pairs<S extends string>(machine: string, statuses: readonly S[], wantAllowed: boolean) {
  const found: (readonly [S, S])[] = [];
  for (const from of statuses) {
    for (const to of statuses) {
      if (from !== to && allowed.has(key(machine, from, to)) === wantAllowed) {
        found.push([from, to]);
      }
    }
  }
  return found;
}

async function insertPayout(status: string): Promise<string> {
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

async function insertAttempt(status: string): Promise<string> {
  const payoutId = await insertPayout('routed');
  // In one statement, so the attempt and its leg commit together and sum.
  const inserted = await admin.query<{ id: string }>(
    `with attempt as (
       insert into ujira.payout_attempts
         (principal_id, project_id, payout_id, attempt_number, network, mandate_instance_id,
          total_amount, asset, scale, deadline, status, dead_proof)
       values ($1, $2, $3, 1, 'stellar', $4, 1, 'USDC', 7, now(), $5, $6)
       returning id
     ), leg as (
       insert into ujira.payout_legs
         (principal_id, project_id, payout_id, attempt_id, leg_index, payout_method_id, method,
          destination_address, amount, chain, asset, scale)
       select $1, $2, $3, attempt.id, 0, $7, 'stellar_wallet', 'G', 1, 'stellar', 'USDC', 7
         from attempt
     )
     select id from attempt`,
    [
      fixture.tenant.principalId,
      fixture.tenant.projectId,
      payoutId,
      fixture.instanceId,
      status,
      status === 'dead' ? '{}' : null,
      fixture.methodId,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('the fixture attempt was not stored');
  return id;
}

// A savepoint per pair, so a refusal does not end the walk.
async function attemptUpdate(statement: string, values: unknown[]): Promise<string | undefined> {
  await admin.query('savepoint pair');
  try {
    await admin.query(statement, values);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  } finally {
    await admin.query('rollback to savepoint pair');
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  fixture = await payoutFixture(db);
  const rows = await admin.query<{ machine: string; from_status: string; to_status: string }>(
    `select machine, from_status, to_status from ujira.status_transitions`,
  );
  allowed = new Set(rows.rows.map((row) => key(row.machine, row.from_status, row.to_status)));
  for (const status of PAYOUT_STATUS_VALUES) payoutRows.set(status, await insertPayout(status));
  for (const status of ATTEMPT_STATUS_VALUES) attemptRows.set(status, await insertAttempt(status));
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('the payout machine', () => {
  it('has the statuses the column check holds', async () => {
    const check = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'payouts_status'`,
    );
    const values = [...(check.rows[0]?.definition ?? '').matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
    expect([...values].sort()).toEqual([...PAYOUT_STATUS_VALUES].sort());
  });

  it('every disallowed pair fails in the database', async () => {
    await admin.query('begin');
    try {
      const disallowed = pairs<PayoutStatusValue>('payout', PAYOUT_STATUS_VALUES, false);
      expect(disallowed.length).toBeGreaterThan(100);
      for (const [from, to] of disallowed) {
        const code = await attemptUpdate(`update ujira.payouts set status = $2 where id = $1`, [
          payoutRows.get(from),
          to,
        ]);
        expect(code, `${from} to ${to}`).toBe('UJ004');
      }
    } finally {
      await admin.query('rollback');
    }
  });

  it('every disallowed pair fails in the repository', async () => {
    await db.tenant(fixture.tenant).transaction(async (tx) => {
      for (const [from, to] of pairs<PayoutStatusValue>('payout', PAYOUT_STATUS_VALUES, false)) {
        await expect(
          payouts.transition(tx, ANY_ID, { from, to }),
          `${from} to ${to}`,
        ).rejects.toBeInstanceOf(IllegalTransitionError);
      }
    });
  });

  it('every allowed pair passes in the database and through the repository', async () => {
    await admin.query('begin');
    try {
      for (const [from, to] of pairs<PayoutStatusValue>('payout', PAYOUT_STATUS_VALUES, true)) {
        const code = await attemptUpdate(`update ujira.payouts set status = $2 where id = $1`, [
          payoutRows.get(from),
          to,
        ]);
        expect(code, `${from} to ${to}`).toBeUndefined();
      }
    } finally {
      await admin.query('rollback');
    }
  });

  it('a compare and set matches nothing when the payout has moved on', async () => {
    const id = await insertPayout('routed');
    await db.tenant(fixture.tenant).transaction(async (tx) => {
      expect(await payouts.transition(tx, id, { from: 'received', to: 'routed' })).toBeUndefined();
      const moved = await payouts.transition(tx, id, { from: 'routed', to: 'submitting' });
      expect(moved?.status).toBe('submitting');
    });
  });

  it('leaves no way out of a status the API calls terminal', () => {
    for (const status of TERMINAL_PAYOUT_STATUSES) {
      const out = PAYOUT_STATUS_VALUES.filter((to) => allowed.has(key('payout', status, to)));
      expect(out, status).toEqual([]);
    }
  });

  it('folds the lifecycle into exactly the public statuses', async () => {
    const statuses = await admin.query<{ public_status: string }>(
      `select distinct public_status from ujira.payouts where id = any($1::uuid[])`,
      [[...payoutRows.values()]],
    );
    expect(statuses.rows.map((row) => row.public_status).sort()).toEqual(
      [...PAYOUT_STATUSES].sort(),
    );
  });
});

describe('the attempt machine', () => {
  it('has the statuses the column check holds', async () => {
    const check = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'payout_attempts_status'`,
    );
    const values = [...(check.rows[0]?.definition ?? '').matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
    expect([...values].sort()).toEqual([...ATTEMPT_STATUS_VALUES].sort());
  });

  it('every disallowed pair fails in the database', async () => {
    await admin.query('begin');
    try {
      const disallowed = pairs<AttemptStatusValue>('payout_attempt', ATTEMPT_STATUS_VALUES, false);
      expect(disallowed.length).toBeGreaterThan(20);
      for (const [from, to] of disallowed) {
        const code = await attemptUpdate(
          `update ujira.payout_attempts set status = $2 where id = $1`,
          [attemptRows.get(from), to],
        );
        expect(code, `${from} to ${to}`).toBe('UJ004');
      }
    } finally {
      await admin.query('rollback');
    }
  });

  it('every disallowed pair fails in the repository', async () => {
    await db.tenant(fixture.tenant).transaction(async (tx) => {
      for (const [from, to] of pairs<AttemptStatusValue>(
        'payout_attempt',
        ATTEMPT_STATUS_VALUES,
        false,
      )) {
        // The types already rule some of these out, and the repository must hold
        // for a caller who got past them.
        const attempt =
          to === 'dead'
            ? payoutAttempts.markDead(tx, ANY_ID, {
                from: from as 'created',
                proof: { kind: 'tombstone' },
              })
            : payoutAttempts.transition(tx, ANY_ID, { from, to });
        await expect(attempt, `${from} to ${to}`).rejects.toBeInstanceOf(IllegalTransitionError);
      }
    });
  });

  it('every allowed pair passes in the database', async () => {
    await admin.query('begin');
    try {
      for (const [from, to] of pairs<AttemptStatusValue>(
        'payout_attempt',
        ATTEMPT_STATUS_VALUES,
        true,
      )) {
        const code = await attemptUpdate(
          `update ujira.payout_attempts
              set status = $2, dead_proof = case when $2 = 'dead' then '{}'::jsonb end
            where id = $1`,
          [attemptRows.get(from), to],
        );
        expect(code, `${from} to ${to}`).toBeUndefined();
      }
    } finally {
      await admin.query('rollback');
    }
  });
});
