// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turborepo silently skips a package that has no script for a task, so a new
// package without lint or typecheck would never be checked. Fail instead.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const WORKSPACE_DIRS = ['packages', 'apps'];
const REQUIRED_SCRIPTS = ['build', 'lint', 'typecheck', 'test'];

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

function findPackages(): string[] {
  const found: string[] = [];
  for (const dir of WORKSPACE_DIRS) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(base, entry.name, 'package.json');
      if (existsSync(manifest)) found.push(manifest);
    }
  }
  return found;
}

const problems: string[] = [];

for (const manifest of findPackages()) {
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as PackageJson;
  const label = pkg.name ?? relative(ROOT, manifest);
  const scripts = pkg.scripts ?? {};
  for (const name of REQUIRED_SCRIPTS) {
    if (!scripts[name]?.trim()) {
      problems.push(`${label}: missing "${name}" script`);
    }
  }
  const lint = scripts['lint'];
  if (lint && !lint.includes('--max-warnings 0')) {
    problems.push(`${label}: "lint" script must pass --max-warnings 0`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`Workspace script check failed:\n  ${problems.join('\n  ')}\n`);
  process.exitCode = 1;
}
