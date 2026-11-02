// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Personal data has one home, recipient_pii, as ciphertext. This reads the
// catalog and reports any other column in ujira whose name says otherwise, and
// any column in recipient_pii that could hold plain text.
//
// `name`, `address` and `country` alone are not on the list, because they mean
// something else here: a principal's or a mandate's name is a business's, a
// chain address is public, and a recipient's country is deliberately plain.
// Names and addresses that do belong to a person are caught by their prefixes.

import type pg from 'pg';

const PERSONAL_DATA =
  /(?:^|_)(?:email|phone|msisdn|first_name|last_name|full_name|given_name|family_name|middle_name|recipient_name|account_name|birth|birthdate|dob|date_of_birth|national_id|passport|tax_id|ssn|nin|bvn|home_address|street|street_address|postal_address|postcode|zipcode|city)(?:_|$)/i;

// Keys, sizes and timestamps of the personal data table: never personal data.
const PII_TABLE_PLAIN_COLUMNS: ReadonlySet<string> = new Set([
  'principal_id',
  'project_id',
  'recipient_id',
  'nonce',
  'created_at',
  'updated_at',
]);

export async function piiColumnProblems(client: pg.ClientBase): Promise<string[]> {
  const columns = (
    await client.query<{ table_name: string; column_name: string; type: string }>(
      `select c.relname as table_name,
              a.attname as column_name,
              format_type(a.atttypid, a.atttypmod) as type
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'ujira'
          and c.relkind in ('r', 'p')
          and a.attnum > 0
          and not a.attisdropped
        order by 1, a.attnum`,
    )
  ).rows;
  const problems: string[] = [];
  for (const column of columns) {
    const name = `ujira.${column.table_name}.${column.column_name}`;
    if (column.table_name === 'recipient_pii') {
      if (!PII_TABLE_PLAIN_COLUMNS.has(column.column_name) && column.type !== 'bytea') {
        problems.push(`${name}: recipient_pii holds ciphertext only, and this is ${column.type}`);
      }
      continue;
    }
    if (PERSONAL_DATA.test(column.column_name)) {
      problems.push(`${name}: reads like personal data, which belongs in recipient_pii`);
    }
  }
  return problems;
}
