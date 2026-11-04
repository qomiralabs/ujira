// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createTestDatabase,
  roleUrl,
  type LoginRole,
  type TestDatabase,
} from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TABLES = [
  'ops.chain_cursors',
  'ops.executor_accounts',
  'ops.routing_config_versions',
  'ops.routing_config_active',
  'ops.identity_provider_events',
  'ops.email_quota_usage',
];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
});

afterAll(async () => {
  await database.drop();
});

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

describe('the ops role', () => {
  it('app role cannot select ops tables directly', async () => {
    await as('ujira_app', async (client) => {
      for (const table of TABLES) {
        expect(await codeOf(client.query(`select * from ${table}`)), table).toBe('42501');
      }
    });
  });

  it('the other service roles cannot reach the schema at all', async () => {
    for (const role of [
      'ujira_reader',
      'ujira_retention',
      'ujira_auth',
      'ujira_indexer',
    ] as const) {
      await as(role, async (client) => {
        expect(await codeOf(client.query('select * from ops.chain_cursors')), role).toBe('42501');
        expect(await codeOf(client.query('select * from ops.active_routing_config()')), role).toBe(
          '42501',
        );
      });
    }
  });

  it('reads and writes its own tables, and cannot rewrite a routing config version', async () => {
    await as('ujira_ops', async (client) => {
      await client.query(
        `insert into ops.chain_cursors (network, cursor) values ('stellar:testnet', '1')`,
      );
      await client.query(
        `update ops.chain_cursors set cursor = '2' where network = 'stellar:testnet'`,
      );
      const found = await client.query<{ cursor: string }>('select cursor from ops.chain_cursors');
      expect(found.rows).toEqual([{ cursor: '2' }]);
      const inserted = await client.query<{ version: string }>(
        `insert into ops.routing_config_versions (document, created_by)
         values ('{"corridors":[]}', 'deploy.runbook') returning version`,
      );
      const version = inserted.rows[0]?.version ?? '';
      expect(
        await codeOf(client.query(`update ops.routing_config_versions set created_by = 'other'`)),
      ).toBe('42501');
      await client.query('insert into ops.routing_config_active (version) values ($1)', [version]);
    });
  });

  it('has no rights on ujira beyond what it was given, and cannot read a tenant table', async () => {
    await as('ujira_ops', async (client) => {
      expect(await codeOf(client.query('select * from ujira.principals'))).toBe('42501');
      expect(await codeOf(client.query('select * from ujira.api_tokens'))).toBe('42501');
    });
  });

  it('refuses a second active row and a created_by that looks like a person', async () => {
    await as('ujira_ops', async (client) => {
      expect(
        await codeOf(
          client.query(
            `insert into ops.routing_config_active (only_row, version) values (false, 1)`,
          ),
        ),
      ).toBe('23514');
      expect(
        await codeOf(
          client.query(
            `insert into ops.routing_config_versions (document, created_by) values ('{}', 'someone@example.com')`,
          ),
        ),
      ).toBe('23514');
    });
  });

  it('gives PUBLIC and the API roles nothing on ops', async () => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const grants = await admin.query<{ object: string; grantee: string }>(
        `with objects (object, acl) as (
           select 'schema ops', coalesce(n.nspacl, acldefault('n', n.nspowner))
             from pg_namespace n where n.nspname = 'ops'
           union all
           select c.relname::text, coalesce(c.relacl, acldefault('r', c.relowner))
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'ops' and c.relkind in ('r', 'S')
           union all
           select p.oid::regprocedure::text, coalesce(p.proacl, acldefault('f', p.proowner))
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'ops'
         )
         select o.object,
                case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
           from objects o, aclexplode(o.acl) a`,
      );
      const forbidden = new Set(['PUBLIC', 'anon', 'authenticated', 'service_role']);
      expect(grants.rows.filter((row) => forbidden.has(row.grantee))).toEqual([]);
      // Handing the functions over needed CREATE for a moment; it must be gone.
      const create = await admin.query<{ allowed: boolean }>(
        `select has_schema_privilege('ujira_ops', 'ops', 'CREATE') as allowed`,
      );
      expect(create.rows).toEqual([{ allowed: false }]);
    } finally {
      await admin.end();
    }
  });
});
