// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reads the system catalog and lists every way a table in schema ujira falls
// short of the tenant rules. A table is either one of the listed exceptions,
// which hold no tenant data, or a tenant table, and a tenant table must:
//
// - be owned by ujira_owner, so no login role skips row level security by
//   owning it;
// - have row level security enabled and forced;
// - carry its tenant columns as uuid and not null: principal_id and
//   project_id, unless TENANT_COLUMNS names others for a tenant root;
// - have a policy for every command granted to a service role, so a grant
//   can never silently match no rows or every row;
// - point at another tenant table only through a foreign key that carries
//   every tenant column of the target, so a row can never reference another
//   tenant's row.
//
// Every new tenant table is held to this the moment it is migrated, by the
// catalog test, without anyone remembering to add a test for it.

import type pg from 'pg';

import { readsLikePersonalData } from './pii-columns.js';

export const CATALOG_SCHEMA = 'ujira';

// Reference data, the same for every tenant and writable only by the owner.
export const CATALOG_EXCEPTIONS: readonly string[] = [
  'ujira.audit_metadata_keys',
  'ujira.chains',
  'ujira.currencies',
  'ujira.currency_scales',
  'ujira.settlement_tokens',
  'ujira.status_transitions',
];

export interface TenantColumns {
  readonly principal: string;
  // Null for a table that belongs to a whole principal rather than to one
  // of its projects.
  readonly project: string | null;
}

const DEFAULT_COLUMNS: TenantColumns = { principal: 'principal_id', project: 'project_id' };

// The tenant roots, which carry their tenant under other names: a principal
// is its own principal, a project its own project, and a member belongs to
// the whole principal. So does an audit head, because one chain runs across
// all of a principal's projects.
export const TENANT_COLUMNS: Readonly<Record<string, TenantColumns>> = {
  'ujira.principals': { principal: 'id', project: null },
  'ujira.projects': { principal: 'principal_id', project: 'id' },
  'ujira.principal_members': { principal: 'principal_id', project: null },
  'ujira.audit_heads': { principal: 'principal_id', project: null },
};

export const SERVICE_ROLES = [
  'ujira_app',
  'ujira_reader',
  'ujira_retention',
  'ujira_auth',
  'ujira_indexer',
] as const;

const COMMANDS = [
  ['SELECT', 'r'],
  ['INSERT', 'a'],
  ['UPDATE', 'w'],
  ['DELETE', 'd'],
] as const;

interface TableRow {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly rls: boolean;
  readonly forced: boolean;
}

interface ColumnRow {
  readonly table_oid: number;
  readonly column: string;
  readonly type: string;
  readonly not_null: boolean;
  readonly attnum: number;
}

interface GrantRow {
  readonly table_oid: number;
  readonly role: string;
  readonly command: string;
  readonly covered: boolean;
}

interface ForeignKeyRow {
  readonly name: string;
  readonly source_oid: number;
  readonly target_oid: number;
  readonly source_columns: number[];
  readonly target_columns: number[];
}

export function tenantColumnsOf(table: string): TenantColumns {
  return TENANT_COLUMNS[table] ?? DEFAULT_COLUMNS;
}

