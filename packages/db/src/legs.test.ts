// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { LEG_STATUSES } from '@ujira/api-schema';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { approvals, LEG_STATUS_VALUES, payoutLegs } from './repositories/payout-legs.js';
import {
  AttemptWithoutLegsError,
  IdempotencyConflictError,
  IllegalTransitionError,
  payoutAttempts,
  payouts,
} from './repositories/payouts.js';
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

const TOTAL = 5n * ONE_USDC;

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

async function createWith(amounts: readonly bigint[], total = TOTAL) {
  return db.tenant(fixture.tenant).transaction(async (tx) =>
    payoutAttempts.create(
      tx,
      newAttempt(fixture, payoutId, {
        total: usdc(total),
        legs: amounts.map((amount, index) => newLeg(fixture, amount, index)),
      }),
    ),
  );
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

describe('legs sum to their attempt', () => {
  it('legs summing to total minus one raise UJ005 at commit', async () => {
    let wroteBeforeCommit = false;
    const attempt = db.tenant(fixture.tenant).transaction(async (tx) => {
      await payoutAttempts.create(
        tx,
        newAttempt(fixture, payoutId, {
          total: usdc(TOTAL),
          legs: [newLeg(fixture, TOTAL - 1n)],
        }),
      );
      wroteBeforeCommit = true;
    });
    expect(await codeOf(attempt)).toBe('UJ005');
    expect(wroteBeforeCommit).toBe(true);
    const left = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutAttempts.forPayout(tx, payoutId));
    expect(left).toEqual([]);
  });

  it('legs summing to total plus one are refused too', async () => {
    expect(await codeOf(createWith([TOTAL + 1n]))).toBe('UJ005');
  });

  it('the repository refuses an attempt with no legs', async () => {
    await expect(createWith([])).rejects.toBeInstanceOf(AttemptWithoutLegsError);
    const left = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutAttempts.forPayout(tx, payoutId));
    expect(left).toEqual([]);
  });

  it('a total changed without its legs is refused at commit', async () => {
    const attempt = await createWith([TOTAL]);
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local role ujira_owner');
      await admin.query(
        `update ujira.payout_attempts set total_amount = total_amount + 1 where id = $1`,
        [attempt.id],
      );
      expect(await codeOf(admin.query('commit'))).toBe('UJ005');
    } finally {
      await admin.end();
    }
  });

  it('accepts one leg, and a split that sums exactly', async () => {
    const attempt = await createWith([1n, 2n, TOTAL - 4n, 1n]);
    const legs = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutLegs.forAttempt(tx, attempt.id));
    expect(legs.map((leg) => leg.index)).toEqual([0, 1, 2, 3]);
    expect(legs.reduce((sum, leg) => sum + leg.amount.amount, 0n)).toBe(TOTAL);
    expect(legs[0]?.fee).toEqual(usdc(0n));
    expect(legs[0]?.status).toBe('planned');
  });

  it('refuses a fifth leg', async () => {
    const amounts = [1n, 1n, 1n, 1n, TOTAL - 4n];
    const attempt = db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutAttempts.create(
        tx,
        newAttempt(fixture, payoutId, {
          total: usdc(TOTAL),
          legs: amounts.map((amount, index) => newLeg(fixture, amount, index)),
        }),
      ),
    );
    expect(await codeOf(attempt)).toBe('23514');
  });

  it('holds exactly at the largest amount the domain allows', async () => {
    const big = 2n ** 126n;
    const attempt = await db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutAttempts.create(
        tx,
        newAttempt(fixture, payoutId, {
          total: usdc(big + 1n),
          legs: [newLeg(fixture, big, 0), newLeg(fixture, 1n, 1)],
        }),
      ),
    );
    expect(attempt.total.amount).toBe(big + 1n);
  });

  it('a change that breaks the sum is refused at commit, even by the owner', async () => {
    const attempt = await createWith([TOTAL - 1n, 1n]);
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local role ujira_owner');
      await admin.query(
        `update ujira.payout_legs set amount = amount + 1 where attempt_id = $1 and leg_index = 0`,
        [attempt.id],
      );
      expect(await codeOf(admin.query('commit'))).toBe('UJ005');
    } finally {
      await admin.end();
    }
  });
});

