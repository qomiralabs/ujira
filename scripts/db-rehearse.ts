// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Rehearses the pending migrations against a production shaped database and
// reports, per migration, how long it ran, which locks it held and how long
// reads waited behind it.
//
// "Pending" means the migrations in this checkout that the released ref does
// not have. The database is migrated to the released set first, filled with
// synthetic rows from packages/db/synthetic, and only then are the pending
// migrations applied, one at a time, with a probe reading every table.
//
// Usage:
//   node scripts/db-rehearse.ts [--released-ref <ref>] [--rows <n>] [--report <file>]
//
// The released ref defaults to origin/main. The report is JSON; a table is
// also printed, and appended to the job summary when run in GitHub Actions.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { MIGRATIONS_DIR, runMigrations } from '../packages/db/src/migrate.ts';
import { loadSeeds, rehearse, seed, type RehearsalStep } from '../packages/db/src/rehearsal.ts';
import { POSTGRES_IMAGE } from '../packages/db/src/testing/image.ts';

const SEEDS_DIR = fileURLToPath(new URL('../packages/db/synthetic', import.meta.url));

function fail(message: string): never {
  process.stderr.write(`db-rehearse: ${message}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    'released-ref': { type: 'string', default: 'origin/main' },
    rows: { type: 'string', default: '100000' },
    report: { type: 'string' },
  },
});

const rows = Number(values.rows);
if (!Number.isSafeInteger(rows) || rows < 0) fail('--rows must be a whole number');
const releasedRef = values['released-ref'];

const local = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => name.slice(0, -'.sql'.length));

// The migrations the released ref carries. A ref without the folder has
// released none of them; a ref that does not exist fails here.
const released = execFileSync(
  'git',
  ['ls-tree', '--name-only', releasedRef, 'packages/db/migrations/'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((path) => path.endsWith('.sql'))
  .map((path) => basename(path, '.sql'))
  .sort();

// The runner refuses a database whose history is not a prefix of the folder,
// and so would production. Saying it here names the cause.
released.forEach((name, index) => {
  if (local[index] !== name) {
    fail(`${releasedRef} has ${name}, which is not where this checkout has it`);
  }
});

const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
let steps: RehearsalStep[];
try {
  const url = container.getConnectionUri();
  if (released.length > 0) {
    await runMigrations({ databaseUrl: url, direction: 'up', count: released.length });
  }
  const seeds = loadSeeds(SEEDS_DIR, released);
  await seed(url, seeds, rows);
  process.stdout.write(
    `db-rehearse: ${String(released.length)} released, ${String(local.length - released.length)} pending, ${String(seeds.length)} seed file(s) at ${String(rows)} rows\n`,
  );
  steps = await rehearse({
    databaseUrl: url,
    applyNext: async (target) => {
      const run = await runMigrations({ databaseUrl: target, direction: 'up', count: 1 });
      return run.names;
    },
  });
} finally {
  await container.stop();
}

const round = (value: number): number => Math.round(value);
const table = [
  '| Migration | Duration ms | Locks held | Lock wait samples | Longest lock wait ms | Slowest read ms | Read errors |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...steps.map(
    (step) =>
      `| ${step.name} | ${String(round(step.durationMs))} | ${step.locks.join(', ') || 'none seen'} | ${String(step.lockWaitSamples)} | ${String(round(step.maxLockWaitMs))} | ${String(round(step.maxProbeMs))} | ${String(step.probeErrors)} |`,
  ),
].join('\n');

const summary = `## Migration rehearsal\n\nReleased ref ${releasedRef}, ${String(rows)} synthetic rows per seed.\n\n${steps.length === 0 ? 'No pending migrations.' : table}\n`;
process.stdout.write(`${summary}\n`);
if (values.report !== undefined) {
  writeFileSync(values.report, `${JSON.stringify({ releasedRef, rows, steps }, null, 2)}\n`);
}
const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
if (stepSummary !== undefined && stepSummary !== '') appendFileSync(stepSummary, summary);
