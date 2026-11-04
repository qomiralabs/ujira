// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The bootstrap runs from the migration and again after a restore, so it must
// be safe to run on a database that already has everything it sets up.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

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

// Everything the bootstrap can touch: the two roles and their memberships, the
// queue schemas with their owners and grants, what ujira grants them, the
// default privileges and the database grant.
const STATE = `
  select 'role' as kind, r.rolname as name,
         concat_ws(' ', r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcanlogin,
                   r.rolcreaterole, r.rolcreatedb) as value
    from pg_roles r where r.rolname in ('ujira_worker', 'ujira_scheduler')
  union all
  select 'membership', pg_get_userbyid(m.member),
         concat_ws(' ', pg_get_userbyid(m.roleid), pg_get_userbyid(m.grantor), m.inherit_option)
    from pg_auth_members m
   where m.roleid in ('ujira_worker'::regrole, 'ujira_scheduler'::regrole)
  union all
  select 'schema', n.nspname, concat_ws(' ', pg_get_userbyid(n.nspowner), n.nspacl::text)
    from pg_namespace n where n.nspname in ('graphile_worker', 'ujira_jobs', 'ujira')
  union all
  select 'default', pg_get_userbyid(d.defaclrole) || ' ' || d.defaclobjtype::text, d.defaclacl::text
    from pg_default_acl d where d.defaclrole = 'ujira_worker'::regrole
  union all
  select 'database', d.datname, d.datacl::text
    from pg_database d where d.datname = current_database()
  order by 1, 2, 3
`;

interface StateRow {
  readonly kind: string;
  readonly name: string;
  readonly value: string | null;
}

async function state(): Promise<StateRow[]> {
  return (await admin.query<StateRow>(STATE)).rows;
}

async function bootstrap(): Promise<void> {
  await admin.query('select ujira.bootstrap_worker_roles()');
}

describe('the worker roles bootstrap', () => {
  it('running twice changes nothing', async () => {
    await bootstrap();
    const first = await state();
    // Not vacuous: all of it is there to compare.
    expect(first.filter((row) => row.kind === 'role').map((row) => row.name)).toEqual([
      'ujira_scheduler',
      'ujira_worker',
    ]);
    expect(first.filter((row) => row.kind === 'schema')).toHaveLength(3);
    expect(first.filter((row) => row.kind === 'default')).toHaveLength(2);
    expect(first.filter((row) => row.kind === 'membership')).toHaveLength(2);
    await bootstrap();
    expect(await state()).toEqual(first);
  });

  // The install step grants CREATE for the install and takes it back. One that
  // stopped half way could leave it behind, and running the bootstrap ends that.
  it('takes back CREATE on the database, which only the install step holds', async () => {
    const hasCreate = async (): Promise<boolean | undefined> => {
      const result = await admin.query<{ allowed: boolean }>(
        `select has_database_privilege('ujira_worker', current_database(), 'CREATE') as allowed`,
      );
      return result.rows[0]?.allowed;
    };
    await admin.query(`
      do $grant$
      begin
        execute format('grant create on database %I to ujira_worker', current_database());
      end
      $grant$
    `);
    expect(await hasCreate()).toBe(true);
    await bootstrap();
    expect(await hasCreate()).toBe(false);
  });

  it('puts back what someone changed by hand', async () => {
    await admin.query('grant usage on schema graphile_worker to ujira_app');
    await admin.query('grant usage on schema ujira to ujira_worker');
    await bootstrap();
    const result = await admin.query<{ app: boolean; worker: boolean }>(
      `select has_schema_privilege('ujira_app', 'graphile_worker', 'USAGE') as app,
              has_schema_privilege('ujira_worker', 'ujira', 'USAGE') as worker`,
    );
    expect(result.rows).toEqual([{ app: false, worker: false }]);
  });

  it('is not callable by a service login', async () => {
    const result = await admin.query<{ role: string }>(
      `select r.rolname as role
         from pg_roles r
        where r.rolname in ('ujira_app', 'ujira_reader', 'ujira_retention', 'ujira_auth',
                            'ujira_indexer', 'ujira_worker', 'ujira_scheduler')
          and (has_function_privilege(r.oid, 'ujira.bootstrap_worker_roles()', 'EXECUTE')
            or has_function_privilege(r.oid, 'ujira.apply_scheduler_read(regclass, text[])', 'EXECUTE'))`,
    );
    expect(result.rows).toEqual([]);
  });
});
