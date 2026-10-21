// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs the database migrations from the command line. This exists so the
// command line and the code paths are one path: the package scripts used to
// call the migration tool's own command line, which records into the tool's
// default table, while runMigrations records into ours. QA measured both
// tables on one server, one per path. Two ledgers on one database means a
// migration can be applied twice or reported as pending after it ran.
//
// Usage, from anywhere in the repository:
//   pnpm db:migrate up
//   pnpm db:migrate down
//
// The URL comes from UJIRA_DB_MIGRATION_URL, or DATABASE_URL if that is
// unset, so a local container needs no extra wiring. Nothing here reads the
// full DatabaseConfig: a migration runs before the services exist, and the
// migrator is the one role whose URL is enough on its own.

import { MIGRATIONS_TABLE, runMigrations } from '../packages/db/src/migrate.ts';

function fail(message: string): never {
  process.stderr.write(`db:migrate: ${message}\n`);
  process.exit(1);
}

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  fail('usage: pnpm db:migrate up|down [count]');
}

const countArgument = process.argv[3];
if (countArgument !== undefined && !/^[1-9][0-9]*$/.test(countArgument)) {
  fail('the count must be a whole number of at least 1');
}

const databaseUrl = process.env['UJIRA_DB_MIGRATION_URL'] ?? process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  fail('set UJIRA_DB_MIGRATION_URL (or DATABASE_URL) to the database to migrate');
}

const applied = await runMigrations({
  databaseUrl,
  direction,
  ...(countArgument === undefined ? {} : { count: Number(countArgument) }),
  log: (message) => {
    process.stdout.write(`${message}\n`);
  },
});

process.stdout.write(
  applied.names.length === 0
    ? `db:migrate: nothing to do, ${MIGRATIONS_TABLE} is up to date\n`
    : `db:migrate: ${direction} applied ${String(applied.names.length)} migration(s) recorded in ${MIGRATIONS_TABLE}: ${applied.names.join(', ')}\n`,
);
