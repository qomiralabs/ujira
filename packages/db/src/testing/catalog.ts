// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reads the system catalog and lists every way a table in schema ujira falls
// short of the tenant rules. A table is either one of the listed exceptions,
// which hold no tenant data, or a tenant table, and a tenant table must:
//
// - be owned by ujira_owner, so no login role skips row level security by
//   owning it;
// - have row level security enabled and forced;
// - carry principal_id and project_id, both uuid and not null;
// - have a policy for every command granted to a service role, so a grant
//   can never silently match no rows or every row;
// - point at another tenant table only through a foreign key that includes
//   both tenant columns on each side, so a row can never reference another
//   tenant's row.
//
// Every new tenant table is held to this the moment it is migrated, by the
// catalog test, without anyone remembering to add a test for it.

import type pg from 'pg';

export const CATALOG_SCHEMA = 'ujira';

// Reference data, the same for every tenant and writable only by the owner.
export const CATALOG_EXCEPTIONS: readonly string[] = [
  'ujira.chains',
  'ujira.currencies',
  'ujira.currency_scales',
  'ujira.settlement_tokens',
  'ujira.status_transitions',
];

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
  readonly code: string;
  readonly covered: boolean;
}

interface ForeignKeyRow {
  readonly name: string;
  readonly source_oid: number;
  readonly target_oid: number;
  readonly source_columns: number[];
  readonly target_columns: number[];
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
  const problems: string[] = [];

  const columns = (
    await client.query<ColumnRow>(
      `select a.attrelid::int as table_oid,
              a.attname as column,
              format_type(a.atttypid, a.atttypmod) as type,
              a.attnotnull as not_null,
              a.attnum::int as attnum
         from pg_attribute a
        where a.attrelid = any($1::oid[])
          and a.attname in ('principal_id', 'project_id')
          and not a.attisdropped`,
      [[...tenantOids]],
    )
  ).rows;

  for (const table of tenant) {
    if (table.owner !== 'ujira_owner') {
      problems.push(`${table.name}: owned by ${table.owner}, not ujira_owner`);
    }
    if (!table.rls) problems.push(`${table.name}: row level security is not enabled`);
    if (!table.forced) problems.push(`${table.name}: row level security is not forced`);
    for (const column of ['principal_id', 'project_id']) {
      const found = columns.find((row) => row.table_oid === table.oid && row.column === column);
      if (found === undefined) {
        problems.push(`${table.name}: has no ${column}`);
      } else {
        if (found.type !== 'uuid') problems.push(`${table.name}: ${column} is not a uuid`);
        if (!found.not_null) problems.push(`${table.name}: ${column} is nullable`);
      }
    }
  }

  // A grant with no policy for its command matches no row under forced row
  // level security, which hides a mistake rather than reporting it.
  const grants = (
    await client.query<GrantRow>(
      `select t.oid::int as table_oid, r.rolname as role, cmd.command, cmd.code,
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
  const tenantColumn = (oid: number, column: string): number | undefined =>
    columns.find((row) => row.table_oid === oid && row.column === column)?.attnum;
  for (const key of foreignKeys) {
    if (!tenantOids.has(key.target_oid)) continue;
    const composite = (['principal_id', 'project_id'] as const).every((column) => {
      const source = tenantColumn(key.source_oid, column);
      const target = tenantColumn(key.target_oid, column);
      if (source === undefined || target === undefined) return false;
      const position = key.source_columns.indexOf(source);
      return position !== -1 && key.target_columns[position] === target;
    });
    if (!composite) {
      problems.push(
        `${nameOf.get(key.source_oid) ?? String(key.source_oid)}: foreign key ${key.name} to ${nameOf.get(key.target_oid) ?? String(key.target_oid)} does not carry principal_id and project_id`,
      );
    }
  }

  return problems;
}
