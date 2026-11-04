// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fixed catalog of audited actions, as the database enforces it. The list in
// the repository is held to the check constraint here, so the two cannot drift.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { AUDIT_ACTIONS, audit, type AuditAction } from './repositories/audit.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let tenant: CreatedPrincipal;

const SETTINGS_ACTIONS: readonly AuditAction[] = [
  'principal.reporting_time_zone_changed',
  'project.routing_settings_changed',
  'project.payout_minimums_changed',
  'project.cashout_bearer_changed',
];

async function record(action: AuditAction) {
  return db
    .tenant(tenant)
    .transaction(async (tx) => audit.record(tx, { action, actor: { kind: 'system' } }));
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Audited',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the catalog', () => {
  it.each(SETTINGS_ACTIONS)(
    'the project and principal settings actions are accepted: %s',
    async (action) => {
      expect((await record(action)).action).toBe(action);
    },
  );

  it.each(AUDIT_ACTIONS)('accepts %s', async (action) => {
    expect((await record(action)).action).toBe(action);
  });

  it.each([
    'project.created',
    'project.settings_changed',
    'session.signed_in.extra',
    'SESSION.SIGNED_IN',
    'nothing',
    '',
  ])('an action outside the catalog is refused: %s', async (action) => {
    expect(await codeOf(record(action as AuditAction))).toBe('23514');
  });

  it('refuses an outside action on a direct insert too', async () => {
    expect(
      await codeOf(
        db.tenant(tenant).transaction(async (tx) =>
          sql`
            insert into ujira.audit_log
              (principal_id, project_id, action, actor_kind, seq, prev_hash, row_hash)
            values (
              ujira.current_principal_id(), ujira.current_project_id(), 'made.up', 'system', 0,
              ${Buffer.alloc(32)}, ${Buffer.alloc(32)}
            )
          `.execute(tx),
        ),
      ),
    ).toBe('23514');
  });

  it('matches the check constraint exactly, in both directions', async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      const found = await client.query<{ definition: string; validated: boolean }>(
        `select pg_get_constraintdef(oid) as definition, convalidated as validated
           from pg_constraint
          where conrelid = 'ujira.audit_log'::regclass and conname = 'audit_log_action_known'`,
      );
      const row = found.rows[0];
      expect(row?.validated).toBe(true);
      const listed = [...(row?.definition ?? '').matchAll(/'([^']+)'::text/g)].map(
        (match) => match[1],
      );
      expect([...listed].sort()).toEqual([...AUDIT_ACTIONS].sort());
    } finally {
      await client.end();
    }
  });

  it('leaves the chain intact across actions', async () => {
    await record('member.added');
    await record('api_key.revoked');
    const verified = await db.principal(tenant, 'app').transaction(async (tx) => audit.verify(tx));
    expect(verified.firstBreak).toBeNull();
  });
});
