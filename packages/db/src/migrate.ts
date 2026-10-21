// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs the plain SQL migrations in packages/db/migrations. One function, and
// one ledger: the migrate:up and migrate:down scripts call
// scripts/db-migrate.ts, which calls this, so the command line, the test
// harness and the type generator all record into MIGRATIONS_TABLE.
//
// They did not always. The scripts used to call the migration tool's own
// command line, which records into its default table, pgmigrations, while
// this function records into ours. QA measured both tables on one server,
// one per path, which is how a migration gets applied twice or reported as
// pending after it ran. migrate.test.ts fails if the scripts stop going
// through here, or if the other table ever appears.
//
// Migrations run over a session connection, never the transaction pooler:
// the tool takes a session level advisory lock so two runs cannot overlap,
// and a transaction pooler would hand each statement a different backend and
// lose the lock. migrate.test.ts measures both the lock being session held
// and what a second concurrent run does with it.

import { fileURLToPath } from 'node:url';

import { runner, type RunnerOption } from 'node-pg-migrate';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// One table, in the schema migrations themselves create, so a migration and
// its record of having run live together.
export const MIGRATIONS_TABLE = 'ujira_migrations';

// The table the migration tool would use if anything called its command
// line directly. Nothing may, and a test checks for it.
export const TOOL_DEFAULT_MIGRATIONS_TABLE = 'pgmigrations';

export type MigrationDirection = 'up' | 'down';

// What a run does when another run already holds the lock. `fail` is the
// tool's default and this package's: a second run stops at once with
// "Another migration is already running", which is measured in
// migrate.test.ts. `wait` blocks until the lock frees, which is what a
// deployment that migrates from several instances at boot would need.
export type LockMode = 'fail' | 'wait';

export interface MigrateOptions {
  readonly databaseUrl: string;
  readonly direction: MigrationDirection;
  // `down` without a count would undo everything, which is never what a
  // command meant to step back one migration wants.
  readonly count?: number;
  readonly lockMode?: LockMode;
  readonly log?: (message: string) => void;
}

export interface MigrationRun {
  readonly names: readonly string[];
}

export async function runMigrations(options: MigrateOptions): Promise<MigrationRun> {
  const quiet = (): void => {
    // The tool is chatty; callers pass `log` when they want its output.
  };
  const log = options.log ?? quiet;
  // `down` with no count would undo every migration, which is never what a
  // command meant to step back one wants. `up` with no count runs them all.
  const count = options.count ?? (options.direction === 'down' ? 1 : undefined);
  const runnerOptions: RunnerOption = {
    databaseUrl: options.databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    direction: options.direction,
    // Every migration runs inside one transaction, so a failure leaves the
    // schema as it was.
    singleTransaction: true,
    // Each file is checked in order; a file inserted behind one that has
    // already run is a mistake worth stopping on.
    checkOrder: true,
    verbose: false,
    // Measured: with this at its default, a second concurrent run throws
    // rather than queueing. Loud is right for a migration run by hand or by
    // one deploy step; a deployment that migrates from every instance at
    // boot would pass 'wait'.
    advisoryLockMode: options.lockMode ?? 'fail',
    logger: {
      debug: quiet,
      info: (message: string) => {
        log(message);
      },
      warn: (message: string) => {
        log(message);
      },
      error: (message: string) => {
        log(message);
      },
    },
    ...(count === undefined ? {} : { count }),
  };
  const applied = await runner(runnerOptions);
  return { names: applied.map((migration) => migration.name) };
}
