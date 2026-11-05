// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The contract adds total plus fee to spent when a payout executes. The books keep the
// two apart, so after any mix of events the identity paid_out + fee = spent must hold,
// and presenting the same events again must change nothing.

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { ledger, type LedgerEntryInput } from './repositories/ledger.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  asIndexer,
  ledgerFixture,
  recordEvent,
  type LedgerFixture,
} from './testing/ledger-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

type Step =
  | { readonly kind: 'deposit'; readonly amount: bigint }
  | { readonly kind: 'request'; readonly total: bigint; readonly fee: bigint }
  | { readonly kind: 'approve' }
  | { readonly kind: 'execute' }
  | { readonly kind: 'cancel' };

interface Charge {
  readonly total: bigint;
  readonly fee: bigint;
}

// What the contract would hold after the same steps, and the journals they make. A step
// the state cannot support is skipped, as the contract would refuse it.
class Model {
  balance = 0n;
  paidOut = 0n;
  fee = 0n;
  private readonly pending: Charge[] = [];
  private readonly committed: Charge[] = [];

  get pendingTotal(): bigint {
    return this.pending.reduce((sum, item) => sum + item.total + item.fee, 0n);
  }

  get committedTotal(): bigint {
    return this.committed.reduce((sum, item) => sum + item.total + item.fee, 0n);
  }

  apply(step: Step): readonly LedgerEntryInput[] | undefined {
    switch (step.kind) {
      case 'deposit':
        this.balance += step.amount;
        return [
          { kind: 'external', amount: -step.amount },
          { kind: 'balance', amount: step.amount },
        ];
      case 'request': {
        const charged = step.total + step.fee;
        if (charged > this.balance) return undefined;
        this.balance -= charged;
        this.pending.push({ total: step.total, fee: step.fee });
        return [
          { kind: 'balance', amount: -charged },
          { kind: 'pending', amount: charged },
        ];
      }
      case 'approve': {
        const item = this.pending.shift();
        if (item === undefined) return undefined;
        this.committed.push(item);
        const charged = item.total + item.fee;
        return [
          { kind: 'pending', amount: -charged },
          { kind: 'committed', amount: charged },
        ];
      }
      case 'execute': {
        const item = this.committed.shift();
        if (item === undefined) return undefined;
        this.paidOut += item.total;
        this.fee += item.fee;
        return [
          { kind: 'committed', amount: -(item.total + item.fee) },
          { kind: 'spent', amount: item.total },
          ...(item.fee === 0n ? [] : [{ kind: 'fee' as const, amount: item.fee }]),
        ];
      }
      case 'cancel': {
        const item = this.pending.shift();
        if (item === undefined) return undefined;
        const charged = item.total + item.fee;
        this.balance += charged;
        return [
          { kind: 'pending', amount: -charged },
          { kind: 'balance', amount: charged },
        ];
      }
    }
  }
}

const amounts = fc.bigInt({ min: 1n, max: 1_000_000_000n });

const steps: fc.Arbitrary<Step> = fc.oneof(
  amounts.map((amount): Step => ({ kind: 'deposit', amount: amount * 2n })),
  fc
    .tuple(amounts, fc.bigInt({ min: 0n, max: 10_000_000n }))
    .map(([total, fee]): Step => ({ kind: 'request', total, fee })),
  fc.constant<Step>({ kind: 'approve' }),
  fc.constant<Step>({ kind: 'execute' }),
  fc.constant<Step>({ kind: 'cancel' }),
);

let database: TestDatabase;
let db: Database;

async function reconcile(fixture: LedgerFixture) {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) => ledger.reconciliation(tx, fixture.instanceId));
}

async function replay(stream: readonly Step[]) {
  const fixture = await ledgerFixture(db);
  const model = new Model();
  const posted: { chainEventId: string; entries: readonly LedgerEntryInput[] }[] = [];
  let at = 1n;
  for (const step of stream) {
    const entries = model.apply(step);
    if (entries === undefined) continue;
    const ledgerNumber = at;
    at += 1n;
    posted.push(
      await asIndexer(db, fixture.tenant, async (tx) => {
        const chainEventId = await recordEvent(tx, fixture.instanceId, ledgerNumber);
        await ledger.post(tx, { mandateInstanceId: fixture.instanceId, chainEventId, entries });
        return { chainEventId, entries };
      }),
    );
  }
  return { fixture, model, posted, at };
}

async function recordState(
  fixture: LedgerFixture,
  model: Model,
  at: bigint,
  spent: bigint,
): Promise<void> {
  await asIndexer(db, fixture.tenant, async (tx) =>
    ledger.recordState(tx, {
      mandateInstanceId: fixture.instanceId,
      ledger: at,
      balance: model.balance,
      pending: model.pendingTotal,
      committed: model.committedTotal,
      spent,
    }),
  );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('replaying a mixed stream of events', () => {
  it('paid_out + fee = spent after replay', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(steps, { minLength: 1, maxLength: 24 }), async (stream) => {
        const { fixture, model, posted, at } = await replay(stream);

        await recordState(fixture, model, at, model.paidOut + model.fee);
        const first = await reconcile(fixture);
        // Nothing was posted when every step was refused, and the books are all zero.
        expect(first?.matches).toBe(true);
        expect(first?.books.spent).toBe(model.paidOut);
        expect(first?.books.fee).toBe(model.fee);
        expect(first?.state.spent).toBe((first?.books.spent ?? 0n) + (first?.books.fee ?? 0n));

        // A restarted indexer presents the same events again.
        for (const event of posted) {
          const again = await asIndexer(db, fixture.tenant, async (tx) =>
            ledger.post(tx, {
              mandateInstanceId: fixture.instanceId,
              chainEventId: event.chainEventId,
              entries: event.entries,
            }),
          );
          expect(again.created).toBe(false);
        }
        expect((await reconcile(fixture))?.books).toEqual(first?.books);
      }),
      { numRuns: 12 },
    );
  }, 600_000);

  it('a contract figure that leaves out the fee is a disagreement', async () => {
    const { fixture, model, at } = await replay([
      { kind: 'deposit', amount: 1_000n },
      { kind: 'request', total: 500n, fee: 5n },
      { kind: 'approve' },
      { kind: 'execute' },
    ]);
    expect(model.fee).toBe(5n);
    await recordState(fixture, model, at, model.paidOut);
    expect((await reconcile(fixture))?.matches).toBe(false);
  });

  it('a payout with no fee opens no fee account, and still reconciles', async () => {
    const { fixture, model, at } = await replay([
      { kind: 'deposit', amount: 1_000n },
      { kind: 'request', total: 500n, fee: 0n },
      { kind: 'approve' },
      { kind: 'execute' },
    ]);
    await recordState(fixture, model, at, 500n);
    const result = await reconcile(fixture);
    expect(result?.matches).toBe(true);
    expect(result?.books.fee).toBe(0n);
  });
});
