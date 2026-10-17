// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fails when a production or dev dependency is under a license outside the
// allowlist, then writes THIRD_PARTY_NOTICES.md. Run with `pnpm licenses:check`.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  findViolations,
  flattenPnpmLicenses,
  formatViolation,
  isWorkspacePackage,
  normalizeRepository,
  renderNotices,
  type InstalledPackage,
  type NoticeEntry,
  type PnpmLicensesJson,
  type Scope,
} from './license-policy.ts';

const ROOT = join(import.meta.dirname, '..');
const NOTICES = join(ROOT, 'THIRD_PARTY_NOTICES.md');
const WORKSPACE_DIRS = ['packages', 'apps'];

interface Manifest {
  name?: string;
  repository?: unknown;
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
}

function readManifest(dir: string): Manifest {
  const file = join(dir, 'package.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Manifest) : {};
}

function workspaceNames(): Set<string> {
  const names = new Set<string>();
  const root = readManifest(ROOT).name;
  if (root) names.add(root);
  for (const dir of WORKSPACE_DIRS) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const name = readManifest(join(base, entry)).name;
      if (name) names.add(name);
    }
  }
  return names;
}

function listLicenses(scope: Scope): InstalledPackage[] {
  const stdout = execFileSync('pnpm', ['licenses', 'list', '--json', `--${scope}`], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = stdout.trim();
  return text === '' ? [] : flattenPnpmLicenses(JSON.parse(text) as PnpmLicensesJson);
}

function noticeEntries(
  packages: readonly InstalledPackage[],
  workspace: ReadonlySet<string>,
): NoticeEntry[] {
  const entries: NoticeEntry[] = [];
  for (const pkg of packages) {
    if (isWorkspacePackage(pkg, workspace)) continue;
    const manifest = pkg.path === '' ? {} : readManifest(pkg.path);
    if (manifest.os !== undefined || manifest.cpu !== undefined || manifest.libc !== undefined)
      continue;
    entries.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      repository: normalizeRepository(manifest.repository) ?? pkg.homepage,
    });
  }
  return entries;
}

const workspace = workspaceNames();
const prod = listLicenses('prod');
const dev = listLicenses('dev');
const violations = [
  ...findViolations(prod, 'prod', workspace),
  ...findViolations(dev, 'dev', workspace),
];

if (violations.length > 0) {
  process.stderr.write(
    `License check failed for ${String(violations.length)} package(s):\n  ${violations
      .map(formatViolation)
      .join('\n  ')}\nReplace the dependency, or get the license reviewed before it is added.\n`,
  );
  process.exitCode = 1;
} else {
  writeFileSync(
    NOTICES,
    renderNotices(noticeEntries(prod, workspace), noticeEntries(dev, workspace)),
  );
  process.stdout.write(
    `License check passed: ${String(prod.length)} production and ${String(dev.length)} dev package versions. Wrote THIRD_PARTY_NOTICES.md.\n`,
  );
}
