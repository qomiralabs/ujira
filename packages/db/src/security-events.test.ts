// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Security events hold nothing that reads back into a person. The shape of the
// table is what promises that, so these tests try to break it.

import { createHmac } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  SECURITY_EVENT_KINDS,
  securityEvents,
  type NewSecurityEvent,
  type SecurityEventKind,
} from './repositories/ops.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import {
  createTestDatabase,
  roleUrl,
  type LoginRole,
  type TestDatabase,
} from './testing/harness.js';
import { opsCatalogProblems } from './testing/ops-catalog.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const HMAC_KEY = 'a key only this test knows';
const EMAIL = 'someone@example.com';
const IP = '203.0.113.7';
const PREFIX = 'ujk_test_abcdefghijklmnop';

const hmac = (text: string): Buffer => createHmac('sha256', HMAC_KEY).update(text).digest();

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

async function record(event: NewSecurityEvent): Promise<void> {
  await db.unscoped(async (tx) => securityEvents.record(tx, event));
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
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('what is stored', () => {
  it('only HMACs and prefixes are stored', async () => {
    await record({
      kind: 'sign_in_failed',
      emailHmac: hmac(EMAIL),
      tokenPrefix: PREFIX,
      ipHmac: hmac(IP),
    });
    const rows = await admin.query<{ text: string; email_hmac: Buffer; ip_hmac: Buffer }>(
      `select e.email_hmac, e.ip_hmac, to_jsonb(e)::text as text
         from ops.security_events as e
        where e.token_prefix = $1`,
      [PREFIX],
    );
    const row = rows.rows[0];
    expect(row?.email_hmac).toEqual(hmac(EMAIL));
    expect(row?.ip_hmac).toEqual(hmac(IP));
    expect(row?.text).not.toContain(EMAIL);
    expect(row?.text).not.toContain('example.com');
    expect(row?.text).not.toContain(IP);
    expect(Buffer.from(row?.email_hmac ?? []).toString('utf8')).not.toContain(EMAIL);
  });

  it('has exactly these columns, and no tenant among them', async () => {
    const columns = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'ops' and table_name = 'security_events'
        order by ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'kind',
      'email_hmac',
      'token_prefix',
      'ip_hmac',
      'occurred_at',
    ]);
  });

  it('passes the no customer data check, as a named exception and no wider', async () => {
    expect(await opsCatalogProblems(admin)).toEqual([]);
    await admin.query('alter table ops.security_events add column email text');
    try {
      expect(await opsCatalogProblems(admin)).toEqual([
        'ops.security_events.email: the name reads like personal data',
      ]);
    } finally {
      await admin.query('alter table ops.security_events drop column email');
    }
  });

  it('refuses a plain email where the HMAC goes', async () => {
    expect(
      await codeOf(record({ kind: 'otp_failed', emailHmac: Buffer.from(EMAIL, 'utf8') })),
    ).toBe('23514');
  });

  it('refuses a plain address where the HMAC goes', async () => {
    expect(await codeOf(record({ kind: 'otp_failed', ipHmac: Buffer.from(IP, 'utf8') }))).toBe(
      '23514',
    );
  });

  it('refuses a whole key where the prefix goes, so a secret cannot land here', async () => {
    const wholeKey = `${PREFIX}_${'a'.repeat(59)}`;
    expect(await codeOf(record({ kind: 'token_invalid', tokenPrefix: wholeKey }))).toBe('23514');
  });

  it('refuses an email where the prefix goes', async () => {
    expect(await codeOf(record({ kind: 'token_invalid', tokenPrefix: EMAIL }))).toBe('23514');
  });
});

describe('the kinds', () => {
  it.each(SECURITY_EVENT_KINDS)('accepts %s, with nothing but its kind', async (kind) => {
    await record({ kind });
  });

  it('refuses a kind outside the list', async () => {
    expect(await codeOf(record({ kind: 'made_up' as SecurityEventKind }))).toBe('23514');
  });

  it('dates the event itself', async () => {
    await record({ kind: 'csrf_failed', tokenPrefix: 'ujk_test_dated0000000000' });
    const found = await admin.query<{ recent: boolean }>(
      `select occurred_at > now() - interval '1 minute' as recent
         from ops.security_events where token_prefix = 'ujk_test_dated0000000000'`,
    );
    expect(found.rows).toEqual([{ recent: true }]);
  });
});

describe('who can reach it', () => {
  it.each(['ujira_app', 'ujira_auth', 'ujira_retention', 'ujira_reader', 'ujira_indexer'] as const)(
    '%s cannot read or write the table directly',
    async (role) => {
      await as(role, async (client) => {
        expect(await codeOf(client.query('select * from ops.security_events'))).toBe('42501');
        expect(
          await codeOf(
            client.query(`insert into ops.security_events (kind) values ('csrf_failed')`),
          ),
        ).toBe('42501');
        expect(await codeOf(client.query('delete from ops.security_events'))).toBe('42501');
      });
    },
  );

  it.each(['ujira_app', 'ujira_auth'] as const)('%s can record an event', async (role) => {
    await as(role, async (client) => {
      await client.query(
        `select ops.record_security_event('csrf_failed', null::bytea, null::text, null::bytea)`,
      );
    });
  });

  it.each(['ujira_reader', 'ujira_retention', 'ujira_indexer'] as const)(
    '%s cannot record an event',
    async (role) => {
      await as(role, async (client) => {
        expect(
          await codeOf(
            client.query(
              `select ops.record_security_event('csrf_failed', null::bytea, null::text, null::bytea)`,
            ),
          ),
        ).toBe('42501');
      });
    },
  );

  it('even the ops role cannot rewrite an event', async () => {
    await as('ujira_ops', async (client) => {
      expect(
        await codeOf(client.query(`update ops.security_events set kind = 'csrf_failed'`)),
      ).toBe('42501');
    });
    await admin.query(
      `insert into ops.security_events (kind, token_prefix) values ('mfa_failed', 'ujk_test_rewrite00000000')`,
    );
    expect(
      await codeOf(
        admin.query(
          `update ops.security_events set kind = 'csrf_failed' where token_prefix = 'ujk_test_rewrite00000000'`,
        ),
      ),
    ).toBe('UJ002');
  });
});
