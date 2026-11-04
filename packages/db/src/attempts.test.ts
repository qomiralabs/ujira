// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import {
  LiveAttemptError,
  payoutAttempts,
  payouts,
  type NewPayoutAttempt,
} from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import {
  newPayout,
  ONE_USDC,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

// A proof as the adapter shapes it, ledger number and all.
const PROOF = {
  kind: 'deadline_passed',
  network: 'stellar:testnet',
  finalTime: 1_800_000_000,
  at: { ledgerOrBlock: 2n ** 60n, finality: 'final' },
};

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

function attempt(overrides: Partial<NewPayoutAttempt> = {}): NewPayoutAttempt {
  return {
    payoutId,
    mandateInstanceId: fixture.instanceId,
    network: 'stellar:testnet',
    total: usdc(5n * ONE_USDC),
    deadline: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

async function create(overrides: Partial<NewPayoutAttempt> = {}) {
  return db
    .tenant(fixture.tenant)
    .transaction(async (tx) => payoutAttempts.create(tx, attempt(overrides)));
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 6);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  const created = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
  payoutId = created.payout.id;
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('one live attempt', () => {
  it('two concurrent attempts produce one live attempt', async () => {
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect(refused?.status === 'rejected' ? refused.reason : undefined).toBeInstanceOf(
      LiveAttemptError,
    );
    const all = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payoutAttempts.forPayout(tx, payoutId));
    expect(all).toHaveLength(1);
  });

  it('holds under many racing creates', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, async () => create()));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses a second attempt while the first is live', async () => {
    await create();
    await expect(create()).rejects.toBeInstanceOf(LiveAttemptError);
  });

  it('a new attempt follows only a dead one, and is numbered after it', async () => {
    const first = await create();
    expect(first.attemptNumber).toBe(1);
    await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutAttempts.markDead(tx, first.id, { from: 'created', proof: PROOF }),
      );
    const second = await create();
    expect(second.attemptNumber).toBe(2);
    await expect(create()).rejects.toBeInstanceOf(LiveAttemptError);
  });

  it('a final attempt still counts: its payout is never tried again', async () => {
    const first = await create();
    await db.tenant(fixture.tenant).transaction(async (tx) => {
      await payoutAttempts.transition(tx, first.id, { from: 'created', to: 'requested' });
      await payoutAttempts.transition(tx, first.id, { from: 'requested', to: 'executing' });
      await payoutAttempts.transition(tx, first.id, { from: 'executing', to: 'final' });
    });
    await expect(create()).rejects.toBeInstanceOf(LiveAttemptError);
  });
});

describe('dead proof', () => {
  it('dying needs a proof, in the database', async () => {
    const first = await create();
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      expect(
        await codeOf(
          admin.query(`update ujira.payout_attempts set status = 'dead' where id = $1`, [first.id]),
        ),
      ).toBe('23514');
      expect(
        await codeOf(
          admin.query(`update ujira.payout_attempts set dead_proof = '{}' where id = $1`, [
            first.id,
          ]),
        ),
      ).toBe('23514');
      expect(
        await codeOf(
          admin.query(
            `update ujira.payout_attempts set status = 'dead', dead_proof = '[]' where id = $1`,
            [first.id],
          ),
        ),
      ).toBe('23514');
    } finally {
      await admin.end();
    }
  });

  it('keeps the proof, with its ledger number intact', async () => {
    const first = await create();
    const dead = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payoutAttempts.markDead(tx, first.id, { from: 'created', proof: PROOF }),
      );
    expect(dead?.status).toBe('dead');
    expect(dead?.deadProof).toEqual({
      ...PROOF,
      at: { ledgerOrBlock: (2n ** 60n).toString(), finality: 'final' },
    });
  });

  it('a final attempt can never be marked dead', async () => {
    const first = await create();
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(`update ujira.payout_attempts set status = 'final' where id = $1`, [
        first.id,
      ]);
      await admin.query('set session_replication_role = default');
      expect(
        await codeOf(
          admin.query(
            `update ujira.payout_attempts set status = 'dead', dead_proof = '{}' where id = $1`,
            [first.id],
          ),
        ),
      ).toBe('UJ004');
    } finally {
      await admin.end();
    }
  });
});

describe('compare and set', () => {
  it('of two racing moves one matches nothing', async () => {
    const first = await create();
    const results = await Promise.all(
      [0, 1].map(async () =>
        db
          .tenant(fixture.tenant)
          .transaction(async (tx) =>
            payoutAttempts.transition(tx, first.id, { from: 'created', to: 'requested' }),
          ),
      ),
    );
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it('records the on-chain id with a move, and refuses it twice on one instance', async () => {
    const first = await create();
    const chainId = randomUUID();
    const moved = await db.tenant(fixture.tenant).transaction(async (tx) =>
      payoutAttempts.transition(tx, first.id, {
        from: 'created',
        to: 'requested',
        onChainPayoutId: chainId,
      }),
    );
    expect(moved?.onChainPayoutId).toBe(chainId);
    const other = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    expect(await codeOf(create({ payoutId: other.payout.id, onChainPayoutId: chainId }))).toBe(
      '23505',
    );
  });
});

describe('what an attempt may point at', () => {
  it('refuses an instance of another mandate', async () => {
    const instance = await db.tenant(fixture.tenant).transaction(async (tx) => {
      const mandate = await mandates.create(tx, { name: 'Other' });
      return mandateInstances.create(tx, {
        network: 'stellar:testnet',
        mandateId: mandate.id,
        chain: 'stellar',
        contractAddress: `C${randomUUID()}`,
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
      });
    });
    expect(await codeOf(create({ mandateInstanceId: instance.id }))).toBe('UJ014');
  });

  it('keeps financial records: an attempt is never deleted or truncated', async () => {
    const first = await create();
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      for (const statement of [
        `delete from ujira.payout_attempts where id = '${first.id}'`,
        'truncate ujira.payout_attempts cascade',
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
