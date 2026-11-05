// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What each role may do in schema ujira, read from the catalog. Supabase's
// API roles exist on every project and its Data API acts as them, so they
// must hold nothing here, and neither may PUBLIC, which they are all members
// of. A missing ACL means the default, and the default lets PUBLIC execute
// every function and use every type, so defaults are expanded before they
// are read.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, PLATFORM_ROLES, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

interface Grant {
  readonly object: string;
  readonly grantee: string;
  readonly privilege: string;
}

// Every privilege on schema ujira and on every table, sequence, function,
// domain and enum in it, plus the owner's default privileges, with a null
// ACL read as the default it stands for. Row types and array types follow
// their table or element and need USAGE on the schema to be reached, which
// the first row covers.
const GRANTS = `
  with objects (object, acl) as (
    select 'schema ujira', coalesce(n.nspacl, acldefault('n', n.nspowner))
      from pg_namespace n where n.nspname = 'ujira'
    union all
    select format('relation %I', c.relname), coalesce(c.relacl, acldefault('r', c.relowner))
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ujira' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    union all
    select format('function %s', p.oid::regprocedure), coalesce(p.proacl, acldefault('f', p.proowner))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'ujira'
    union all
    select format('type %s', t.oid::regtype), coalesce(t.typacl, acldefault('T', t.typowner))
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'ujira' and t.typtype in ('d', 'e')
    union all
    select format('default privileges of %s on %s', pg_get_userbyid(d.defaclrole), d.defaclobjtype), d.defaclacl
      from pg_default_acl d
     where d.defaclrole = 'ujira_owner'::regrole
  )
  select o.object,
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type as privilege
    from objects o, aclexplode(o.acl) a
`;

async function grants(): Promise<Grant[]> {
  return (await client.query<Grant>(GRANTS)).rows;
}

describe('grants on ujira', () => {
  it('anon, authenticated, service_role and PUBLIC have no grants on ujira', async () => {
    const all = await grants();
    // The query is not vacuous: the service roles do hold grants.
    expect(all.some((grant) => grant.grantee === 'ujira_app')).toBe(true);
    const forbidden = new Set<string>(['PUBLIC', ...PLATFORM_ROLES]);
    expect(all.filter((grant) => forbidden.has(grant.grantee))).toEqual([]);
  });

  it('the API roles exist here, as they do on Supabase, so the check above is not vacuous', async () => {
    const found = await client.query<{ rolname: string }>(
      'select rolname from pg_roles where rolname = any($1::text[]) order by rolname',
      [[...PLATFORM_ROLES]],
    );
    expect(found.rows.map((row) => row.rolname)).toEqual([...PLATFORM_ROLES].sort());
  });

  it('gives every service role usage on the schema and the reader nothing but reads', async () => {
    const all = await grants();
    for (const role of [
      'ujira_app',
      'ujira_reader',
      'ujira_retention',
      'ujira_auth',
      'ujira_indexer',
    ]) {
      const mine = all.filter((grant) => grant.grantee === role);
      expect(mine).toContainEqual({ object: 'schema ujira', grantee: role, privilege: 'USAGE' });
      const relations = mine.filter((grant) => grant.object.startsWith('relation '));
      expect(relations.length).toBeGreaterThan(0);
      if (role !== 'ujira_app' && role !== 'ujira_indexer') {
        expect(relations.filter((grant) => grant.privilege !== 'SELECT')).toEqual([]);
      }
    }
  });

  it('gives the roles with no tables of their own yet read access to the reference data only', async () => {
    const all = await grants();
    for (const role of ['ujira_retention', 'ujira_auth']) {
      const relations = all
        .filter((grant) => grant.grantee === role && grant.object.startsWith('relation '))
        .map((grant) => grant.object)
        .sort();
      expect(relations).toEqual([
        'relation chains',
        'relation currencies',
        'relation currency_scales',
        'relation settlement_tokens',
        'relation status_transitions',
      ]);
    }
  });

  it('lets service roles call the context functions and their own entry points, and nothing else', async () => {
    const executable = (role: string) =>
      grants().then((all) =>
        all
          .filter((grant) => grant.grantee === role && grant.privilege === 'EXECUTE')
          .map((grant) => grant.object)
          .sort(),
      );
    const context = [
      'function ujira.current_principal_id()',
      'function ujira.current_project_id()',
      'function ujira.project_scope_all()',
    ];
    const auditHash =
      'function ujira.audit_row_hash(bytea,uuid,uuid,bigint,text,text,uuid,jsonb,timestamp with time zone)';
    expect(await executable('ujira_app')).toEqual([
      auditHash,
      'function ujira.authenticate_token(text)',
      'function ujira.create_principal(text,text,uuid,text)',
      ...context,
    ]);
    expect(await executable('ujira_auth')).toEqual([
      'function ujira.authenticate_token(text)',
      ...context,
    ]);
    expect(await executable('ujira_reader')).toEqual([auditHash, ...context]);
    expect(await executable('ujira_indexer')).toEqual([
      ...context,
      'function ujira.resolve_mandate_instance(text,text)',
    ]);
  });
});

