// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabase, type Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { outbox, webhookDeliveries, webhookEndpoints } from './repositories/outbox.js';
import { runRetention } from './repositories/retention.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let sweeper: Database;
let admin: pg.Client;
let tenant: CreatedPrincipal;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function count(table: string): Promise<number> {
  const rows = await admin.query<{ count: string }>(
    `select count(*)::text as count from ujira.${table} where principal_id = $1`,
    [tenant.principalId],
  );
  return Number(rows.rows[0]?.count);
}

async function newKey(expiresIn: string): Promise<string> {
  const inserted = await admin.query<{ id: string }>(
    `insert into ujira.idempotency_keys
       (principal_id, project_id, idempotency_key, request_sha256, request_id, response_status,
        response_body, expires_at)
     values ($1, $2, $3, $4, 'req', 200, '{}', now() + $5::interval)
     returning id`,
    [tenant.principalId, tenant.projectId, randomUUID(), randomBytes(32), expiresIn],
  );
  return inserted.rows[0]?.id ?? '';
}

// An event with one delivery, written the normal way and then aged as the superuser,
// since nothing else can change either row.
async function newEventAndDelivery(age: string): Promise<{ eventId: string; endpointId: string }> {
  const { event, endpoint } = await db.tenant(tenant).transaction(async (tx) => {
    const madeEvent = await outbox.append(tx, { eventType: 'payout.held', payload: {} });
    const madeEndpoint = await webhookEndpoints.create(tx, {
      url: `https://example.com/${randomUUID()}`,
      secretRef: 'ref',
      eventTypes: ['payout.held'],
    });
    await webhookDeliveries.record(tx, {
      endpointId: madeEndpoint.id,
      eventId: madeEvent.id,
      attempt: 1,
      status: 'succeeded',
    });
    return { event: madeEvent, endpoint: madeEndpoint };
  });
  await admin.query('begin');
  await admin.query('set local session_replication_role = replica');
  await admin.query(
    `update ujira.webhook_deliveries
        set event_created_at = now() - $2::interval where event_id = $1`,
    [event.id, age],
  );
  await admin.query(
    `update ujira.outbox_events set created_at = now() - $2::interval where id = $1`,
    [event.id, age],
  );
  await admin.query('commit');
  return { eventId: event.id, endpointId: endpoint.id };
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  sweeper = createDatabase(
    loadDatabaseConfig({
      UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
      UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
      UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_retention', database.name),
      UJIRA_DB_MIGRATION_URL: database.url,
      UJIRA_DB_TLS: 'off',
    }),
  );
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

beforeEach(async () => {
  tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  await admin.query('begin');
  await admin.query('set local session_replication_role = replica');
  await admin.query('delete from ujira.webhook_deliveries');
  await admin.query('delete from ujira.outbox_events');
  await admin.query('delete from ujira.idempotency_keys');
  await admin.query('commit');
});

afterAll(async () => {
  await admin.end();
  await sweeper.close();
  await db.close();
  await database.drop();
});

describe('the retention role', () => {
  it('retention role deletes only expired rows in the three tables', async () => {
    await newKey('-1 minute');
    const liveKey = await newKey('1 minute');
    await newEventAndDelivery('31 days');
    const live = await newEventAndDelivery('29 days');

    const counts = await runRetention(sweeper);

    expect(counts).toEqual({ webhook_deliveries: 1, outbox_events: 1, idempotency_keys: 1 });
    expect((await admin.query('select id from ujira.idempotency_keys')).rows).toEqual([
      { id: liveKey },
    ]);
    expect((await admin.query('select id from ujira.outbox_events')).rows).toEqual([
      { id: live.eventId },
    ]);
    expect(await count('webhook_deliveries')).toBe(1);
  });

  it('removes a long backlog in batches, and finds nothing the second time', async () => {
    for (let index = 0; index < 5; index += 1) await newKey('-1 minute');
    expect((await runRetention(sweeper, 2)).idempotency_keys).toBe(5);
    expect((await runRetention(sweeper, 2)).idempotency_keys).toBe(0);
  });

  it('reaches expired rows of every tenant, and no live row of any', async () => {
    await newKey('-1 minute');
    const first = tenant;
    tenant = await db.unscoped(async (tx) =>
      entryPoints.createPrincipal(tx, {
        name: 'Bravo',
        projectName: 'Main',
        ownerUserId: randomUUID(),
      }),
    );
    await newKey('-1 minute');
    await newKey('1 minute');
    expect((await runRetention(sweeper)).idempotency_keys).toBe(2);
    expect(await count('idempotency_keys')).toBe(1);
    tenant = first;
    expect(await count('idempotency_keys')).toBe(0);
  });

  it('a delete with no condition still touches only expired rows', async () => {
    await newKey('1 minute');
    await newEventAndDelivery('1 day');
    const deleted = await sweeper.unscoped(async (tx) => {
      const statements = [
        'delete from ujira.idempotency_keys',
        'delete from ujira.webhook_deliveries',
        'delete from ujira.outbox_events',
      ];
      let total = 0n;
      for (const statement of statements) {
        const result = await sql.raw(statement).execute(tx);
        total += result.numAffectedRows ?? 0n;
      }
      return total;
    }, 'worker');
    expect(deleted).toBe(0n);
  });

  it('cannot read what an expired row held, update one, or touch anything else', async () => {
    const client = new pg.Client({
      connectionString: roleUrl(roleUrls, 'ujira_retention', database.name),
    });
    await client.connect();
    try {
      for (const statement of [
        'select response_body from ujira.idempotency_keys',
        'select payload from ujira.outbox_events',
        'select error_code from ujira.webhook_deliveries',
        'select url from ujira.webhook_endpoints',
        `update ujira.idempotency_keys set expires_at = now()`,
        `insert into ujira.outbox_events (principal_id, project_id, event_type, payload)
           values (gen_random_uuid(), gen_random_uuid(), 'a.b', '{}')`,
        'delete from ujira.webhook_endpoints',
        'delete from ujira.audit_log',
        'delete from ujira.ledger_entries',
        'delete from ujira.chain_events',
        'truncate ujira.outbox_events',
      ]) {
        expect(await codeOf(client.query(statement)), statement).toBe('42501');
      }
    } finally {
      await client.end();
    }
  });

  it('nothing but that role can remove a row from the two append only tables', async () => {
    const { eventId } = await newEventAndDelivery('31 days');
    for (const statement of [
      `delete from ujira.webhook_deliveries where event_id = '${eventId}'`,
      `delete from ujira.outbox_events where id = '${eventId}'`,
      `update ujira.outbox_events set event_type = 'a.b' where id = '${eventId}'`,
      'truncate ujira.outbox_events cascade',
      'truncate ujira.webhook_deliveries',
    ]) {
      await admin.query('begin');
      await admin.query('set local role ujira_owner');
      expect(await codeOf(admin.query(statement)), statement).toBe('UJ002');
      await admin.query('rollback');
    }
    expect(await count('outbox_events')).toBe(1);
  });
});
