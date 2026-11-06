// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Holds schema ops to the terms of its exception. It is allowed to skip the
// tenant columns only because it holds nothing about a tenant, so this reads
// the catalog and the rows and reports anything that says otherwise:
//
// - a tenant column;
// - a foreign key between ops and ujira, in either direction;
// - a column whose name or comment reads like personal data;
// - a row holding a value that is also an identifier of a tenant row.
//
// The test runs this against the migrated schema and against fixtures that
// break each rule.

import type pg from 'pg';

const TENANT_COLUMN_NAMES: ReadonlySet<string> = new Set(['principal_id', 'project_id']);

// Whole words of a snake case name or of a comment, so `address` matches
// `recipient_address` and not `addressable`.
const PERSONAL_DATA = /(?:^|[^a-z])(?:name|email|phone|address|country|document)(?:[^a-z]|$)/i;

// routing_config_versions.document is the routing configuration, a JSON
// document in the ordinary sense, and the issue that created the table names
// it. It is the one column allowed past the pattern above, by its full name.
export const OPS_COLUMN_EXCEPTIONS: ReadonlySet<string> = new Set([
  'ops.routing_config_versions.document',
]);

interface OpsColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly comment: string | null;
}

interface ForeignKeyRow {
  readonly source: string;
  readonly target: string;
  readonly name: string;
}

export async function opsCatalogProblems(client: pg.ClientBase): Promise<string[]> {
  const problems: string[] = [];
  const columns = (
    await client.query<OpsColumnRow>(
      `select c.relname as table_name,
              a.attname as column_name,
              col_description(c.oid, a.attnum) as comment
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'ops'
          and c.relkind in ('r', 'p')
          and a.attnum > 0
          and not a.attisdropped
        order by 1, a.attnum`,
    )
  ).rows;
  for (const row of columns) {
    const column = `ops.${row.table_name}.${row.column_name}`;
    if (TENANT_COLUMN_NAMES.has(row.column_name)) {
      problems.push(`${column}: is a tenant column`);
    }
    if (OPS_COLUMN_EXCEPTIONS.has(column)) continue;
    if (PERSONAL_DATA.test(row.column_name)) {
      problems.push(`${column}: the name reads like personal data`);
    }
    if (row.comment !== null && PERSONAL_DATA.test(row.comment)) {
      problems.push(`${column}: the comment reads like personal data`);
    }
  }
  problems.push(...(await crossSchemaKeys(client)));
  return problems;
}

// Foreign keys between ops and ujira, in either direction. Neither schema may
// depend on the other's rows, so the exception stays one that can be read
// about and checked on its own.
export async function crossSchemaKeys(client: pg.ClientBase): Promise<string[]> {
  const keys = (
    await client.query<ForeignKeyRow>(
      `select format('%I.%I', sn.nspname, s.relname) as source,
              format('%I.%I', tn.nspname, t.relname) as target,
              k.conname as name
         from pg_constraint k
         join pg_class s on s.oid = k.conrelid
         join pg_namespace sn on sn.oid = s.relnamespace
         join pg_class t on t.oid = k.confrelid
         join pg_namespace tn on tn.oid = t.relnamespace
        where k.contype = 'f'
          and ((sn.nspname = 'ops' and tn.nspname = 'ujira')
            or (sn.nspname = 'ujira' and tn.nspname = 'ops'))
        order by 1, 3`,
    )
  ).rows;
  return keys.map((key) => `${key.source}: foreign key ${key.name} crosses to ${key.target}`);
}

// Every uuid held by a tenant table is an identifier of a tenant row. An ops
// row that contains one, anywhere in its text, is holding customer data by
// value whatever its column is called.
export async function opsDataProblems(client: pg.ClientBase): Promise<string[]> {
  const tenantColumns = (
    await client.query<{ table_name: string; column_name: string }>(
      `select format('%I.%I', n.nspname, c.relname) as table_name,
              a.attname as column_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'ujira'
          and c.relkind in ('r', 'p')
          and a.attnum > 0
          and not a.attisdropped
          and a.atttypid = 'uuid'::regtype
        order by 1, 2`,
    )
  ).rows;
  if (tenantColumns.length === 0) return [];
  // Names come from the catalog and are quoted by format above and here, so
  // none of this text comes from a row.
  const identifiers = tenantColumns
    .map((row) => `select "${row.column_name}"::text as id from ${row.table_name}`)
    .join(' union all ');
  // Collected once into a temporary table. The whole union inside each ops table's check
  // was run again for every row, grows with every tenant table, and at about 60 tables
  // took a test database down. Unqualified, because a session that has never made a
  // temporary table has no temporary schema to name.
  await client.query('drop table if exists ops_tenant_ids');
  await client.query(
    `create temporary table ops_tenant_ids as
       select distinct id from (${identifiers}) as tenant where id is not null`,
  );
  const tables = (
    await client.query<{ name: string }>(
      `select format('%I.%I', n.nspname, c.relname) as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'ops' and c.relkind in ('r', 'p')
        order by 1`,
    )
  ).rows;
  const problems: string[] = [];
  for (const table of tables) {
    const found = await client.query<{ count: string }>(
      `select count(*)::text as count
         from ${table.name} as row_of_ops
        where exists (
          select 1 from pg_temp.ops_tenant_ids as tenant
           where strpos(to_jsonb(row_of_ops)::text, tenant.id) > 0
        )`,
    );
    const count = found.rows[0]?.count ?? '0';
    if (count !== '0') {
      problems.push(`${table.name}: ${count} row(s) hold an identifier of a tenant row`);
    }
  }
  await client.query('drop table pg_temp.ops_tenant_ids');
  return problems;
}
