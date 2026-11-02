// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createTestDatabase,
  roleUrl,
  type LoginRole,
  type TestDatabase,
} from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const INSERT = `
  insert into ops.fee_estimates (
    network, op, leg_count, p95_resource_fee_stroops, p95_rent_stroops,
    p95_inclusion_fee_stroops, sample_count, window_start, window_end
  ) values (
    'stellar:testnet', 'execute', 1, 1000, 400, 100, 25,
    '2026-10-25T00:00:00Z', '2026-11-01T00:00:00Z'
  )`;

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
});

afterAll(async () => {
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

describe('who can reach ops.fee_estimates', () => {
  it('ujira_app can select but not write ops.fee_estimates', async () => {
    await as('ujira_ops', (client) => client.query(INSERT));
    await as('ujira_app', async (client) => {
      const rows = await client.query('select op from ops.fee_estimates');
      expect(rows.rows).toEqual([{ op: 'execute' }]);
      expect(await codeOf(client.query(INSERT))).toBe('42501');
      expect(await codeOf(client.query('update ops.fee_estimates set sample_count = 1'))).toBe(
        '42501',
      );
      expect(await codeOf(client.query('delete from ops.fee_estimates'))).toBe('42501');
    });
  });

  it('ujira_ops writes it, and nothing removes a row', async () => {
    await as('ujira_ops', async (client) => {
      await client.query('update ops.fee_estimates set sample_count = 30');
      expect(await codeOf(client.query('delete from ops.fee_estimates'))).toBe('42501');
    });
  });

  it('the other service roles cannot read it', async () => {
    for (const role of [
      'ujira_reader',
      'ujira_retention',
      'ujira_auth',
      'ujira_indexer',
    ] as const) {
      await as(role, async (client) => {
        expect(await codeOf(client.query('select * from ops.fee_estimates')), role).toBe('42501');
      });
    }
  });
});
