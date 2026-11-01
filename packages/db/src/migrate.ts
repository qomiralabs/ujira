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
//
// This file imports nothing from its own package. The root scripts load it
// directly under Node's type stripping, which cannot follow a sibling import
// written with a .js specifier.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner, type MigrationBuilder, type RunnerOption } from 'node-pg-migrate';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// One table, in the schema migrations themselves create, so a migration and
// its record of having run live together.
export const MIGRATIONS_TABLE = 'ujira_migrations';

// The table the migration tool would use if anything called its command
// line directly. Nothing may, and a test checks for it.
export const TOOL_DEFAULT_MIGRATIONS_TABLE = 'pgmigrations';

// Every migration says on its first line whether it only adds to the schema
// (`expand`, safe while the previous release still runs) or takes something
// away (`contract`, safe only once no running code needs it). CI treats the
// two differently: an expand migration must roll back and forward to the
// same schema, which a contract migration usually cannot.
export type MigrationKind = 'expand' | 'contract';

export const DECLARATION_LINES: Readonly<Record<MigrationKind, string>> = {
  expand: '-- expand',
  contract: '-- contract',
};

// A concurrent index build cannot run inside a transaction, and the tool's
// own SQL loader runs every file inside one. A migration that needs to run
// outside says so on its second line, and then holds a single statement.
export const NO_TRANSACTION_LINE = '-- no-transaction';
export const UP_MARKER = '-- Up Migration';
export const DOWN_MARKER = '-- Down Migration';

export interface MigrationSource {
  readonly name: string;
  readonly kind: MigrationKind;
  readonly transactional: boolean;
  // Each section starts at its marker line, so a line number in it is the
  // line number in the file minus the section's offset.
  readonly up: string;
  readonly upLine: number;
  readonly down: string;
  readonly downLine: number;
}

export class MigrationFileError extends Error {
  override readonly name = 'MigrationFileError';
}

// Exact lines only. The tool's own loader also accepts loose spellings of
// the section markers, such as `--up migration`; one spelling means the CI
// checks and the runner can never read the same file two ways.
export function parseMigration(name: string, source: string): MigrationSource {
  const lines = source.split('\n').map((line) => line.replace(/\r$/, ''));
  const first = lines[0];
  const kind = (['expand', 'contract'] as const).find(
    (candidate) => DECLARATION_LINES[candidate] === first,
  );
  if (kind === undefined) {
    throw new MigrationFileError(
      `${name}: the first line must be "${DECLARATION_LINES.expand}" or "${DECLARATION_LINES.contract}"`,
    );
  }
  const ups = lines.flatMap((line, index) => (line === UP_MARKER ? [index] : []));
  const downs = lines.flatMap((line, index) => (line === DOWN_MARKER ? [index] : []));
  const [up] = ups;
  const [down] = downs;
  if (up === undefined || down === undefined || ups.length > 1 || downs.length > 1) {
    throw new MigrationFileError(
      `${name}: needs exactly one "${UP_MARKER}" line and one "${DOWN_MARKER}" line`,
    );
  }
  if (down < up) {
    throw new MigrationFileError(`${name}: "${UP_MARKER}" must come before "${DOWN_MARKER}"`);
  }
  return {
    name,
    kind,
    transactional: lines[1] !== NO_TRANSACTION_LINE,
    up: lines.slice(up, down).join('\n').trimEnd(),
    upLine: up + 1,
    down: lines.slice(down).join('\n').trimEnd(),
    downLine: down + 1,
  };
}

function actionFor(sql: string, transactional: boolean): (pgm: MigrationBuilder) => void {
  return (pgm) => {
    // The tool then commits the run's transaction, sends this statement on
    // its own and opens a new transaction for the migrations after it.
    if (!transactional) pgm.noTransaction();
    pgm.sql(sql);
  };
}

async function loadSqlMigrations(filePaths: string[]) {
  return Promise.all(
    filePaths.map(async (filePath) => {
      const migration = parseMigration(basename(filePath), await readFile(filePath, 'utf8'));
      return {
        id: filePath,
        filePaths: [filePath],
        actions: {
          up: actionFor(migration.up, migration.transactional),
          down: actionFor(migration.down, migration.transactional),
        },
      };
    }),
  );
}

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
  // Another folder of migrations, for tests that need a fixture. Everything
  // real runs from MIGRATIONS_DIR.
  readonly dir?: string;
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
    dir: options.dir ?? MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    direction: options.direction,
    migrationLoaderStrategies: [{ extensions: ['.sql'], loader: loadSqlMigrations }],
    // Every transactional migration runs inside one transaction, so a
    // failure leaves the schema as it was. A `-- no-transaction` migration
    // breaks it: what ran before it is committed first.
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
