// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { audit } from './repositories/audit.js';
import { mandateInstances, mandates } from './repositories/mandates.js';
import { fundingHolds, payouts } from './repositories/payouts.js';
import { projects } from './repositories/tenancy.js';
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

async function createPayout(): Promise<string> {
  const { payout } = await db
    .tenant(fixture.tenant)
    .transaction(async (tx) => payouts.create(tx, newPayout(fixture)));
  return payout.id;
}

async function hold(payoutId: string): Promise<boolean> {
  return db.tenant(fixture.tenant).transaction(async (tx) =>
    fundingHolds.hold(tx, payoutId, [
      {
        mandateInstanceId: fixture.instanceId,
        network: 'stellar:testnet',
        needed: usdc(5n * ONE_USDC),
      },
    ]),
  );
}

async function holdRows(payoutId: string): Promise<number> {
  const admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  try {
    const rows = await admin.query<{ count: string }>(
      `select count(*)::text as count from ujira.payout_funding_holds where payout_id = $1`,
      [payoutId],
    );
    return Number(rows.rows[0]?.count);
  } finally {
    await admin.end();
  }
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

describe('funding holds', () => {
  it('hold rows exist only for received and awaiting_funding payouts', async () => {
    const session = db.tenant(fixture.tenant);
    const held = await createPayout();
    expect(await hold(held)).toBe(true);
    const payout = await session.transaction(async (tx) => payouts.get(tx, held));
    expect(payout).toMatchObject({
      status: 'received',
      publicStatus: 'queued',
      statusReason: 'awaiting_funding',
    });
    expect(await session.transaction(async (tx) => fundingHolds.inconsistentPayoutIds(tx))).toEqual(
      [],
    );

    // Moved on without letting its holds go: refused at commit.
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          payouts.transition(tx, held, { from: 'received', to: 'routed' }),
        ),
      ),
    ).toBe('UJ013');
    expect(await holdRows(held)).toBe(1);

    // A hold on a payout that is not held: refused at commit.
    const notHeld = await createPayout();
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          tx
            .insertInto('ujira.payout_funding_holds')
            .values({
              principal_id: fixture.tenant.principalId,
              project_id: fixture.tenant.projectId,
              payout_id: notHeld,
              network: 'stellar:testnet',
              chain: 'stellar',
              mandate_instance_id: fixture.instanceId,
              needed_amount: '1',
              asset: 'USDC',
              scale: 7,
            })
            .execute(),
        ),
      ),
    ).toBe('UJ013');
    expect(await holdRows(notHeld)).toBe(0);
  });

  it('the consistency query finds a hold that got around the triggers', async () => {
    const held = await createPayout();
    await hold(held);
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `update ujira.payouts set status = 'routed', status_reason = null where id = $1`,
        [held],
      );
    } finally {
      await admin.end();
    }
    const found = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => fundingHolds.inconsistentPayoutIds(tx));
    expect(found).toEqual([held]);
  });

  it('a release moves the payout and deletes every hold in one transaction', async () => {
    const held = await createPayout();
    await hold(held);
    const session = db.tenant(fixture.tenant);
    const moved = await session.transaction(async (tx) => {
      const payout = await payouts.transition(tx, held, { from: 'received', to: 'routed' });
      expect(await fundingHolds.release(tx, held)).toBe(1);
      return payout;
    });
    expect(moved?.status).toBe('routed');
    expect(moved?.statusReason).toBeNull();
    expect(await holdRows(held)).toBe(0);
  });

  it('a second releaser matches nothing', async () => {
    const held = await createPayout();
    await hold(held);
    const release = async () =>
      db.tenant(fixture.tenant).transaction(async (tx) => {
        const payout = await payouts.transition(tx, held, { from: 'received', to: 'routed' });
        await fundingHolds.release(tx, held);
        return payout;
      });
    const results = await Promise.all([release(), release()]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it('an expired hold fails the payout with its reason', async () => {
    const held = await createPayout();
    await hold(held);
    const failed = await db.tenant(fixture.tenant).transaction(async (tx) => {
      await fundingHolds.release(tx, held);
      return payouts.transition(tx, held, {
        from: 'received',
        to: 'failed',
        statusReason: 'funding_hold_expired',
      });
    });
    expect(failed).toMatchObject({ status: 'failed', statusReason: 'funding_hold_expired' });
  });

  it('holds one row per candidate network, and a second on one network is refused', async () => {
    const held = await createPayout();
    expect(
      await codeOf(
        db.tenant(fixture.tenant).transaction(async (tx) =>
          fundingHolds.hold(tx, held, [
            {
              mandateInstanceId: fixture.instanceId,
              network: 'stellar:testnet',
              needed: usdc(ONE_USDC),
            },
            {
              mandateInstanceId: fixture.instanceId,
              network: 'stellar:testnet',
              needed: usdc(ONE_USDC),
            },
          ]),
        ),
      ),
    ).toBe('23505');
  });

  it('holding a payout already held, or one that has moved on, does nothing', async () => {
    const held = await createPayout();
    expect(await hold(held)).toBe(true);
    expect(await hold(held)).toBe(false);
    const routed = await createPayout();
    await db
      .tenant(fixture.tenant)
      .transaction(async (tx) =>
        payouts.transition(tx, routed, { from: 'received', to: 'routed' }),
      );
    expect(await hold(routed)).toBe(false);
  });

  it('a payout waiting on a network can move to waiting on funds', async () => {
    const waiting = await createPayout();
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query(
        `update ujira.payouts set status_reason = 'network_unavailable' where id = $1`,
        [waiting],
      );
    } finally {
      await admin.end();
    }
    expect(await hold(waiting)).toBe(true);
  });

  it('refuses a hold with no candidate, since no deposit could release it', async () => {
    const held = await createPayout();
    await expect(
      db.tenant(fixture.tenant).transaction(async (tx) => fundingHolds.hold(tx, held, [])),
    ).rejects.toThrow('at least one candidate');
  });

  it('refuses a hold on an instance of another mandate', async () => {
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
    const held = await createPayout();
    expect(
      await codeOf(
        db.tenant(fixture.tenant).transaction(async (tx) =>
          fundingHolds.hold(tx, held, [
            {
              mandateInstanceId: instance.id,
              network: 'stellar:testnet',
              needed: usdc(ONE_USDC),
            },
          ]),
        ),
      ),
    ).toBe('UJ014');
  });

  it('lists oldest first on a network', async () => {
    const first = await createPayout();
    await hold(first);
    const second = await createPayout();
    await hold(second);
    const session = db.tenant(fixture.tenant);
    const listed = await session.transaction(async (tx) =>
      fundingHolds.oldestOnNetwork(tx, 'stellar:testnet', 10),
    );
    expect(listed.map((row) => row.payoutId)).toEqual([first, second]);
    expect(listed[0]?.needed).toEqual(usdc(5n * ONE_USDC));
    expect(
      await session.transaction(async (tx) => fundingHolds.oldestOnNetwork(tx, 'other', 10)),
    ).toEqual([]);
  });
});

