// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Financial records are never changed. Grants stop the service roles, and
// triggers stop the owner, who has every right on its own tables. Truncate is a
// statement level event, so it needs its own trigger, which is why it is tested
// separately from delete.

import { randomBytes, randomUUID } from 'node:crypto';

import { tokenAmount } from '@ujira/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { audit } from './repositories/audit.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { ledger } from './repositories/ledger.js';
import { chainEvents, deposits, mandateInstances, mandates } from './repositories/mandates.js';
import { approvals } from './repositories/payout-legs.js';
import { payoutAttempts, payouts } from './repositories/payouts.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { newAttempt, newPayout, payoutFixture } from './testing/payout-fixture.js';
import {
  createTestDatabase,
  roleUrl,
  type LoginRole,
  type TestDatabase,
} from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

// Every append only table with a row in it, and a change to try on each.
const CHANGES: Readonly<Record<string, string>> = {
  'ujira.approvals': `decision = 'rejected'`,
  'ujira.audit_log': `action = 'changed.action'`,
  'ujira.chain_events': `event_type = 'changed'`,
  'ujira.deposits': `from_address = 'changed'`,
  'ujira.ledger_journals': 'created_at = now()',
  'ujira.ledger_entries': 'created_at = now()',
  'ujira.mandate_state_snapshots': 'taken_at = now()',
};
const TABLES = Object.keys(CHANGES);

function mutations(table: string): readonly (readonly [string, string])[] {
  return [
    ['update', `update ${table} set ${CHANGES[table] ?? ''}`],
    ['delete', `delete from ${table}`],
    ['truncate', `truncate ${table} cascade`],
  ];
}

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function as<T>(role: LoginRole, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(roleUrls, role, database.name) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function count(table: string): Promise<string | undefined> {
  const admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  try {
    const result = await admin.query<{ count: string }>(
      `select count(*)::text as count from ${table}`,
    );
    return result.rows[0]?.count;
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  const instance = await db.tenant(tenant).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: 'Payroll' });
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
  await db.withTenant('indexer', { ...tenant, scope: 'project' }, async (tx) => {
    const { id } = await chainEvents.record(tx, {
      mandateInstanceId: instance.id,
      chain: 'stellar',
      txHash: randomBytes(32),
      eventIndex: 0n,
      ledger: 1n,
      eventType: 'deposit',
      payload: {},
      finalizedAt: new Date(),
    });
    await deposits.record(tx, {
      mandateInstanceId: instance.id,
      fundingSourceId: null,
      chainEventId: id ?? '',
      amount: tokenAmount(1n, 'USDC', 'stellar'),
      fromAddress: 'GFROM',
    });
    await ledger.post(tx, {
      mandateInstanceId: instance.id,
      chainEventId: id ?? '',
      entries: [
        { kind: 'external', amount: -1n },
        { kind: 'balance', amount: 1n },
      ],
    });
    await ledger.recordState(tx, {
      mandateInstanceId: instance.id,
      ledger: 1n,
      balance: 1n,
      pending: 0n,
      committed: 0n,
      spent: 0n,
    });
  });
  await db
    .tenant(tenant)
    .transaction(async (tx) =>
      audit.record(tx, { action: 'project.created', actor: { kind: 'system' } }),
    );
  const fixture = await payoutFixture(db);
  await db.tenant(fixture.tenant).transaction(async (tx) => {
    const { payout } = await payouts.create(tx, newPayout(fixture));
    const attempt = await payoutAttempts.create(tx, newAttempt(fixture, payout.id));
    await approvals.record(tx, {
      attemptId: attempt.id,
      approver: 'GAPPROVER',
      decision: 'approved',
      signedMessageHash: randomBytes(32),
      signature: randomBytes(64),
    });
  });
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('append only tables', () => {
  it('update, delete and truncate on chain_events fail as app and owner', async () => {
    for (const [name, statement] of mutations('ujira.chain_events')) {
      await as('ujira_app', async (client) => {
        // Under a context, so it is the missing grant that refuses. Without one
        // the planner evaluates the policy first and the answer is UJ001.
        await client.query('begin');
        await client.query(
          `select set_config('ujira.principal_id', $1, true),
                  set_config('ujira.project_id', $2, true),
                  set_config('ujira.scope', 'project', true),
                  set_config('ujira.txid', txid_current()::text, true)`,
          [tenant.principalId, tenant.projectId],
        );
        expect(await codeOf(client.query(statement)), `app ${name}`).toBe('42501');
        await client.query('rollback');
      });
      const admin = new pg.Client({ connectionString: database.url });
      await admin.connect();
      try {
        // The owner holds every right on the table, so only the trigger stands
        // in the way, and the row must really be there for it to fire.
        await admin.query('begin');
        await admin.query('set local role ujira_owner');
        expect(await codeOf(admin.query(statement)), `owner ${name}`).toBe('UJ002');
        await admin.query('rollback');
      } finally {
        await admin.end();
      }
    }
    expect(await count('ujira.chain_events')).toBe('1');
  });

  it('approvals cannot be updated or deleted', async () => {
    for (const [name, statement] of mutations('ujira.approvals')) {
      const admin = new pg.Client({ connectionString: database.url });
      await admin.connect();
      try {
        await admin.query('begin');
        await admin.query('set local role ujira_owner');
        expect(await codeOf(admin.query(statement)), `owner ${name}`).toBe('UJ002');
        await admin.query('rollback');
      } finally {
        await admin.end();
      }
    }
    expect(await count('ujira.approvals')).toBe('1');
  });

  it.each(TABLES)('%s refuses the same from the indexer and the owner', async (table) => {
    const before = await count(table);
    expect(Number(before)).toBeGreaterThan(0);
    for (const [name, statement] of mutations(table)) {
      await as('ujira_indexer', async (client) => {
        expect(await codeOf(client.query(statement)), `indexer ${name}`).toBe('42501');
      });
      const admin = new pg.Client({ connectionString: database.url });
      await admin.connect();
      try {
        await admin.query('begin');
        await admin.query('set local role ujira_owner');
        expect(await codeOf(admin.query(statement)), `owner ${name}`).toBe('UJ002');
        await admin.query('rollback');
      } finally {
        await admin.end();
      }
    }
    expect(await count(table)).toBe(before);
  });
});
