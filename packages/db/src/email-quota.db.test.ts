// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { emailQuota, type EmailKind } from './repositories/ops.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;

const account = () => `resend:${randomUUID()}`;

function take(providerAccount: string, kind: EmailKind, cap: number, codeReserve: number) {
  return db.unscoped(async (tx) =>
    emailQuota.take(tx, { providerAccount, kind, cap, codeReserve }),
  );
}

async function usage(providerAccount: string) {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    const result = await client.query<{
      kind: string;
      sent: number;
      refused: number;
      exhausted: boolean;
    }>(
      `select kind, sent, refused, exhausted from ops.email_quota_usage
        where provider_account = $1 order by kind`,
      [providerAccount],
    );
    return result.rows;
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

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the mail quota', () => {
  it('20 concurrent takes count exactly', async () => {
    const provider = account();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => take(provider, 'code', 12, 0)),
    );
    expect(results.filter(Boolean)).toHaveLength(12);
    expect(await usage(provider)).toEqual([
      { kind: 'code', sent: 12, refused: 8, exhausted: true },
    ]);
  });

  it('codes may use the whole cap, other mail stops at the cap minus the reserve', async () => {
    const provider = account();
    expect(await take(provider, 'other', 3, 1)).toBe(true);
    expect(await take(provider, 'other', 3, 1)).toBe(true);
    expect(await take(provider, 'other', 3, 1)).toBe(false);
    // The reserve is still there for a login code.
    expect(await take(provider, 'code', 3, 1)).toBe(true);
    expect(await take(provider, 'code', 3, 1)).toBe(false);
    expect(await usage(provider)).toEqual([
      { kind: 'code', sent: 1, refused: 1, exhausted: true },
      { kind: 'other', sent: 2, refused: 1, exhausted: true },
    ]);
  });

  it('counts each account on its own', async () => {
    const first = account();
    const second = account();
    expect(await take(first, 'code', 1, 0)).toBe(true);
    expect(await take(first, 'code', 1, 0)).toBe(false);
    expect(await take(second, 'code', 1, 0)).toBe(true);
  });

  it('refuses a bad cap or reserve, and an unknown kind or account format', async () => {
    const provider = account();
    expect(await codeOf(take(provider, 'code', -1, 0))).toBe('22023');
    expect(await codeOf(take(provider, 'code', 1, 2))).toBe('22023');
    expect(await codeOf(take(provider, 'marketing' as EmailKind, 1, 0))).toBe('23514');
    expect(await codeOf(take('jane doe', 'code', 1, 0))).toBe('23514');
  });

  it('the app reaches the counters only through the function', async () => {
    const client = new pg.Client({
      connectionString: roleUrl(roleUrls, 'ujira_app', database.name),
    });
    await client.connect();
    try {
      expect(await codeOf(client.query('select * from ops.email_quota_usage'))).toBe('42501');
    } finally {
      await client.end();
    }
  });
});
