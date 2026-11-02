// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { piiColumnProblems } from './testing/pii-columns.js';

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

describe('personal data columns', () => {
  it('no other table has personal data columns', async () => {
    expect(await piiColumnProblems(client)).toEqual([]);
  });

  it.each([
    'recipient_email',
    'phone',
    'full_name',
    'date_of_birth',
    'national_id',
    'home_address',
  ])('fails on a fixture column named %s', async (column) => {
    await client.query(`create table ujira.fixture_named (${column} text)`);
    try {
      expect(await piiColumnProblems(client)).toEqual([
        `ujira.fixture_named.${column}: reads like personal data, which belongs in recipient_pii`,
      ]);
    } finally {
      await client.query('drop table ujira.fixture_named');
    }
  });

  it('does not trip on the names that mean something else here', async () => {
    await client.query(
      'create table ujira.fixture_words (name text, contract_address text, country text, cityscape text)',
    );
    try {
      expect(await piiColumnProblems(client)).toEqual([]);
    } finally {
      await client.query('drop table ujira.fixture_words');
    }
  });

  it('fails on a plain text column in recipient_pii', async () => {
    await client.query('alter table ujira.recipient_pii add column plain_note text');
    try {
      expect(await piiColumnProblems(client)).toEqual([
        'ujira.recipient_pii.plain_note: recipient_pii holds ciphertext only, and this is text',
      ]);
    } finally {
      await client.query('alter table ujira.recipient_pii drop column plain_note');
    }
  });
});
