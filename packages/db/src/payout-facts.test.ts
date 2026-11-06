// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a payout read needs from the payout's own steps: the rule that blocked or
// allowed it, when it reached each step, and the caller's task id. The rules are
// given by whoever moves the payout; the times come from the database alone.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  IdempotencyConflictError,
  payouts,
  TransitionFactError,
  type Payout,
  type PayoutStatusValue,
} from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { codeOf } from './testing/evidence-world.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { newPayout, payoutFixture, type PayoutFixture } from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let fixture: PayoutFixture;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  fixture = await payoutFixture(db);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

async function created(): Promise<Payout> {
  const { payout } = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
  return payout;
}

// Each move in its own transaction, so each step has its own time.
async function move(
  id: string,
  step: Parameters<typeof payouts.transition>[2],
): Promise<Payout | undefined> {
  return db.tenant(fixture.tenant).transaction(async (tx) => payouts.transition(tx, id, step));
}

async function walk(id: string, statuses: readonly PayoutStatusValue[]): Promise<Payout> {
  let last: Payout | undefined;
  for (let i = 1; i < statuses.length; i += 1) {
    const from = statuses[i - 1];
    const to = statuses[i];
    if (from === undefined || to === undefined) throw new Error('a walk needs two statuses');
    last = await move(id, {
      from,
      to,
      ...(to === 'approved' || (to === 'settling' && from !== 'approved')
        ? { allowedBy: 'allowlist_auto' as const }
        : {}),
    });
  }
  if (last === undefined) throw new Error('the walk did not move the payout');
  return last;
}

describe('the rule that blocked a payout', () => {
  it('is needed on a move into blocked, and kept there', async () => {
    const { id } = await created();
    const refused = move(id, { from: 'received', to: 'blocked' });
    await expect(refused).rejects.toBeInstanceOf(TransitionFactError);
    const blocked = await move(id, {
      from: 'received',
      to: 'blocked',
      blockedBy: 'DAILY_CAP_EXCEEDED',
    });
    expect(blocked).toMatchObject({ status: 'blocked', blockedBy: 'DAILY_CAP_EXCEEDED' });
  });

  it('is refused on any other move', async () => {
    const { id } = await created();
    await expect(
      move(id, { from: 'received', to: 'routed', blockedBy: 'DAILY_CAP_EXCEEDED' }),
    ).rejects.toBeInstanceOf(TransitionFactError);
  });

  // Tying the rule to the blocked status waits for a contract migration, since the
  // code already deployed moves payouts without it. Its form is checked now.
  it('cannot be written around the repository as anything but a rule name', async () => {
    const { id } = await created();
    const code = await codeOf(
      db
        .tenant(fixture.tenant)
        .transaction(async (tx) =>
          tx
            .updateTable('ujira.payouts')
            .set({ blocked_by: 'over the daily cap' })
            .where('id', '=', id)
            .execute(),
        ),
    );
    expect(code).toBe('23514');
  });
});

describe('the rule that allowed a payout', () => {
  it('is needed on the way in, kept while it moves on, and cleared when it leaves', async () => {
    const { id } = await created();
    await walk(id, ['received', 'routed', 'submitting']);
    await expect(move(id, { from: 'submitting', to: 'approved' })).rejects.toBeInstanceOf(
      TransitionFactError,
    );
    const approved = await move(id, {
      from: 'submitting',
      to: 'approved',
      allowedBy: 'attestation_approved',
    });
    expect(approved?.allowedBy).toBe('attestation_approved');
    const settling = await move(id, { from: 'approved', to: 'settling' });
    expect(settling?.allowedBy).toBe('attestation_approved');
    const failed = await move(id, { from: 'settling', to: 'failed' });
    expect(failed?.allowedBy).toBeNull();
  });

  it('is refused on a move into a status that nothing allowed', async () => {
    const { id } = await created();
    await expect(
      move(id, { from: 'received', to: 'routed', allowedBy: 'allowlist_auto' }),
    ).rejects.toBeInstanceOf(TransitionFactError);
  });

  it('is forgotten when an approved payout is routed again', async () => {
    const { id } = await created();
    await walk(id, ['received', 'routed', 'submitting', 'approved']);
    const rerouted = await move(id, { from: 'approved', to: 'routed' });
    expect(rerouted).toMatchObject({ allowedBy: null, approvedAt: null });
  });
});

describe('the time of each step', () => {
  it('is set from the status, in the order the steps happened', async () => {
    const { id, createdAt } = await created();
    const routed = await walk(id, ['received', 'routed', 'submitting']);
    expect(routed).toMatchObject({ approvedAt: null, settledAt: null, deliveredAt: null });
    const paid = await walk(id, ['submitting', 'approved', 'settling', 'paid']);
    const { approvedAt, settledAt, deliveredAt } = paid;
    if (approvedAt === null || settledAt === null || deliveredAt === null) {
      throw new Error('a paid payout has every step time');
    }
    expect(approvedAt.getTime()).toBeGreaterThanOrEqual(createdAt.getTime());
    expect(settledAt.getTime()).toBeGreaterThanOrEqual(approvedAt.getTime());
    expect(deliveredAt.getTime()).toBeGreaterThanOrEqual(settledAt.getTime());
  });

  it('counts a payout settled without approval as allowed when it settled', async () => {
    const { id } = await created();
    const settling = await walk(id, ['received', 'routed', 'submitting', 'settling']);
    expect(settling.approvedAt).toEqual(settling.settledAt);
  });

  it('cannot be written by the app', async () => {
    const { id } = await created();
    const code = await codeOf(
      db
        .tenant(fixture.tenant)
        .transaction(async (tx) =>
          tx
            .updateTable('ujira.payouts')
            .set({ settled_at: new Date() })
            .where('id', '=', id)
            .execute(),
        ),
    );
    expect(code).toBe('42501');
  });
});

describe('the task id', () => {
  it('is kept with the payout', async () => {
    const taskId = `task-${randomUUID()}`;
    const { payout } = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture, { taskId })));
    expect(payout.taskId).toBe(taskId);
  });

  it('is part of the request, so a key reused with another task id is refused', async () => {
    const idempotencyKey = randomUUID();
    await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payouts.create(tx, newPayout(fixture, { idempotencyKey, taskId: 'first' })),
      );
    const again = db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payouts.create(tx, newPayout(fixture, { idempotencyKey, taskId: 'second' })),
      );
    await expect(again).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('leaves a request without one hashing as it always did', async () => {
    const idempotencyKey = randomUUID();
    const first = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture, { idempotencyKey })));
    const again = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payouts.create(tx, newPayout(fixture, { idempotencyKey, taskId: null })),
      );
    expect(again).toMatchObject({ created: false, payout: { id: first.payout.id, taskId: null } });
  });
});