describe('roles', () => {
  it('no service role can bypass row level security, log in as a superuser or own ujira', async () => {
    const roles = await client.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      `select rolname, rolsuper, rolbypassrls, rolcanlogin
         from pg_roles where rolname like 'ujira\\_%' order by rolname`,
    );
    expect(roles.rows.map((role) => role.rolname)).toEqual([
      'ujira_app',
      'ujira_auth',
      'ujira_fn_audit',
      'ujira_fn_erasure',
      'ujira_fn_instances',
      'ujira_fn_ledger',
      'ujira_fn_principals',
      'ujira_fn_tokens',
      'ujira_indexer',
      'ujira_migrator',
      'ujira_ops',
      'ujira_owner',
      'ujira_reader',
      'ujira_retention',
      'ujira_signer_attester',
      'ujira_signer_read',
    ]);
    const nologin = new Set([
      'ujira_owner',
      'ujira_fn_audit',
      'ujira_fn_erasure',
      'ujira_fn_instances',
      'ujira_fn_ledger',
      'ujira_fn_principals',
      'ujira_fn_tokens',
      'ujira_signer_read',
    ]);
    for (const role of roles.rows) {
      expect(role.rolsuper, role.rolname).toBe(false);
      expect(role.rolbypassrls, role.rolname).toBe(false);
      expect(role.rolcanlogin, role.rolname).toBe(!nologin.has(role.rolname));
    }
  });

  it('each security definer function is owned by its own narrow role, and nothing else is', async () => {
    const definers = await client.query<{ fn: string; owner: string }>(
      `select p.oid::regprocedure::text as fn, pg_get_userbyid(p.proowner) as owner
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'ujira' and p.prosecdef
        order by 1`,
    );
    expect(definers.rows).toEqual([
      { fn: 'ujira.attestation_pending(bytea)', owner: 'ujira_signer_read' },
      { fn: 'ujira.audit_chain()', owner: 'ujira_fn_audit' },
      { fn: 'ujira.authenticate_token(text)', owner: 'ujira_fn_tokens' },
      { fn: 'ujira.create_principal(text,text,uuid,text)', owner: 'ujira_fn_principals' },
      { fn: 'ujira.erased_subjects(uuid,bigint)', owner: 'ujira_fn_erasure' },
      { fn: 'ujira.ledger_balanced()', owner: 'ujira_fn_ledger' },
      { fn: 'ujira.ledger_stamp()', owner: 'ujira_fn_ledger' },
      { fn: 'ujira.replay_erasure(uuid,uuid,uuid)', owner: 'ujira_fn_erasure' },
      { fn: 'ujira.resolve_mandate_instance(text,text)', owner: 'ujira_fn_instances' },
    ]);
    // Each holds only what its one function needs, and never CREATE.
    const rights = await client.query<{ grantee: string; object: string; privilege: string }>(
      `select pg_get_userbyid(a.grantee) as grantee, c.relname as object, a.privilege_type as privilege
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace,
              aclexplode(c.relacl) a
        where n.nspname = 'ujira' and pg_get_userbyid(a.grantee) like 'ujira\\_fn\\_%'
        order by 1, 2, 3`,
    );
    expect(rights.rows).toEqual([
      { grantee: 'ujira_fn_audit', object: 'audit_heads', privilege: 'INSERT' },
      { grantee: 'ujira_fn_audit', object: 'audit_heads', privilege: 'SELECT' },
      { grantee: 'ujira_fn_audit', object: 'audit_heads', privilege: 'UPDATE' },
      { grantee: 'ujira_fn_audit', object: 'audit_metadata_keys', privilege: 'SELECT' },
      { grantee: 'ujira_fn_erasure', object: 'data_keys', privilege: 'INSERT' },
      { grantee: 'ujira_fn_erasure', object: 'data_keys', privilege: 'SELECT' },
      { grantee: 'ujira_fn_erasure', object: 'data_keys', privilege: 'UPDATE' },
      { grantee: 'ujira_fn_erasure', object: 'erasure_log', privilege: 'INSERT' },
      { grantee: 'ujira_fn_erasure', object: 'erasure_log', privilege: 'SELECT' },
      { grantee: 'ujira_fn_erasure', object: 'payout_methods', privilege: 'SELECT' },
      { grantee: 'ujira_fn_erasure', object: 'payout_methods', privilege: 'UPDATE' },
      { grantee: 'ujira_fn_erasure', object: 'recipient_identities', privilege: 'SELECT' },
      { grantee: 'ujira_fn_erasure', object: 'recipient_identities', privilege: 'UPDATE' },
      { grantee: 'ujira_fn_erasure', object: 'recipient_pii', privilege: 'DELETE' },
      { grantee: 'ujira_fn_erasure', object: 'recipient_pii', privilege: 'SELECT' },
      { grantee: 'ujira_fn_erasure', object: 'recipients', privilege: 'SELECT' },
      { grantee: 'ujira_fn_erasure', object: 'recipients', privilege: 'UPDATE' },
      { grantee: 'ujira_fn_instances', object: 'mandate_instances', privilege: 'SELECT' },
      { grantee: 'ujira_fn_ledger', object: 'ledger_accounts', privilege: 'SELECT' },
      { grantee: 'ujira_fn_ledger', object: 'ledger_accounts', privilege: 'UPDATE' },
      { grantee: 'ujira_fn_ledger', object: 'ledger_entries', privilege: 'SELECT' },
      { grantee: 'ujira_fn_principals', object: 'principal_members', privilege: 'INSERT' },
      { grantee: 'ujira_fn_principals', object: 'principals', privilege: 'INSERT' },
      { grantee: 'ujira_fn_principals', object: 'projects', privilege: 'INSERT' },
      { grantee: 'ujira_fn_tokens', object: 'api_tokens', privilege: 'SELECT' },
    ]);
    const create = await client.query<{ role: string }>(
      `select r.rolname as role from pg_roles r
        where r.rolname like 'ujira\\_fn\\_%' and has_schema_privilege(r.oid, 'ujira', 'CREATE')`,
    );
    expect(create.rows).toEqual([]);
  });

  it('the owner role owns the schema and everything in it but the definer functions', async () => {
    const owners = await client.query<{ owner: string }>(
      `select distinct pg_get_userbyid(owner) as owner from (
         select nspowner as owner from pg_namespace where nspname = 'ujira'
         union all
         select c.relowner from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ujira'
         union all
         select p.proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'ujira' and not p.prosecdef
         union all
         select t.typowner from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'ujira'
       ) as everything`,
    );
    expect(owners.rows).toEqual([{ owner: 'ujira_owner' }]);
  });

  it('only the migrator is a member of the owner role among the logins', async () => {
    const members = await client.query<{ member: string }>(
      `select pg_get_userbyid(m.member) as member
         from pg_auth_members m
        where m.roleid = 'ujira_owner'::regrole
          and pg_get_userbyid(m.member) like 'ujira\\_%'`,
    );
    expect(members.rows).toEqual([{ member: 'ujira_migrator' }]);
  });

  it('the app role carries server side statement, lock and idle timeouts', async () => {
    const settings = await client.query<{ setting: string }>(
      `select unnest(s.setconfig) as setting
         from pg_db_role_setting s
        where s.setrole = 'ujira_app'::regrole and s.setdatabase = 0
        order by 1`,
    );
    expect(settings.rows.map((row) => row.setting)).toEqual([
      'idle_in_transaction_session_timeout=10s',
      'lock_timeout=3s',
      'statement_timeout=5s',
    ]);
  });
});
