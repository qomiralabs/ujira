// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Pruning buckets that have refilled, against a real database. A missing bucket
// starts full, so pruning one must change nothing a caller can see.

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { rateLimits, type RateLimitBucket } from './repositories/ops.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

function bucket(capacity = 3, refillPerSecond = 1): RateLimitBucket {
  const digest = createHash('sha256').update(randomUUID()).digest('hex');
  return { key: `token:${digest}`, capacity, refillPerSecond };
}

const take = (buckets: readonly RateLimitBucket[]) =>
  db.unscoped(async (tx) => rateLimits.take(tx, buckets));
const prune = (maxRows: number) => db.unscoped(async (tx) => rateLimits.pruneRefilled(tx, maxRows));

// As though the bucket was last taken from this long ago.
async function age(key: string, seconds: number): Promise<void> {
  await admin.query(
    `update ops.rate_limit_buckets
        set refilled_at = refilled_at - make_interval(secs => $2)
      where bucket_key = $1`,
    [key, seconds],
  );
}

async function exists(key: string): Promise<boolean> {
  const result = await admin.query('select 1 from ops.rate_limit_buckets where bucket_key = $1', [
    key,
  ]);
  return result.rows.length === 1;
}

// Prunes until nothing more is full, so a test sees the effect of a whole pass.
async function pruneAll(): Promise<void> {
  while ((await prune(1000)) === 1000);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('pruning rate limit buckets', () => {
  it('deletes a bucket old enough to be full again, and keeps one still refilling', async () => {
    const refilled = bucket(3, 1);
    const refilling = bucket(1000, 1);
    await take([refilled]);
    await take([refilling]);
    await age(refilled.key, 10);
    await pruneAll();
    expect(await exists(refilled.key)).toBe(false);
    expect(await exists(refilling.key)).toBe(true);
  });

  it('treats a request after the delete as having a full bucket', async () => {
    const pruned = bucket(5, 1);
    for (let i = 0; i < 4; i += 1) await take([pruned]);
    await age(pruned.key, 60);
    await pruneAll();
    expect(await exists(pruned.key)).toBe(false);
    const [afterPrune] = await take([pruned]);
    const [neverSeen] = await take([bucket(5, 1)]);
    expect(afterPrune).toMatchObject({ allowed: true });
    expect(afterPrune?.tokens).toBe(neverSeen?.tokens);
    expect(afterPrune?.tokens).toBe(4);
  });

  it('deletes in bounded batches, and says how many each time', async () => {
    const full = [bucket(), bucket(), bucket(), bucket(), bucket()];
    for (const each of full) {
      await take([each]);
      await age(each.key, 30);
    }
    const counts: number[] = [];
    for (;;) {
      const removed = await prune(2);
      counts.push(removed);
      if (removed < 2) break;
    }
    expect(counts.every((count) => count <= 2)).toBe(true);
    for (const each of full) expect(await exists(each.key)).toBe(false);
  });

  it('skips a bucket a request holds right now, rather than waiting on it', async () => {
    const held = bucket(3, 1);
    await take([held]);
    await age(held.key, 30);
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from ops.rate_limit_buckets where bucket_key = $1 for update', [
        held.key,
      ]);
      const started = Date.now();
      await pruneAll();
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await exists(held.key)).toBe(true);
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
    await pruneAll();
    expect(await exists(held.key)).toBe(false);
  });

  it('keeps a bucket written before buckets recorded their rule', async () => {
    const legacy = bucket();
    await admin.query(
      `insert into ops.rate_limit_buckets (bucket_key, tokens, refilled_at)
       values ($1, 3, now() - interval '1 day')`,
      [legacy.key],
    );
    await pruneAll();
    expect(await exists(legacy.key)).toBe(true);
    // Its next request records the rule, and from then on it can be pruned.
    await take([legacy]);
    await age(legacy.key, 30);
    await pruneAll();
    expect(await exists(legacy.key)).toBe(false);
  });

  it('refuses a batch size outside 1 to 10000', async () => {
    expect(await codeOf(prune(0))).toBe('22023');
    expect(await codeOf(prune(10_001))).toBe('22023');
  });

  it('runs as the app, which still cannot read or delete from the table itself', async () => {
    expect(
      await codeOf(
        db.unscoped(async (tx) => {
          await sql`delete from ops.rate_limit_buckets`.execute(tx);
        }),
      ),
    ).toBe('42501');
  });
});
