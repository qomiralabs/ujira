// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './testing/harness.js';

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

const GOOD = {
  network: 'stellar:testnet',
  op: 'execute',
  leg_count: 1,
  p95_resource_fee_stroops: 1_000,
  p95_rent_stroops: 400,
  p95_inclusion_fee_stroops: 100,
  sample_count: 25,
  window_start: '2026-10-25T00:00:00Z',
  window_end: '2026-11-01T00:00:00Z',
};

async function insert(overrides: Partial<Record<keyof typeof GOOD, unknown>>): Promise<void> {
  const row = { ...GOOD, ...overrides };
  await client.query(
    `insert into ops.fee_estimates (
       network, op, leg_count, p95_resource_fee_stroops, p95_rent_stroops,
       p95_inclusion_fee_stroops, sample_count, window_start, window_end
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict do nothing`,
    Object.values(row),
  );
}

async function constraintOf(overrides: Partial<Record<keyof typeof GOOD, unknown>>) {
  try {
    await insert(overrides);
    return undefined;
  } catch (error) {
    return (error as { constraint?: string }).constraint;
  }
}

describe('ops.fee_estimates', () => {
  it('accepts every listed op, and a good row', async () => {
    for (const op of [
      'request',
      'request_batch',
      'execute',
      'execute_batch',
      'approve',
      'reject',
      'cancel',
      'cancel_batch',
    ]) {
      expect(await constraintOf({ op }), op).toBeUndefined();
    }
  });

  it('refuses an unknown op', async () => {
    expect(await constraintOf({ op: 'withdraw' })).toBe('fee_estimates_op_known');
  });

  it('refuses a leg count of 0 or 5, and accepts 1 to 4', async () => {
    expect(await constraintOf({ leg_count: 0 })).toBe('fee_estimates_leg_count_range');
    expect(await constraintOf({ leg_count: 5 })).toBe('fee_estimates_leg_count_range');
    for (const leg_count of [1, 2, 3, 4]) {
      expect(await constraintOf({ leg_count }), String(leg_count)).toBeUndefined();
    }
  });

  it('refuses rent above the resource fee, and accepts rent equal to it', async () => {
    expect(await constraintOf({ p95_rent_stroops: 1_001 })).toBe(
      'fee_estimates_rent_within_resource_fee',
    );
    expect(await constraintOf({ op: 'approve', p95_rent_stroops: 1_000 })).toBeUndefined();
  });

  it('refuses a window end not after its start', async () => {
    expect(await constraintOf({ window_end: GOOD.window_start })).toBe(
      'fee_estimates_window_ordered',
    );
    expect(await constraintOf({ window_end: '2026-10-24T00:00:00Z' })).toBe(
      'fee_estimates_window_ordered',
    );
  });

  it('refuses no samples, negative fees and a malformed network', async () => {
    expect(await constraintOf({ sample_count: 0 })).toBe('fee_estimates_sample_count_positive');
    // Postgres reports the first check by name, and this value breaks several.
    expect(await constraintOf({ p95_resource_fee_stroops: -1 })).toMatch(/^fee_estimates_/);
    expect(await constraintOf({ p95_rent_stroops: -1 })).toBe('fee_estimates_rent_not_negative');
    expect(await constraintOf({ p95_inclusion_fee_stroops: -1 })).toBe(
      'fee_estimates_inclusion_fee_not_negative',
    );
    expect(await constraintOf({ network: 'Not A Network' })).toBe('fee_estimates_network_format');
  });

  it('has one row per network, op and leg count', async () => {
    const keys = await client.query<{ column_name: string }>(
      `select a.attname as column_name
         from pg_catalog.pg_index as i
         join pg_catalog.pg_attribute as a
           on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'ops.fee_estimates'::regclass and i.indisprimary
        order by a.attnum`,
    );
    expect(keys.rows.map((row) => row.column_name)).toEqual(['network', 'op', 'leg_count']);
  });
});