export async function catalogProblems(
  client: pg.ClientBase,
  exceptions: readonly string[] = CATALOG_EXCEPTIONS,
): Promise<string[]> {
  const tables = (
    await client.query<TableRow>(
      `select c.oid::int as oid,
              format('%I.%I', n.nspname, c.relname) as name,
              pg_get_userbyid(c.relowner) as owner,
              c.relrowsecurity as rls,
              c.relforcerowsecurity as forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p')
        order by 2`,
      [CATALOG_SCHEMA],
    )
  ).rows;
  const tenant = tables.filter((table) => !exceptions.includes(table.name));
  const tenantOids = new Set(tenant.map((table) => table.oid));
  const nameOf = new Map(tables.map((table) => [table.oid, table.name]));
  const columnsOf = (oid: number): TenantColumns => tenantColumnsOf(nameOf.get(oid) ?? '');
  const problems: string[] = [];

  const names = new Set<string>([DEFAULT_COLUMNS.principal, 'project_id']);
  for (const columns of Object.values(TENANT_COLUMNS)) {
    names.add(columns.principal);
    if (columns.project !== null) names.add(columns.project);
  }
  const columns = (
    await client.query<ColumnRow>(
      `select a.attrelid::int as table_oid,
              a.attname as column,
              format_type(a.atttypid, a.atttypmod) as type,
              a.attnotnull as not_null,
              a.attnum::int as attnum
         from pg_attribute a
        where a.attrelid = any($1::oid[])
          and a.attname = any($2::text[])
          and not a.attisdropped`,
      [[...tenantOids], [...names]],
    )
  ).rows;
  const column = (oid: number, name: string): ColumnRow | undefined =>
    columns.find((row) => row.table_oid === oid && row.column === name);

  for (const table of tenant) {
    if (table.owner !== 'ujira_owner') {
      problems.push(`${table.name}: owned by ${table.owner}, not ujira_owner`);
    }
    if (!table.rls) problems.push(`${table.name}: row level security is not enabled`);
    if (!table.forced) problems.push(`${table.name}: row level security is not forced`);
    const expected = tenantColumnsOf(table.name);
    for (const name of [expected.principal, expected.project]) {
      if (name === null) continue;
      const found = column(table.oid, name);
      if (found === undefined) {
        problems.push(`${table.name}: has no ${name}`);
      } else {
        if (found.type !== 'uuid') problems.push(`${table.name}: ${name} is not a uuid`);
        if (!found.not_null) problems.push(`${table.name}: ${name} is nullable`);
      }
    }
  }

  // A grant with no policy for its command matches no row under forced row
  // level security, which hides a mistake rather than reporting it.
  const grants = (
    await client.query<GrantRow>(
      `select t.oid::int as table_oid, r.rolname as role, cmd.command,
              exists (
                select 1 from pg_policy p
                 where p.polrelid = t.oid
                   and p.polcmd in (cmd.code, '*')
                   and (r.oid = any(p.polroles) or 0::oid = any(p.polroles))
              ) as covered
         from unnest($1::oid[]) as t (oid)
         cross join unnest($2::text[]) as r0 (rolname)
         join pg_roles r on r.rolname = r0.rolname
         cross join unnest($3::text[], $4::text[]) as cmd (command, code)
        where has_table_privilege(r.oid, t.oid, cmd.command)`,
      [
        [...tenantOids],
        [...SERVICE_ROLES],
        COMMANDS.map(([command]) => command),
        COMMANDS.map(([, code]) => code),
      ],
    )
  ).rows;
  for (const grant of grants) {
    if (!grant.covered) {
      problems.push(
        `${nameOf.get(grant.table_oid) ?? String(grant.table_oid)}: ${grant.role} is granted ${grant.command} with no policy for it`,
      );
    }
  }

  const foreignKeys = (
    await client.query<ForeignKeyRow>(
      `select conname as name,
              conrelid::int as source_oid,
              confrelid::int as target_oid,
              conkey::int[] as source_columns,
              confkey::int[] as target_columns
         from pg_constraint
        where contype = 'f' and conrelid = any($1::oid[])`,
      [[...tenantOids]],
    )
  ).rows;
  for (const key of foreignKeys) {
    if (!tenantOids.has(key.target_oid)) continue;
    const source = columnsOf(key.source_oid);
    const target = columnsOf(key.target_oid);
    // Each tenant column of the target must be filled from the source's
    // column of the same kind, in the same position of the key.
    const pairs: [string | null, string | null][] = [
      [source.principal, target.principal],
      [source.project, target.project],
    ];
    const composite = pairs.every(([from, to]) => {
      if (to === null) return true;
      if (from === null) return false;
      const sourceAt = column(key.source_oid, from)?.attnum;
      const targetAt = column(key.target_oid, to)?.attnum;
      if (sourceAt === undefined || targetAt === undefined) return false;
      const position = key.source_columns.indexOf(sourceAt);
      return position !== -1 && key.target_columns[position] === targetAt;
    });
    if (!composite) {
      problems.push(
        `${nameOf.get(key.source_oid) ?? String(key.source_oid)}: foreign key ${key.name} to ${nameOf.get(key.target_oid) ?? String(key.target_oid)} does not carry its tenant columns`,
      );
    }
  }

  return problems;
}

