// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Random payout lifecycles against the real database. Whatever order of moves a
// run tries, including ones that must be refused, the invariants hold after every
// step: the legs of each attempt sum to its total, at most one attempt is live, and
// a terminal state stays final.

import { TERMINAL_PAYOUT_STATUSES } from '@ujira/api-schema';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  ATTEMPT_STATUS_VALUES,
  IllegalTransitionError,
  LiveAttemptError,
  PAYOUT_STATUS_VALUES,
  payoutAttempts,
  payouts,
  type AttemptStatusValue,
  type PayoutStatusValue,
} from './repositories/payouts.js';
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

const TERMINAL_ATTEMPT: ReadonlySet<string> = new Set(['final', 'dead']);

type Step =
  | { readonly kind: 'attempt'; readonly split: readonly bigint[]; readonly skew: bigint }
  | { readonly kind: 'moveAttempt'; readonly to: Exclude<AttemptStatusValue, 'dead'> }
  | { readonly kind: 'kill' }
  | { readonly kind: 'movePayout'; readonly to: PayoutStatusValue };

const moveableAttemptStatuses = ATTEMPT_STATUS_VALUES.filter(
  (status): status is Exclude<AttemptStatusValue, 'dead'> => status !== 'dead',
);

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('attempt' as const),
    split: fc.array(fc.bigInt({ min: 1n, max: 3n * ONE_USDC }), { minLength: 1, maxLength: 4 }),
    // Mostly right, sometimes one unit out, which the commit must refuse.
    skew: fc.constantFrom(0n, 0n, 0n, 1n, -1n),
  }),
  fc.record({
    kind: fc.constant('moveAttempt' as const),
    to: fc.constantFrom(...moveableAttemptStatuses),
  }),
  fc.record({ kind: fc.constant('kill' as const) }),
  fc.record({
    kind: fc.constant('movePayout' as const),
    to: fc.constantFrom(...PAYOUT_STATUS_VALUES),
  }),
);

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let fixture: PayoutFixture;

interface Observed {
  readonly payoutStatus: string;
  readonly attempts: readonly { id: string; status: string; total: string; legs: string }[];
}

async function observe(payoutId: string): Promise<Observed> {
  const payout = await admin.query<{ status: string }>(
    'select status from ujira.payouts where id = $1',
    [payoutId],
  );
  const attempts = await admin.query<{ id: string; status: string; total: string; legs: string }>(
    `select a.id, a.status, a.total_amount::text as total,
            coalesce((select sum(l.amount) from ujira.payout_legs as l where l.attempt_id = a.id), 0)::text as legs
       from ujira.payout_attempts as a
      where a.payout_id = $1
      order by a.attempt_number`,
    [payoutId],
  );
  return { payoutStatus: payout.rows[0]?.status ?? '', attempts: attempts.rows };
}

function checkInvariants(before: Observed | undefined, now: Observed): void {
  for (const attempt of now.attempts) {
    expect(attempt.legs, 'the legs of an attempt sum to its total').toBe(attempt.total);
  }
  const live = now.attempts.filter((attempt) => attempt.status !== 'dead');
  expect(live.length, 'at most one attempt is not dead').toBeLessThanOrEqual(1);
  if (before === undefined) return;
  if (TERMINAL_PAYOUT_STATUSES.has(before.payoutStatus as never)) {
    expect(now.payoutStatus, 'a terminal payout stays as it is').toBe(before.payoutStatus);
  }
  for (const earlier of before.attempts) {
    const later = now.attempts.find((attempt) => attempt.id === earlier.id);
    expect(later, 'an attempt is never removed').toBeDefined();
    if (TERMINAL_ATTEMPT.has(earlier.status)) {
      expect(later?.status, 'a terminal attempt stays as it is').toBe(earlier.status);
    }
  }
}

// Refused moves are part of the exercise, and every refusal the database makes on
// purpose carries a UJ code. Naming them here would make this test fail against a
// later schema that adds a rule, though the invariants below still hold there.
// Anything else still fails the run.
const REFUSAL_PREFIX = 'UJ';

async function apply(payoutId: string, move: Step, now: Observed): Promise<void> {
  const session = db.tenant(fixture.tenant);
  const liveAttempt = now.attempts.find((attempt) => attempt.status !== 'dead');
  try {
    await session.transaction(async (tx) => {
      switch (move.kind) {
        case 'attempt': {
          const sum = move.split.reduce((total, amount) => total + amount, 0n);
          const total = sum + move.skew;
          if (total <= 0n) return;
          await payoutAttempts.create(
            tx,
            newAttempt(fixture, payoutId, {
              total: usdc(total),
              legs: move.split.map((amount, index) => newLeg(fixture, amount, index)),
            }),
          );
          return;
        }
        case 'moveAttempt':
          if (liveAttempt === undefined) return;
          await payoutAttempts.transition(tx, liveAttempt.id, {
            from: liveAttempt.status as AttemptStatusValue,
            to: move.to,
          });
          return;
        case 'kill':
          if (liveAttempt === undefined || liveAttempt.status === 'final') return;
          await payoutAttempts.markDead(tx, liveAttempt.id, {
            from: liveAttempt.status as 'created',
            proof: { kind: 'tombstone' },
          });
          return;
        case 'movePayout':
          await payouts.transition(tx, payoutId, {
            from: now.payoutStatus as PayoutStatusValue,
            to: move.to,
          });
          return;
      }
    });
  } catch (error) {
    if (error instanceof IllegalTransitionError || error instanceof LiveAttemptError) return;
    const code = (error as { code?: string }).code ?? '';
    if (!code.startsWith(REFUSAL_PREFIX)) throw error;
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 2);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  fixture = await payoutFixture(db);
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('payout lifecycles', () => {
  it('keep the invariants under random moves', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        const { payout } = await db
          .tenant(fixture.tenant)
          .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
        let before: Observed | undefined;
        let now = await observe(payout.id);
        for (const move of steps) {
          checkInvariants(before, now);
          await apply(payout.id, move, now);
          before = now;
          now = await observe(payout.id);
        }
        checkInvariants(before, now);
      }),
      { numRuns: 40 },
    );
  }, 300_000);

  it('reaches the interesting states, so the property is not passing on nothing', async () => {
    const seen = await admin.query<{ status: string }>(
      `select distinct status from ujira.payout_attempts`,
    );
    expect(seen.rows.length).toBeGreaterThan(1);
  });
});
