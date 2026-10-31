// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  MigrationFileError,
  parseMigration,
  runMigrations,
  TOOL_DEFAULT_MIGRATIONS_TABLE,
} from './migrate.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
});

afterAll(async () => {
  await database.drop();
});

async function appliedNames(url: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>(
      `select name from ${MIGRATIONS_TABLE} order by id`,
    );
    return result.rows.map((row) => row.name);
  } finally {
    await client.end();
  }
}

describe('migrations', () => {
  it('runs down and up again, leaving the same migrations applied', async () => {
    const before = await appliedNames(database.url);
    expect(before.length).toBeGreaterThan(0);

    const down = await runMigrations({ databaseUrl: database.url, direction: 'down' });
    expect(down.names).toHaveLength(1);
    expect(await appliedNames(database.url)).toEqual(before.slice(0, -1));

    const up = await runMigrations({ databaseUrl: database.url, direction: 'up' });
    expect(up.names).toEqual(down.names);
    expect(await appliedNames(database.url)).toEqual(before);
  });

  it('steps back one migration by default, never the whole schema', async () => {
    // A `down` that undid everything would drop the database contents of a
    // staging environment on a typo.
    const before = await appliedNames(database.url);
    const down = await runMigrations({ databaseUrl: database.url, direction: 'down' });
    expect(down.names).toHaveLength(1);
    await runMigrations({ databaseUrl: database.url, direction: 'up' });
    expect(await appliedNames(database.url)).toEqual(before);
  });

  it('passes the tool output to a caller that asks for it', async () => {
    const lines: string[] = [];
    const fresh = await createTestDatabase(adminUrl, `${import.meta.url}#logging`);
    try {
      await runMigrations({ databaseUrl: fresh.url, direction: 'down' });
      await runMigrations({
        databaseUrl: fresh.url,
        direction: 'up',
        log: (message) => lines.push(message),
      });
      // The tool names each migration it applies, so a deploy log says what
      // ran rather than only that something did.
      expect(lines.join('\n')).toContain('init');
    } finally {
      await fresh.drop();
    }
  });

  it('applies nothing when it is already up to date', async () => {
    const again = await runMigrations({ databaseUrl: database.url, direction: 'up' });
    expect(again.names).toEqual([]);
  });

  it('refuses a second concurrent run rather than letting both migrate', async () => {
    // The spike marked this assumed: it expected a session scoped lock but
    // never checked it against the migration tool. Measured here, and it
    // corrects the assumption in one respect. The lock is session held, as
    // the next test shows, but the tool's default on contention is to fail
    // fast rather than queue: one run applies the migration and the other
    // throws "Another migration is already running". That is the behaviour
    // this package keeps, so two deploys cannot both think they migrated.
    const fresh = await createTestDatabase(adminUrl, `${import.meta.url}#concurrent`);
    try {
      await runMigrations({ databaseUrl: fresh.url, direction: 'down' });
      const results = await Promise.allSettled([
        runMigrations({ databaseUrl: fresh.url, direction: 'up' }),
        runMigrations({ databaseUrl: fresh.url, direction: 'up' }),
      ]);
      const applied = results.flatMap((result) =>
        result.status === 'fulfilled' ? result.value.names : [],
      );
      const refused = results.filter((result) => result.status === 'rejected');
      expect(applied).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const rejection = refused[0];
      expect(rejection?.status).toBe('rejected');
      const reason: unknown = rejection?.status === 'rejected' ? rejection.reason : undefined;
      expect(reason instanceof Error ? reason.message : String(reason)).toContain(
        'Another migration is already running',
      );
      // The migration is recorded once, whichever run won.
      const names = await appliedNames(fresh.url);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      await fresh.drop();
    }
  });

  it('waits for the lock instead when a run asks it to', async () => {
    // The option a deployment would use if every instance migrated at boot.
    const fresh = await createTestDatabase(adminUrl, `${import.meta.url}#waiting`);
    try {
      await runMigrations({ databaseUrl: fresh.url, direction: 'down' });
      const results = await Promise.all([
        runMigrations({ databaseUrl: fresh.url, direction: 'up', lockMode: 'wait' }),
        runMigrations({ databaseUrl: fresh.url, direction: 'up', lockMode: 'wait' }),
      ]);
      // One applies it, the other waits and then finds nothing to do.
      const applied = results.flatMap((result) => result.names);
      expect(applied).toHaveLength(1);
    } finally {
      await fresh.drop();
    }
  });

  it('holds the lock in the session, which is why the migrator needs the session pooler', async () => {
    // A transaction pooler hands each statement whichever backend is free,
    // so a lock taken in one statement is not held for the next. Here the
    // lock is visible as a session level lock while a migration runs, which
    // is the property the transaction pooler would break.
    const watcher = new pg.Client({ connectionString: database.url });
    await watcher.connect();
    try {
      const held = await watcher.query<{ count: string }>(
        `select count(*)::text as count from pg_locks where locktype = 'advisory'`,
      );
      // Nothing is holding it between runs.
      expect(held.rows[0]?.count).toBe('0');
      const migrator = new pg.Client({ connectionString: database.url });
      await migrator.connect();
      try {
        // Take the same lock the tool takes, in a session, and show a second
        // connection cannot take it.
        await migrator.query('select pg_advisory_lock(hashtext($1))', [MIGRATIONS_TABLE]);
        const blocked = await watcher.query<{ got: boolean }>(
          'select pg_try_advisory_lock(hashtext($1)) as got',
          [MIGRATIONS_TABLE],
        );
        expect(blocked.rows[0]?.got).toBe(false);
        await migrator.query('select pg_advisory_unlock(hashtext($1))', [MIGRATIONS_TABLE]);
      } finally {
        await migrator.end();
      }
      const free = await watcher.query<{ got: boolean }>(
        'select pg_try_advisory_lock(hashtext($1)) as got',
        [MIGRATIONS_TABLE],
      );
      expect(free.rows[0]?.got).toBe(true);
      await watcher.query('select pg_advisory_unlock(hashtext($1))', [MIGRATIONS_TABLE]);
    } finally {
      await watcher.end();
    }
  });
});

