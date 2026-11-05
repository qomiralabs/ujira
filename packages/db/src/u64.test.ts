// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A destination tag is an unsigned 64 bit integer on chain, which is past what a
// bigint column or a JavaScript number can hold.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

async function cast(value: string): Promise<string> {
  const result = await client.query<{ value: string }>('select $1::ujira.u64::text as value', [
    value,
  ]);
  return result.rows[0]?.value ?? '';
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

describe('ujira.u64', () => {
  it('2^64 refused, 2^64 - 1 accepted', async () => {
    const top = 2n ** 64n - 1n;
    expect(await cast(top.toString())).toBe(top.toString());
    await expect(cast((top + 1n).toString())).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['-1', '0.5', 'NaN', 'Infinity'])('refuses %s', async (value) => {
    await expect(cast(value)).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts zero', async () => {
    expect(await cast('0')).toBe('0');
  });
});
