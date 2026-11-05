// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { moneyAt } from '@ujira/core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { audit } from './repositories/audit.js';
import { payouts, RequestedAmountModeError } from './repositories/payouts.js';
import { projects } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';
import {
  newPayout,
  ONE_USDC,
  payoutFixture,
  usdc,
  type PayoutFixture,
} from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

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

async function useBearer(bearer: 'recipient' | 'principal'): Promise<void> {
  await db
    .tenant(fixture.tenant)
    .transaction(async (tx) =>
      projects.setCashoutBearer(tx, bearer, { kind: 'member', id: fixture.memberId }),
    );
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

describe('what a payout records', () => {
  it('a payout keeps the cash-out bearer in force at creation after the project setting changes', async () => {
    const session = db.tenant(fixture.tenant);
    const first = await session.transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    expect(first.payout.cashoutCostBearer).toBe('recipient');

    await useBearer('principal');

    const kept = await session.transaction(async (tx) => payouts.get(tx, first.payout.id));
    expect(kept?.cashoutCostBearer).toBe('recipient');
    const logged = await db
      .principal(fixture.tenant, 'app')
      .transaction(async (tx) => audit.list(tx, { limit: 10 }));
    expect(logged.items).toHaveLength(1);
    expect(logged.items[0]).toMatchObject({
      action: 'project.cashout_bearer_changed',
      actorKind: 'member',
      actorId: fixture.memberId,
      metadata: { setting: 'cashout_cost_bearer', old_value: 'recipient', new_value: 'principal' },
    });
  });

  it('setting the bearer it already has writes no audit row', async () => {
    await useBearer('recipient');
    const logged = await db
      .principal(fixture.tenant, 'app')
      .transaction(async (tx) => audit.list(tx, { limit: 10 }));
    expect(logged.items).toEqual([]);
  });

  it('recipient mode records a USDC amount', async () => {
    const { payout } = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payouts.create(tx, newPayout(fixture, { requested: usdc(5n * ONE_USDC) })),
      );
    expect(payout.requested).toEqual(usdc(5n * ONE_USDC));
    expect(payout.total).toBeNull();
    expect(payout).toMatchObject({
      status: 'received',
      publicStatus: 'queued',
      statusReason: null,
    });
  });

  it('principal mode records the local amount the recipient must receive', async () => {
    await useBearer('principal');
    const requested = moneyAt(5_000_000n, 'NGN', 2);
    const { payout } = await db.tenant(fixture.tenant).transaction(async (tx) =>
      payouts.create(
        tx,
        newPayout(fixture, {
          method: 'bank',
          requested,
          minimum: { toUsd: () => ({ amount: 3000n, currency: 'USD', scale: 2 }) },
        }),
      ),
    );
    expect(payout.requested).toEqual(requested);
    expect(payout.cashoutCostBearer).toBe('principal');
  });

  it('an amount in the form the other mode asks for is refused', async () => {
    const session = db.tenant(fixture.tenant);
    await expect(
      session.transaction(async (tx) =>
        payouts.create(tx, newPayout(fixture, { requested: moneyAt(1000n, 'USD', 2) })),
      ),
    ).rejects.toBeInstanceOf(RequestedAmountModeError);
    await useBearer('principal');
    await expect(
      session.transaction(async (tx) => payouts.create(tx, newPayout(fixture))),
    ).rejects.toBeInstanceOf(RequestedAmountModeError);
  });

  it('refuses in the database a requested unit that does not fit its mode', async () => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const { tenant, recipientId, mandateId } = fixture;
      const insert = async (bearer: string, currency: string | null, asset: string | null) =>
        admin.query(
          `insert into ujira.payouts
             (principal_id, project_id, idempotency_key, request_hash, recipient_id, mandate_id,
              method, cashout_cost_bearer, requested_amount, requested_asset, requested_chain,
              requested_token_scale, requested_currency, requested_currency_scale)
           values ($1, $2, gen_random_uuid()::text, $3, $4, $5, 'stellar_wallet', $6, 1, $7,
                   case when $7::text is null then null else 'stellar' end,
                   case when $7::text is null then null else 7 end,
                   $8, case when $8::text is null then null else 2 end)`,
          [
            tenant.principalId,
            tenant.projectId,
            Buffer.alloc(32),
            recipientId,
            mandateId,
            bearer,
            asset,
            currency,
          ],
        );
      expect(await codeOf(insert('recipient', 'USD', null))).toBe('23514');
      expect(await codeOf(insert('principal', null, 'USDC'))).toBe('23514');
      expect(await codeOf(insert('recipient', null, 'USDm'))).toBe('23503');
    } finally {
      await admin.end();
    }
  });

  it('refuses a zero amount, and a status reason that does not fit the status', async () => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const { payout } = await db
        .tenant(fixture.tenant)
        .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
      const set = async (assignment: string) =>
        admin.query(`update ujira.payouts set ${assignment} where id = $1`, [payout.id]);
      expect(await codeOf(set(`requested_amount = 0`))).toBe('23514');
      expect(await codeOf(set(`status_reason = 'funding_hold_expired'`))).toBe('23514');
      expect(await codeOf(set(`status_reason = 'nonsense'`))).toBe('23514');
      expect(await codeOf(set(`total_amount = 5`))).toBe('23514');
      await set(`status_reason = 'network_unavailable'`);
      expect(await codeOf(set(`status = 'routed', status_reason = 'network_unavailable'`))).toBe(
        '23514',
      );
    } finally {
      await admin.end();
    }
  });

  it('what a payout asked for cannot be changed by the app', async () => {
    const { payout } = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    const app = new pg.Client({ connectionString: roleUrl(roleUrls, 'ujira_app', database.name) });
    await app.connect();
    try {
      await app.query('begin');
      await app.query(
        `select set_config('ujira.principal_id', $1, true),
                set_config('ujira.project_id', $2, true),
                set_config('ujira.scope', 'project', true),
                set_config('ujira.txid', txid_current()::text, true)`,
        [fixture.tenant.principalId, fixture.tenant.projectId],
      );
      expect(
        await codeOf(
          app.query('update ujira.payouts set requested_amount = 1 where id = $1', [payout.id]),
        ),
      ).toBe('42501');
      await app.query('rollback');
    } finally {
      await app.end();
    }
  });

  it('a payout is never deleted or truncated, even by the owner', async () => {
    const { payout } = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      for (const statement of [
        `delete from ujira.payouts where id = '${payout.id}'`,
        'truncate ujira.payouts cascade',
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

  it('lists in pages', async () => {
    const session = db.tenant(fixture.tenant);
    for (let index = 0; index < 3; index += 1) {
      await session.transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
    }
    const first = await session.transaction(async (tx) => payouts.list(tx, { limit: 2 }));
    expect(first.items).toHaveLength(2);
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) => payouts.list(tx, { limit: 2, after }));
    expect(rest.items).toHaveLength(1);
    expect(rest.next).toBeNull();
  });
});