describe('routing settings', () => {
  const actor = (): { kind: 'member'; id: string } => ({ kind: 'member', id: fixture.memberId });

  async function auditActions(): Promise<readonly unknown[]> {
    const page = await db
      .principal(fixture.tenant, 'app')
      .transaction(async (tx) => audit.list(tx, { limit: 10 }));
    return page.items.map((item) => [item.action, item.metadata]);
  }

  it('starts at the defaults', async () => {
    const settings = await db
      .tenant(fixture.tenant)
      .transaction(async (tx) => projects.settings(tx));
    expect(settings).toEqual({
      cashoutCostBearer: 'recipient',
      chainFallback: 'off',
      fundingHoldMaxSeconds: 1_209_600,
    });
  });

  it('changing either setting writes the audit action, once for each change', async () => {
    const session = db.tenant(fixture.tenant);
    await session.transaction(async (tx) =>
      projects.setRoutingSettings(tx, { chainFallback: 'verified_methods' }, actor()),
    );
    await session.transaction(async (tx) =>
      projects.setRoutingSettings(tx, { fundingHoldMaxSeconds: 7200 }, actor()),
    );
    await session.transaction(async (tx) =>
      projects.setRoutingSettings(
        tx,
        { chainFallback: 'verified_methods', fundingHoldMaxSeconds: 7200 },
        actor(),
      ),
    );
    expect(await auditActions()).toEqual([
      [
        'project.routing_settings_changed',
        { setting: 'chain_fallback', old_value: 'off', new_value: 'verified_methods' },
      ],
      [
        'project.routing_settings_changed',
        { setting: 'funding_hold_max_seconds', old_value: '1209600', new_value: '7200' },
      ],
    ]);
    const settings = await session.transaction(async (tx) => projects.settings(tx));
    expect(settings).toMatchObject({
      chainFallback: 'verified_methods',
      fundingHoldMaxSeconds: 7200,
    });
  });

  it('a refused value changes nothing and logs nothing', async () => {
    expect(
      await codeOf(
        db
          .tenant(fixture.tenant)
          .transaction(async (tx) =>
            projects.setRoutingSettings(tx, { fundingHoldMaxSeconds: 60 }, actor()),
          ),
      ),
    ).toBe('23514');
    expect(await auditActions()).toEqual([]);
  });
});
