// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The job queue must not become a path around tenant isolation. These tests
// connect as the real logins, against a database with the pinned worker schema
// installed by ujira_worker, the way the deploy step installs it.

import { Logger, runMigrations } from 'graphile-worker';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabase } from './database.js';
import {
  createTestDatabase,
  PLATFORM_ROLES,
  roleUrl,
  type LoginRole,
  type TestDatabase,
} from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TENANT = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
};

let database: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
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

describe('ujira_worker', () => {
  it("has_schema_privilege('ujira_worker', 'ujira', 'USAGE') is false", async () => {
    const result = await admin.query<{ usage: boolean; create: boolean }>(
      `select has_schema_privilege('ujira_worker', 'ujira', 'USAGE') as usage,
              has_schema_privilege('ujira_worker', 'ujira', 'CREATE') as create`,
    );
    expect(result.rows).toEqual([{ usage: false, create: false }]);
  });

  it('cannot read a tenant table, with or without a tenant context', async () => {
    await as('ujira_worker', async (client) => {
      expect(await codeOf(client.query('select id from ujira.mandates'))).toBe('42501');
      await client.query('begin');
      await client.query(
        `select set_config('ujira.principal_id', $1, true),
                set_config('ujira.project_id', $2, true),
                set_config('ujira.scope', 'project', true),
                set_config('ujira.txid', txid_current()::text, true)`,
        [TENANT.principalId, TENANT.projectId],
      );
      expect(await codeOf(client.query('select id from ujira.mandates'))).toBe('42501');
      await client.query('rollback');
    });
  });

  // The worker process reaches tenant data on the app login. A tenant
  // transaction sent to the worker's own pool fails rather than running under
  // weaker rules.
  it('a tenant transaction on the worker pool is refused', async () => {
    const db = createDatabase(
      loadDatabaseConfig({
        UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
        UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
        UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_worker', database.name),
        UJIRA_DB_MIGRATION_URL: database.url,
        UJIRA_DB_TLS: 'off',
      }),
    );
    try {
      const refused = db.withTenant('worker', { ...TENANT, scope: 'project' }, async (tx) => {
        await sql`select id from ujira.mandates`.execute(tx);
      });
      expect(await codeOf(refused)).toBe('42501');
    } finally {
      await db.close();
    }
  });

  it('owns the queue schemas, and can run the queue', async () => {
    const owners = await admin.query<{ schema: string; owner: string }>(
      `select nspname as schema, pg_get_userbyid(nspowner) as owner
         from pg_namespace where nspname in ('graphile_worker', 'ujira_jobs') order by 1`,
    );
    expect(owners.rows).toEqual([
      { schema: 'graphile_worker', owner: 'ujira_worker' },
      { schema: 'ujira_jobs', owner: 'ujira_worker' },
    ]);
    await as('ujira_worker', async (client) => {
      const job = await client.query<{ id: string }>(
        `select id from graphile_worker.add_job('test:noop', '{}'::json)`,
      );
      expect(job.rows).toHaveLength(1);
    });
  });

  it('cannot bypass row level security, be a superuser, or become the owner', async () => {
    const role = await admin.query(
      `select rolsuper, rolbypassrls, rolinherit, rolcanlogin, rolcreaterole, rolcreatedb
         from pg_roles where rolname = 'ujira_worker'`,
    );
    expect(role.rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcanlogin: true,
        rolcreaterole: false,
        rolcreatedb: false,
      },
    ]);
    const member = await admin.query<{ member: boolean }>(
      `select pg_has_role('ujira_worker', 'ujira_owner', 'member') as member`,
    );
    expect(member.rows).toEqual([{ member: false }]);
  });
});

describe('the app and the queue', () => {
  it('add_job as ujira_app is permission denied', async () => {
    await as('ujira_app', async (client) => {
      expect(
        await codeOf(client.query(`select graphile_worker.add_job('test:noop', '{}'::json)`)),
      ).toBe('42501');
    });
  });

  it('ujira_app holds no privilege on schema graphile_worker', async () => {
    const result = await admin.query<{ usage: boolean; create: boolean }>(
      `select has_schema_privilege('ujira_app', 'graphile_worker', 'USAGE') as usage,
              has_schema_privilege('ujira_app', 'graphile_worker', 'CREATE') as create`,
    );
    expect(result.rows).toEqual([{ usage: false, create: false }]);
  });

  it('no platform role can reach the queue schemas', async () => {
    const result = await admin.query<{ role: string; schema: string }>(
      `select r.rolname as role, s.name as schema
         from pg_roles r, unnest(array['graphile_worker', 'ujira_jobs']) as s (name)
        where r.rolname = any($1::text[])
          and (has_schema_privilege(r.oid, s.name, 'USAGE')
            or has_schema_privilege(r.oid, s.name, 'CREATE'))`,
      [[...PLATFORM_ROLES]],
    );
    expect(result.rows).toEqual([]);
  });
});

