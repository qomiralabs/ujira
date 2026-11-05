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
// A real database takes two URLs: UJIRA_DB_BOOTSTRAP_URL for the migrations that create
// a schema or administer roles, and UJIRA_DB_MIGRATION_URL for the rest. Each file says
// which it needs, and the runner refuses the wrong login. A local container takes one, a
// superuser's, in DATABASE_URL or UJIRA_DB_MIGRATION_URL. Nothing here reads the full
// DatabaseConfig: a migration runs before the services exist.
//
// ujira_migrator has to be able to log in before the first file it runs. The migrations
// never set a password, so provisioning does, and a run that stops there resumes.

import {
  MIGRATIONS_TABLE,
  runMigrations,
  runMigrationsByFile,
} from '../packages/db/src/migrate.ts';

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

const migratorUrl = process.env['UJIRA_DB_MIGRATION_URL'] ?? process.env['DATABASE_URL'];
if (migratorUrl === undefined || migratorUrl === '') {
  fail('set UJIRA_DB_MIGRATION_URL (or DATABASE_URL) to the database to migrate');
}
const bootstrapUrl = process.env['UJIRA_DB_BOOTSTRAP_URL'];

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};
const count = countArgument === undefined ? undefined : Number(countArgument);
const applied =
  bootstrapUrl === undefined || bootstrapUrl === ''
    ? await runMigrations({
        databaseUrl: migratorUrl,
        direction,
        log,
        ...(count === undefined ? {} : { count }),
      })
    : await runMigrationsByFile({
        bootstrapUrl,
        migratorUrl,
        direction,
        log,
        ...(count === undefined ? {} : { count }),
      });

process.stdout.write(
  applied.names.length === 0
    ? `db:migrate: nothing to do, ${MIGRATIONS_TABLE} is up to date\n`
    : `db:migrate: ${direction} applied ${String(applied.names.length)} migration(s) recorded in ${MIGRATIONS_TABLE}: ${applied.names.join(', ')}\n`,
);
