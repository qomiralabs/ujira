// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Proves the migrations against a real server, in a throwaway container.
//
//   node scripts/db-schema.ts snapshot
//     Migrates a fresh database from zero and writes its schema, as
//     pg_dump --schema-only prints it, to packages/db/schema.snapshot.sql.
//     CI runs this and fails if the committed file differs, so a migration
//     cannot change the schema without the change showing in review.
//
//   node scripts/db-schema.ts roundtrip <migration>...
//     For each expand migration named: migrates a database up to it, rolls
//     it back and checks the schema equals a database that never ran it,
//     then runs it again and checks the schema equals the first run. A
//     contract migration is skipped, since taking something away is usually
//     not undoable.
//
// pg_dump runs inside the container, so its version is the server's and the
// output does not depend on whichever client the machine has installed.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { MIGRATIONS_DIR, parseMigration, runMigrations } from '../packages/db/src/migrate.ts';
import { POSTGRES_IMAGE } from '../packages/db/src/testing/image.ts';

export const SNAPSHOT_FILE = fileURLToPath(
  new URL('../packages/db/schema.snapshot.sql', import.meta.url),
);

const HEADER = `-- Generated from the migrations by \`pnpm db:snapshot\`.
-- Do not edit by hand: CI regenerates this file and fails if it differs.

`;

function fail(message: string): never {
  process.stderr.write(`db-schema: ${message}\n`);
  process.exit(1);
}

// Runs a program inside the container, with an argument list and no shell.
async function runInContainer(
  container: StartedPostgreSqlContainer,
  command: string[],
): Promise<string> {
  const result = await container.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(`${command[0] ?? ''} exited ${String(result.exitCode)}: ${result.stderr}`);
  }
  return result.stdout;
}

async function createDatabase(
  container: StartedPostgreSqlContainer,
  name: string,
): Promise<string> {
  await runInContainer(container, [
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    container.getUsername(),
    '-d',
    container.getDatabase(),
    '-c',
    `create database ${name}`,
  ]);
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  return url.toString();
}

// A fixed restrict key: pg_dump otherwise writes a random one into every
// dump, and two dumps of the same schema would never compare equal. The
// version lines are dropped because they name the image's Debian build,
// which can change under the same Postgres tag without the schema changing.
async function dumpSchema(
  container: StartedPostgreSqlContainer,
  database: string,
): Promise<string> {
  const dump = await runInContainer(container, [
    'pg_dump',
    '--schema-only',
    '--restrict-key=ujira',
    '-U',
    container.getUsername(),
    '-d',
    database,
  ]);
  return dump.replace(/^-- Dumped (?:from database|by pg_dump) version .*\n/gm, '');
}

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

// Prints a unified diff of two dumps and returns whether they were equal.
function compare(label: string, expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const dir = mkdtempSync(join(tmpdir(), 'ujira-schema-'));
  try {
    writeFileSync(join(dir, 'expected.sql'), expected);
    writeFileSync(join(dir, 'actual.sql'), actual);
    try {
      execFileSync('diff', ['-u', 'expected.sql', 'actual.sql'], { cwd: dir, encoding: 'utf8' });
    } catch (error) {
      const output = (error as { stdout?: string }).stdout ?? '';
      process.stderr.write(`db-schema: ${label}\n${output}\n`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return false;
}

async function snapshot(container: StartedPostgreSqlContainer): Promise<void> {
  const url = await createDatabase(container, 'snapshot');
  const run = await runMigrations({ databaseUrl: url, direction: 'up' });
  process.stdout.write(`db-schema: migrated from zero: ${run.names.join(', ')}\n`);
  writeFileSync(SNAPSHOT_FILE, HEADER + (await dumpSchema(container, 'snapshot')));
  process.stdout.write(`db-schema: wrote ${SNAPSHOT_FILE}\n`);
}

async function roundtrip(container: StartedPostgreSqlContainer, files: string[]): Promise<boolean> {
  const all = migrationNames();
  let ok = true;
  let index = 0;
  for (const file of files) {
    const name = basename(file);
    const position = all.indexOf(name);
    if (position === -1) fail(`${name} is not in ${MIGRATIONS_DIR}`);
    const source = parseMigration(name, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    if (source.kind === 'contract') {
      process.stdout.write(`db-schema: ${name} is a contract migration, not rolled back\n`);
      continue;
    }
    index += 1;
    const migrated = `roundtrip_${String(index)}`;
    const before = `roundtrip_${String(index)}_before`;

    // The schema with every migration up to and including this one.
    const migratedUrl = await createDatabase(container, migrated);
    await runMigrations({ databaseUrl: migratedUrl, direction: 'up', count: position + 1 });
    const up = await dumpSchema(container, migrated);

    // The schema of a database that never ran it, migrated from a folder
    // holding only the migrations before it.
    const earlier = mkdtempSync(join(tmpdir(), 'ujira-migrations-'));
    try {
      for (const previous of all.slice(0, position)) {
        copyFileSync(join(MIGRATIONS_DIR, previous), join(earlier, previous));
      }
      const beforeUrl = await createDatabase(container, before);
      await runMigrations({ databaseUrl: beforeUrl, direction: 'up', dir: earlier });
    } finally {
      rmSync(earlier, { recursive: true, force: true });
    }
    const expectedDown = await dumpSchema(container, before);

    await runMigrations({ databaseUrl: migratedUrl, direction: 'down', count: 1 });
    const down = await dumpSchema(container, migrated);
    const downOk = compare(
      `${name}: down does not restore the schema before it`,
      expectedDown,
      down,
    );

    await runMigrations({ databaseUrl: migratedUrl, direction: 'up', count: 1 });
    const again = await dumpSchema(container, migrated);
    const upOk = compare(`${name}: up after down gives a different schema`, up, again);

    process.stdout.write(
      `db-schema: ${name}: down ${downOk ? 'restores' : 'DOES NOT restore'} the schema, up again ${upOk ? 'matches' : 'DOES NOT match'}\n`,
    );
    ok = ok && downOk && upOk;
  }
  return ok;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'snapshot' && command !== 'roundtrip') {
    fail('usage: node scripts/db-schema.ts snapshot | roundtrip <migration>...');
  }
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  let ok = true;
  try {
    if (command === 'snapshot') {
      await snapshot(container);
    } else {
      ok = await roundtrip(container, rest);
    }
  } finally {
    await container.stop();
  }
  if (!ok) process.exit(1);
}

await main();