describe('the worker install', () => {
  it('no function in graphile_worker or ujira_jobs is executable by PUBLIC', async () => {
    const functions = await admin.query<{ fn: string; schema: string; public: boolean }>(
      `select p.oid::regprocedure::text as fn,
              n.nspname as schema,
              exists (
                select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ) as public
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('graphile_worker', 'ujira_jobs')`,
    );
    // Not vacuous: the worker install really did run in this database.
    expect(functions.rows.filter((row) => row.schema === 'graphile_worker').length).toBeGreaterThan(
      0,
    );
    expect(functions.rows.filter((row) => row.public)).toEqual([]);
  });

  it('the schema was installed by ujira_worker, which therefore owns what it created', async () => {
    const owners = await admin.query<{ owner: string }>(
      `select distinct pg_get_userbyid(c.relowner) as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'graphile_worker'`,
    );
    expect(owners.rows).toEqual([{ owner: 'ujira_worker' }]);
  });
});

describe('ujira_scheduler', () => {
  it('never logs in and cannot bypass row level security', async () => {
    const role = await admin.query(
      `select rolsuper, rolbypassrls, rolinherit, rolcanlogin
         from pg_roles where rolname = 'ujira_scheduler'`,
    );
    expect(role.rows).toEqual([
      { rolsuper: false, rolbypassrls: false, rolinherit: false, rolcanlogin: false },
    ]);
  });

  it('holds column grants only, on the listed tables and their listed columns', async () => {
    const tables = await admin.query<{ grantee: string }>(
      `select c.relname as grantee
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace,
              aclexplode(c.relacl) a
        where n.nspname in ('ujira', 'ops') and a.grantee = 'ujira_scheduler'::regrole`,
    );
    expect(tables.rows).toEqual([]);
    const columns = await admin.query<{ relation: string; column: string; privilege: string }>(
      `select c.relname as relation, attr.attname as column, a.privilege_type as privilege
         from pg_attribute attr
         join pg_class c on c.oid = attr.attrelid
         join pg_namespace n on n.oid = c.relnamespace,
              aclexplode(attr.attacl) a
        where n.nspname = 'ujira'
          and a.grantee = 'ujira_scheduler'::regrole
          and c.relname = 'mandate_instances'
        order by 2`,
    );
    expect(columns.rows).toEqual([
      { relation: 'mandate_instances', column: 'id', privilege: 'SELECT' },
      { relation: 'mandate_instances', column: 'principal_id', privilege: 'SELECT' },
      { relation: 'mandate_instances', column: 'project_id', privilege: 'SELECT' },
    ]);
    const readable = await admin.query<{ relation: string }>(
      `select distinct c.relname as relation
         from pg_attribute attr
         join pg_class c on c.oid = attr.attrelid
         join pg_namespace n on n.oid = c.relnamespace,
              aclexplode(attr.attacl) a
        where a.grantee = 'ujira_scheduler'::regrole`,
    );
    const allowed = new Set([
      'mandate_instances',
      'payout_attempts',
      'fee_refunds',
      'payout_funding_holds',
    ]);
    expect(readable.rows.filter((row) => !allowed.has(row.relation))).toEqual([]);
  });

  it('reads its columns across tenants and nothing else on the table', async () => {
    await admin.query('begin');
    try {
      await admin.query('set local role ujira_scheduler');
      await admin.query('select id, principal_id, project_id from ujira.mandate_instances');
      await admin.query('savepoint denied');
      expect(
        await codeOf(admin.query('select contract_address from ujira.mandate_instances')),
      ).toBe('42501');
      await admin.query('rollback to denied');
      expect(await codeOf(admin.query('select id from ujira.mandates'))).toBe('42501');
    } finally {
      await admin.query('rollback');
    }
  });

  it('its policy names only the scheduler, and is read only', async () => {
    const policies = await admin.query<{ roles: string[]; command: string; usable: string }>(
      `select array(select pg_get_userbyid(r) from unnest(p.polroles) as r)::text[] as roles,
              p.polcmd::text as command,
              pg_get_expr(p.polqual, p.polrelid) as usable
         from pg_policy p
        where p.polname = 'scheduler_read' and p.polrelid = 'ujira.mandate_instances'::regclass`,
    );
    expect(policies.rows).toEqual([{ roles: ['ujira_scheduler'], command: 'r', usable: 'true' }]);
  });
});

describe('after the install', () => {
  it('after install ujira_worker cannot create a schema, and the app search_path is pinned', async () => {
    await as('ujira_worker', async (client) => {
      expect(await codeOf(client.query('create schema shadow'))).toBe('42501');
    });
    const privilege = await admin.query<{ allowed: boolean }>(
      `select has_database_privilege('ujira_worker', current_database(), 'CREATE') as allowed`,
    );
    expect(privilege.rows).toEqual([{ allowed: false }]);
    // An installed pool still starts, because it creates nothing once installed.
    await runMigrations({
      connectionString: roleUrl(roleUrls, 'ujira_worker', database.name),
      logger: new Logger(() => () => undefined),
    });
    await as('ujira_app', async (client) => {
      const path = await client.query<{ path: string }>(
        `select current_setting('search_path') as path`,
      );
      expect(path.rows).toEqual([{ path: 'pg_catalog, pg_temp' }]);
    });
  });
});
