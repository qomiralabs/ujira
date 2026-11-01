// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Lints migration files with squawk, which knows which statements take locks
// that stop live traffic. Two things are decided here rather than in
// squawk's configuration, because they differ per file:
//
// - Only the up section is linted. The down section of an expand migration
//   drops what the up section added, which is its job, and every drop would
//   be reported.
// - A transactional migration is linted as running inside a transaction,
//   which is how the runner sends it; a `-- no-transaction` one is not.
//
// Usage: node scripts/squawk-migrations.ts <file>...
// The squawk binary is found as SQUAWK_BIN, or `squawk` on the PATH.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parseMigration } from '../packages/db/src/migrate.ts';
import { upSectionForLint } from './migration-rules.ts';

const squawk = process.env['SQUAWK_BIN'] ?? 'squawk';
const files = process.argv.slice(2);
let failed = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const migration = parseMigration(basename(file), source);
  const result = spawnSync(
    squawk,
    [
      migration.transactional ? '--assume-in-transaction' : '--no-assume-in-transaction',
      '--stdin-filepath',
      file,
    ],
    { input: upSectionForLint(source), encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] },
  );
  if (result.error !== undefined) {
    process.stderr.write(`squawk-migrations: could not run ${squawk}: ${result.error.message}\n`);
    process.exit(2);
  }
  if (result.status !== 0) failed += 1;
}

process.stdout.write(
  `squawk-migrations: ${String(files.length)} file(s), ${String(failed)} with findings\n`,
);
process.exit(failed === 0 ? 0 : 1);
