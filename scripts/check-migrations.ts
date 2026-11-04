// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Checks migration files against the rules in migration-rules.ts.
//
// Usage:
//   node scripts/check-migrations.ts            every file in packages/db/migrations
//   node scripts/check-migrations.ts <file>...  the files named
//
// Duplicate timestamps are checked against the whole folder either way, because
// the file a named one clashes with may not be named.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { MIGRATIONS_DIR } from '../packages/db/src/migrate.ts';
import { checkMigration, checkTimestamps, formatProblem } from './migration-rules.ts';

const named = process.argv.slice(2);
const committed = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => join(MIGRATIONS_DIR, name));
const files = named.length > 0 ? named : committed;

const problems = [
  ...files.flatMap((file) => checkMigration(basename(file), readFileSync(file, 'utf8'))),
  ...checkTimestamps([...committed, ...files].map((file) => basename(file))),
];

for (const problem of problems) process.stderr.write(`${formatProblem(problem)}\n`);
process.stdout.write(
  `check-migrations: ${String(files.length)} file(s), ${String(problems.length)} problem(s)\n`,
);
process.exit(problems.length === 0 ? 0 : 1);
