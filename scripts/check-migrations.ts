// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Checks migration files against the rules in migration-rules.ts.
//
// Usage:
//   node scripts/check-migrations.ts            every file in packages/db/migrations
//   node scripts/check-migrations.ts <file>...  the files named

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { MIGRATIONS_DIR } from '../packages/db/src/migrate.ts';
import { checkMigration, formatProblem } from './migration-rules.ts';

const named = process.argv.slice(2);
const files =
  named.length > 0
    ? named
    : readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => join(MIGRATIONS_DIR, name));

const problems = files.flatMap((file) =>
  checkMigration(basename(file), readFileSync(file, 'utf8')),
);

for (const problem of problems) process.stderr.write(`${formatProblem(problem)}\n`);
process.stdout.write(
  `check-migrations: ${String(files.length)} file(s), ${String(problems.length)} problem(s)\n`,
);
process.exit(problems.length === 0 ? 0 : 1);
