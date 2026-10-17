// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fails unless package.json is strict JSON with no duplicate keys and its
// `packageManager` pins exactly the pnpm version CI installs, with a SHA-512.
//
//   node scripts/check-package-manager.ts <expected pnpm version> [package.json]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkPackageManager, parseStrictJson, StrictJsonError } from './strict-json.ts';

const [expected, file = join(import.meta.dirname, '..', 'package.json')] = process.argv.slice(2);

if (expected === undefined || expected === '') {
  process.stderr.write('Usage: node scripts/check-package-manager.ts <expected pnpm version>\n');
  process.exit(2);
}

let problems: string[];
try {
  problems = checkPackageManager(parseStrictJson(readFileSync(file, 'utf8')), expected);
} catch (error) {
  if (!(error instanceof StrictJsonError)) throw error;
  problems = [`package.json is not strict JSON: ${error.message}`];
}

if (problems.length > 0) {
  process.stderr.write(`Package manager check failed:\n  ${problems.join('\n  ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`packageManager pins pnpm ${expected}\n`);
}
