// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The root lint. Arguments go to every ESLint run unchanged, and the plan lives
// in workspace.ts, where it is tested; this file only does the I/O. See
// lintScopes for why each member gets a process of its own.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { lintRuns, runLint } from './workspace.ts';

const ROOT = join(import.meta.dirname, '..');
const ESLINT = join(ROOT, 'node_modules/.bin/eslint');

const failed = runLint(lintRuns(ROOT, process.argv.slice(2)), (run) => {
  process.stdout.write(`lint: ${run.label}\n`);
  return spawnSync(ESLINT, run.args, { cwd: ROOT, stdio: 'inherit' }).status;
});

if (failed.length > 0) {
  process.stderr.write(`lint failed in: ${failed.join(', ')}\n`);
  process.exitCode = 1;
}