describe('what a leg records', () => {
  it('derives its key from the payout and the index, whatever a caller passes', async () => {
    const attempt = await createWith([TOTAL]);
    const [leg] = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutLegs.forAttempt(tx, attempt.id));
    expect(leg?.legKey).toBe(
      createHash('sha256').update(`ujira/leg/v1|${payoutId}|0`).digest('hex'),
    );
  });

  it('keeps one key across attempts, so a retried leg is the same leg', async () => {
    const first = await createWith([TOTAL]);
    await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutAttempts.markDead(tx, first.id, { from: 'created', proof: { kind: 'tombstone' } }),
      );
    const second = await createWith([TOTAL]);
    const keys = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => [
        await payoutLegs.forAttempt(tx, first.id),
        await payoutLegs.forAttempt(tx, second.id),
      ]);
    expect(keys[0]?.[0]?.legKey).toBe(keys[1]?.[0]?.legKey);
  });

  it('refuses a method that belongs to another recipient', async () => {
    const methodId = await db.tenant(fixture.tenant).transaction(async (tx) => {
      const other = await recipients.create(tx, { recipientRef: randomBytes(32), country: 'KE' });
      const method = await payoutMethods.create(tx, {
        recipientId: other.id,
        method: 'stellar_wallet',
        rail: 'wallet',
        chain: 'stellar',
        destinationAddress: `G${randomUUID()}`,
        destinationTag: null,
        details: null,
      });
      return method.id;
    });
    const attempt = db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutAttempts.create(
        tx,
        newAttempt(fixture, payoutId, {
          total: usdc(TOTAL),
          legs: [{ ...newLeg(fixture, TOTAL), payoutMethodId: methodId }],
        }),
      ),
    );
    expect(await codeOf(attempt)).toBe('UJ015');
  });

  it('refuses a leg whose kind is not its method kind', async () => {
    const attempt = db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutAttempts.create(
        tx,
        newAttempt(fixture, payoutId, {
          total: usdc(TOTAL),
          legs: [{ ...newLeg(fixture, TOTAL), method: 'bank' }],
        }),
      ),
    );
    expect(await codeOf(attempt)).toBe('UJ015');
  });

  it('refuses a leg in a unit its attempt is not in', async () => {
    const attempt = await createWith([TOTAL]);
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      expect(
        await codeOf(
          admin.query(`update ujira.payout_legs set scale = 2 where attempt_id = $1`, [attempt.id]),
        ),
      ).toBe('23503');
    } finally {
      await admin.end();
    }
  });

  it('a leg is never deleted or truncated, even by the owner', async () => {
    const attempt = await createWith([TOTAL]);
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      for (const statement of [
        `delete from ujira.payout_legs where attempt_id = '${attempt.id}'`,
        'truncate ujira.payout_legs cascade',
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

describe('the leg machine', () => {
  it('uses exactly the statuses the API has', () => {
    expect([...LEG_STATUS_VALUES].sort()).toEqual([...LEG_STATUSES].sort());
  });

  it('every disallowed pair fails in the database and in the repository', async () => {
    const attempt = await createWith([TOTAL]);
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const rows = await admin.query<{ from_status: string; to_status: string }>(
        `select from_status, to_status from ujira.status_transitions where machine = 'payout_leg'`,
      );
      const allowed = new Set(rows.rows.map((row) => `${row.from_status}:${row.to_status}`));
      const legId = (
        await admin.query<{ id: string }>(
          `select id from ujira.payout_legs where attempt_id = $1`,
          [attempt.id],
        )
      ).rows[0]?.id;
      let checked = 0;
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      for (const from of LEG_STATUS_VALUES) {
        for (const to of LEG_STATUS_VALUES) {
          if (from === to || allowed.has(`${from}:${to}`)) continue;
          checked += 1;
          await admin.query('savepoint pair');
          await admin.query(`update ujira.payout_legs set status = $2 where id = $1`, [
            legId,
            from,
          ]);
          await admin.query('set local session_replication_role = default');
          expect(
            await codeOf(
              admin.query(`update ujira.payout_legs set status = $2 where id = $1`, [legId, to]),
            ),
            `${from} to ${to}`,
          ).toBe('UJ004');
          await admin.query('rollback to savepoint pair');
          await admin.query('set local session_replication_role = replica');
        }
      }
      await admin.query('rollback');
      expect(checked).toBeGreaterThan(20);
      await db.tenant(fixture.tenant).transaction(async (tx) => {
        for (const from of LEG_STATUS_VALUES) {
          for (const to of LEG_STATUS_VALUES) {
            if (from === to || allowed.has(`${from}:${to}`)) continue;
            await expect(
              payoutLegs.transition(tx, legId ?? '', { from, to }),
              `${from} to ${to}`,
            ).rejects.toBeInstanceOf(IllegalTransitionError);
          }
        }
      });
    } finally {
      await admin.end();
    }
  });

  it('moves by compare and set, and records the transaction hash', async () => {
    const attempt = await createWith([TOTAL]);
    const session = db.tenant(fixture.tenant);
    const [leg] = await session.transaction(async (tx) => payoutLegs.forAttempt(tx, attempt.id));
    const id = leg?.id ?? '';
    const moved = await session.transaction(async (tx) =>
      payoutLegs.transition(tx, id, { from: 'planned', to: 'submitted', chainTxHash: 'abc' }),
    );
    expect(moved).toMatchObject({ status: 'submitted', chainTxHash: 'abc' });
    expect(
      await session.transaction(async (tx) =>
        payoutLegs.transition(tx, id, { from: 'planned', to: 'submitted' }),
      ),
    ).toBeUndefined();
  });
});

describe('approvals', () => {
  function input(attemptId: string) {
    return {
      attemptId,
      approver: `G${randomUUID()}`,
      decision: 'approved' as const,
      signedMessageHash: randomBytes(32),
      signature: randomBytes(64),
    };
  }

  it('records one approver once, and finds the first on a retry', async () => {
    const attempt = await createWith([TOTAL]);
    const session = db.tenant(fixture.tenant);
    const approval = input(attempt.id);
    const first = await session.transaction(async (tx) => approvals.record(tx, approval));
    expect(first.created).toBe(true);
    const retry = await session.transaction(async (tx) => approvals.record(tx, approval));
    expect(retry).toEqual({ approval: first.approval, created: false });
    expect(await session.transaction(async (tx) => approvals.forAttempt(tx, attempt.id))).toEqual([
      first.approval,
    ]);
  });

  it('an approver cannot change their decision', async () => {
    const attempt = await createWith([TOTAL]);
    const session = db.tenant(fixture.tenant);
    const approval = input(attempt.id);
    await session.transaction(async (tx) => approvals.record(tx, approval));
    await expect(
      session.transaction(async (tx) =>
        approvals.record(tx, { ...approval, decision: 'rejected' }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('of parallel records by one approver, one writes', async () => {
    const attempt = await createWith([TOTAL]);
    const approval = input(attempt.id);
    const results = await Promise.all(
      Array.from({ length: 8 }, async () =>
        db.tenant(fixture.tenant).transaction(async (tx) => approvals.record(tx, approval)),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('holds several approvers on one attempt', async () => {
    const attempt = await createWith([TOTAL]);
    const session = db.tenant(fixture.tenant);
    await session.transaction(async (tx) => approvals.record(tx, input(attempt.id)));
    await session.transaction(async (tx) => approvals.record(tx, input(attempt.id)));
    const all = await session.transaction(async (tx) => approvals.forAttempt(tx, attempt.id));
    expect(all).toHaveLength(2);
  });
});