// The queue's schemas hold no tenant data, so they sit outside the tenant rules
// above. That is a declared exception, and this holds it to its word: no tenant
// columns and no personal data by name. Payloads carry ids only, which
// jobPayloadProblems checks for the task registry.
export const INFRASTRUCTURE_SCHEMAS: readonly string[] = ['graphile_worker', 'ujira_jobs'];

export async function infrastructureProblems(
  client: pg.ClientBase,
  schemas: readonly string[] = INFRASTRUCTURE_SCHEMAS,
): Promise<string[]> {
  const columns = (
    await client.query<{ name: string; column_name: string }>(
      `select format('%I.%I', n.nspname, c.relname) as name, a.attname as column_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
        where n.nspname = any($1::text[])
          and c.relkind in ('r', 'p', 'v', 'm')
          and a.attnum > 0
          and not a.attisdropped
        order by 1, a.attnum`,
      [[...schemas]],
    )
  ).rows;
  const problems: string[] = [];
  for (const { name, column_name: column } of columns) {
    if (column === 'principal_id' || column === 'project_id') {
      problems.push(`${name}.${column}: infrastructure holds no tenant columns`);
    }
    if (readsLikePersonalData(column)) {
      problems.push(`${name}.${column}: reads like personal data, which belongs in recipient_pii`);
    }
  }
  return problems;
}

// Every function that runs with its owner's rights. A definer function is a way
// past row level security, so each is a decision someone made, and one not listed
// here fails the catalog test. The last four are the job queue's cross-tenant
// paths: the one way into the queue, and the cron fan-out.
export const DEFINER_ALLOWLIST: readonly string[] = [
  'ops.active_routing_config()',
  'ops.active_signing_keys(text[])',
  'ops.chain_cursor(text)',
  'ops.advance_chain_cursor(text,text)',
  'ops.email_quota_take(text,text,integer,integer)',
  'ops.flag_mandate(text,text)',
  'ops.flag_mandate(text,text,text)',
  'ops.identity_provider_event_seen(text,text,text)',
  'ops.mandate_alerts_after(bigint,integer)',
  'ops.register_mandate(text,text,text,bytea,bytea,bigint,bigint)',
  'ops.registered_mandate(text,text)',
  'ops.take_rate_limit_tokens(text[],integer[],integer[])',
  'ujira.check_payout_booking()',
  'ops.lease_executor(text,text,integer)',
  'ops.record_identity_provider_event(text,text,text,bytea)',
  'ops.release_executor(text,text,text,bigint)',
  'ujira.attestation_pending(bytea)',
  'ujira.audit_chain()',
  'ujira.authenticate_token(text)',
  'ujira.create_principal(text,text,uuid,text)',
  'ujira.ledger_balanced()',
  'ujira.ledger_stamp()',
  'ujira.resolve_mandate_instance(text,text)',
  'ujira.due_attempt_deadlines(timestamp with time zone,integer)',
  'ujira.overdue_fee_refunds(integer)',
  'ujira.funding_hold_targets(uuid,uuid,text,integer)',
  'ujira.lapsed_cancel_targets(uuid,integer)',
  'ujira.reconcile_targets(uuid,integer)',
  'ujira.resolve_funding_address(text,text)',
  'ujira_jobs.enqueue(text,jsonb,text,text,timestamp with time zone,integer,text,text)',
];

export async function definerProblems(
  client: pg.ClientBase,
  allowlist: readonly string[] = DEFINER_ALLOWLIST,
): Promise<string[]> {
  const found = (
    await client.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef
          and n.nspname not in ('pg_catalog', 'information_schema')
        order by 1`,
    )
  ).rows.map((row) => row.fn);
  const listed = new Set(allowlist);
  const present = new Set(found);
  return [
    ...found
      .filter((fn) => !listed.has(fn))
      .map((fn) => `${fn}: a security definer function not on the allowlist`),
    ...allowlist
      .filter((fn) => !present.has(fn))
      .map((fn) => `${fn}: on the allowlist, and not in the database`),
  ];
}
