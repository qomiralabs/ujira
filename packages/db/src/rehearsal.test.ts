// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { runMigrations } from './migrate.js';
import { loadSeeds, rehearse, seed, withApplicationName, type RehearsalStep } from './rehearsal.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const MIGRATIONS = fileURLToPath(new URL('./testing/fixtures/migrations', import.meta.url));
const SEEDS = fileURLToPath(new URL('./testing/fixtures/synthetic', import.meta.url));
const RELEASED = ['1700000000000_things'];

let database: TestDatabase;
let steps: RehearsalStep[];

async function count(url: string): Promise<string | undefined> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      'select count(*)::text as count from public.things',
    );
    return result.rows[0]?.count;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  // The released schema, then synthetic rows, then the pending migrations
  // one at a time: the order the nightly job runs them in.
  database = await createTestDatabase(adminUrl, import.meta.url, { empty: true });
  await runMigrations({ databaseUrl: database.url, direction: 'up', count: 1, dir: MIGRATIONS });
  await seed(database.url, loadSeeds(SEEDS, RELEASED), 500);
  steps = await rehearse({
    databaseUrl: database.url,
    applyNext: async (url) => {
      const run = await runMigrations({
        databaseUrl: url,
        direction: 'up',
        count: 1,
        dir: MIGRATIONS,
      });
      return run.names;
    },
  });
});

afterAll(async () => {
  await database.drop();
});

describe('rehearsal', () => {
  it('seeds the released tables with the requested number of rows', async () => {
    expect(await count(database.url)).toBe('500');
  });

  it('applies each pending migration once, in order, and stops when none is left', () => {
    expect(steps.map((step) => step.name)).toEqual([
      '1700000000001_things_note',
      '1700000000002_things_note_index',
    ]);
  });

  it('records the exclusive lock a column change holds and the reads that waited on it', () => {
    const [note] = steps;
    expect(note?.durationMs).toBeGreaterThanOrEqual(500);
    expect(note?.locks).toContain('AccessExclusiveLock on public.things');
    expect(note?.lockWaitSamples).toBeGreaterThan(0);
    expect(note?.maxLockWaitMs).toBeGreaterThan(0);
    expect(note?.maxProbeMs).toBeGreaterThanOrEqual(300);
    expect(note?.probeErrors).toBe(0);
  });

  it('records a concurrent index build without an exclusive lock', () => {
    const index = steps[1];
    expect(index?.locks.some((lock) => lock.startsWith('AccessExclusiveLock'))).toBe(false);
    expect(index?.probeReads).toBeGreaterThan(0);
  });
});

describe('seeds', () => {
  it('loads only the seeds of released migrations, and none from a missing folder', () => {
    expect(loadSeeds(SEEDS, RELEASED).map((item) => item.migration)).toEqual(RELEASED);
    expect(loadSeeds(SEEDS, [])).toEqual([]);
    expect(loadSeeds(`${SEEDS}-missing`, RELEASED)).toEqual([]);
  });

  it('rethrows a folder it cannot read for any other reason', () => {
    const file = fileURLToPath(
      new URL('./testing/fixtures/synthetic/1700000000000_things.sql', import.meta.url),
    );
    expect(() => loadSeeds(file, RELEASED)).toThrow();
  });

  it('refuses a row count that is not a whole number', async () => {
    await expect(seed(database.url, [], -1)).rejects.toThrow(RangeError);
    await expect(seed(database.url, [], 1.5)).rejects.toThrow(RangeError);
  });

  it('rolls a failing seed back and reports it', async () => {
    const before = await count(database.url);
    await expect(
      seed(
        database.url,
        [
          {
            migration: 'broken',
            sql: 'insert into public.things (id) values (-1); select 1 / 0;',
          },
        ],
        1,
      ),
    ).rejects.toThrow('division by zero');
    expect(await count(database.url)).toBe(before);
  });
});

describe('connection naming', () => {
  it('names the connection without disturbing the rest of the URL', () => {
    const url = withApplicationName('postgresql://user:secret@host:5432/db?sslmode=disable', 'x');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('application_name')).toBe('x');
    expect(parsed.searchParams.get('sslmode')).toBe('disable');
    expect(parsed.pathname).toBe('/db');
  });
});
