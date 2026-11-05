// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The migrator logs in with `noinherit`, so it has none of the owner's rights
// until it takes the role. Every other test migrates as the admin user, who can
// do anything, which is how concurrent index builds that this login could not run
// got as far as a merge. This one migrates from an empty database as the login a
// deployment uses.
//
// A few migrations administer roles or create a schema, which needs more than the
// migrator will ever hold, so the admin runs those, as a bootstrap login would.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { MIGRATIONS_DIR, MIGRATIONS_TABLE, parseMigration, runMigrations } from './migrate.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

// Statements the migrator is not meant to be able to run.
const NEEDS_BOOTSTRAP =
  /\b(?:create|alter)\s+role\b|\bgrant\s+ujira_\w+\s+to\b|\brevoke\s+ujira_\w+\s+from\b|\bcreate\s+schema\b|\bdrop\s+schema\b/i;

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url, { empty: true });
});

afterAll(async () => {
  await database.drop();
});

describe('migrating as the migrator login', () => {
  it('runs every migration from zero, the concurrent builds included', async () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const migrator = roleUrl(roleUrls, 'ujira_migrator', database.name);
    const sources = files.map((name) =>
      parseMigration(name, readFileSync(join(MIGRATIONS_DIR, name), 'utf8')),
    );
    const asMigrator: string[] = [];
    for (const [index, source] of sources.entries()) {
      const bootstrap = NEEDS_BOOTSTRAP.test(source.up);
      // The tool creates its table on the first run, which has to be the admin's:
      // the migrator cannot create anything in the public schema.
      const url = bootstrap || index === 0 ? database.url : migrator;
      await expect(
        runMigrations({ databaseUrl: url, direction: 'up', count: 1 }),
        source.name,
      ).resolves.toMatchObject({ names: [source.name.replace(/\.sql$/, '')] });
      if (url === migrator) asMigrator.push(source.name);
      if (index === 0) {
        const admin = new pg.Client({ connectionString: database.url });
        await admin.connect();
        try {
          await admin.query(`grant all on public.${MIGRATIONS_TABLE} to ujira_migrator`);
          await admin.query(`grant all on all sequences in schema public to ujira_migrator`);
        } finally {
          await admin.end();
        }
      }
    }
    // Every migration outside a transaction ran as the migrator, so this cannot
    // quietly stop testing the thing it is here for.
    const concurrent = sources.filter((source) => !source.transactional).map((s) => s.name);
    expect(concurrent.length).toBeGreaterThan(0);
    expect(asMigrator).toEqual(expect.arrayContaining(concurrent));
  }, 300_000);

  it('leaves what a concurrent build makes with the owner of its table', async () => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ owner: string }>(
        `select pg_get_userbyid(c.relowner) as owner
             from pg_class c
            where c.oid = 'ujira.recipient_identities_one_per_provider'::regclass`,
      );
      expect(rows).toEqual([{ owner: 'ujira_owner' }]);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('rolls a concurrent build back and forward, recording each as the login', async () => {
    // A folder of its own, because the real migrations above the newest concurrent
    // build change, and some of them need the bootstrap login to come down.
    const dir = mkdtempSync(join(tmpdir(), 'migrator-rollback-'));
    const fresh = await createTestDatabase(adminUrl, `${import.meta.url}#rollback`, {
      empty: true,
    });
    const admin = new pg.Client({ connectionString: fresh.url });
    await admin.connect();
    try {
      writeFileSync(
        join(dir, '1000000000000_first.sql'),
        '-- expand\n\n-- Up Migration\nselect 1;\n\n-- Down Migration\nselect 1;\n',
      );
      writeFileSync(
        join(dir, '1000000000001_concurrent.sql'),
        [
          '-- expand',
          '-- no-transaction',
          '',
          '-- Up Migration',
          'create index concurrently if not exists rollback_index on public.rollback_table (id);',
          '',
          '-- Down Migration',
          'drop index concurrently if exists public.rollback_index;',
          '',
        ].join('\n'),
      );
      await runMigrations({ databaseUrl: fresh.url, direction: 'up', count: 1, dir });
      await admin.query('create table public.rollback_table (id integer)');
      await admin.query('grant create on schema public to ujira_owner');
      await admin.query('alter table public.rollback_table owner to ujira_owner');
      await admin.query(`grant all on public.${MIGRATIONS_TABLE} to ujira_migrator`);
      await admin.query('grant all on all sequences in schema public to ujira_migrator');
      // The owner role has no right to the migrations table, so recording a run
      // fails unless the role was reset first.
      await admin.query(`revoke all on public.${MIGRATIONS_TABLE} from ujira_owner`);
      const indexes = async () =>
        (
          await admin.query<{ indexname: string }>(
            `select indexname from pg_indexes where indexname = 'rollback_index'`,
          )
        ).rows.length;
      const migrator = roleUrl(roleUrls, 'ujira_migrator', fresh.name);
      const up = await runMigrations({ databaseUrl: migrator, direction: 'up', dir });
      expect(up.names).toEqual(['1000000000001_concurrent']);
      expect(await indexes()).toBe(1);
      const down = await runMigrations({ databaseUrl: migrator, direction: 'down', dir });
      expect(down.names).toEqual(['1000000000001_concurrent']);
      expect(await indexes()).toBe(0);
    } finally {
      await admin.end();
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