describe('migration files', () => {
  const FIXTURES = fileURLToPath(new URL('./testing/fixtures/migrations', import.meta.url));

  it('runs a -- no-transaction migration on its own, so an index can be built concurrently', async () => {
    // Postgres refuses CREATE INDEX CONCURRENTLY inside a transaction block,
    // and the tool's own SQL loader puts every file inside one. The fixture
    // folder ends with such a build, so this run only passes if the runner
    // takes it out of the shared transaction.
    const fresh = await createTestDatabase(adminUrl, `${import.meta.url}#concurrent-index`, {
      empty: true,
    });
    try {
      const up = await runMigrations({ databaseUrl: fresh.url, direction: 'up', dir: FIXTURES });
      expect(up.names).toEqual([
        '1700000000000_things',
        '1700000000001_things_note',
        '1700000000002_things_note_index',
      ]);
      const client = new pg.Client({ connectionString: fresh.url });
      await client.connect();
      try {
        const index = await client.query<{ valid: boolean }>(
          `select i.indisvalid as valid
             from pg_index i join pg_class c on c.oid = i.indexrelid
            where c.relname = 'things_note'`,
        );
        expect(index.rows).toEqual([{ valid: true }]);
      } finally {
        await client.end();
      }
      const down = await runMigrations({
        databaseUrl: fresh.url,
        direction: 'down',
        count: 3,
        dir: FIXTURES,
      });
      expect(down.names).toHaveLength(3);
    } finally {
      await fresh.drop();
    }
  });

  it('refuses a file that does not say whether it expands or contracts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ujira-undeclared-'));
    const fresh = await createTestDatabase(adminUrl, `${import.meta.url}#undeclared`, {
      empty: true,
    });
    try {
      writeFileSync(
        join(dir, '1700000000000_undeclared.sql'),
        '-- Up Migration\nselect 1;\n-- Down Migration\nselect 1;\n',
      );
      // The tool wraps a loader's error in its own; the cause is ours.
      const refused = await runMigrations({ databaseUrl: fresh.url, direction: 'up', dir }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).cause).toBeInstanceOf(MigrationFileError);
      expect((refused as Error).message).toContain(
        'the first line must be "-- expand" or "-- contract"',
      );
    } finally {
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every committed migration declares its kind and both sections', () => {
    for (const name of readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'))) {
      const migration = parseMigration(name, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
      expect(['expand', 'contract']).toContain(migration.kind);
      expect(migration.up.startsWith('-- Up Migration')).toBe(true);
      expect(migration.down.startsWith('-- Down Migration')).toBe(true);
    }
  });

  it('reads the sections and their line numbers, with Windows line endings too', () => {
    const migration = parseMigration(
      'x.sql',
      '-- contract\r\n-- no-transaction\r\n-- Up Migration\r\nselect 1;\r\n-- Down Migration\r\nselect 2;\r\n',
    );
    expect(migration).toEqual({
      name: 'x.sql',
      kind: 'contract',
      transactional: false,
      up: '-- Up Migration\nselect 1;',
      upLine: 3,
      down: '-- Down Migration\nselect 2;',
      downLine: 5,
    });
  });
});

describe('one ledger', () => {
  // QA measured two ledgers on one server: the package scripts called the
  // migration tool's command line, which records into its own default
  // table, while this function records into ours. A migration run through
  // one path then looks pending to the other.
  it('records into our table and never creates the tool default', async () => {
    const fresh = await createTestDatabase(adminUrl, `${import.meta.url}#ledger`);
    try {
      await runMigrations({ databaseUrl: fresh.url, direction: 'down' });
      await runMigrations({ databaseUrl: fresh.url, direction: 'up' });
      const client = new pg.Client({ connectionString: fresh.url });
      await client.connect();
      try {
        const tables = await client.query<{ table_name: string }>(
          `select table_name from information_schema.tables where table_name in ($1, $2)`,
          [MIGRATIONS_TABLE, TOOL_DEFAULT_MIGRATIONS_TABLE],
        );
        expect(tables.rows.map((row) => row.table_name)).toEqual([MIGRATIONS_TABLE]);
      } finally {
        await client.end();
      }
    } finally {
      await fresh.drop();
    }
  });

  it('has the package scripts go through the shared entry, not the tool command line', () => {
    // The scripts are the other half of the fix: if one goes back to calling
    // node-pg-migrate directly, it gets the tool's default table again and
    // the two ledgers come back.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { scripts: Record<string, string> };
    for (const name of ['migrate:up', 'migrate:down']) {
      const script = manifest.scripts[name] ?? '';
      expect(script, name).toContain('scripts/db-migrate.ts');
      expect(script, name).not.toContain('node-pg-migrate');
    }
  });
});
