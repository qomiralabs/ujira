// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fails when any production or dev dependency of any workspace project is
// under a license outside the allowlist, or when the dependency listing cannot
// be trusted, then writes THIRD_PARTY_NOTICES.md. Run with
// `pnpm licenses:check`; it makes no network calls.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LockfileError, parseLockfile } from './lockfile.ts';
import { formatViolation } from './license-policy.ts';
import {
  checkTree,
  ListingError,
  parsePlatformMap,
  type Manifest,
  type ManifestInspector,
  type WorkspaceProject,
} from './license-tree.ts';
import { licensesListArgs, PnpmCommandError, resolvePnpmCommand } from './pnpm-command.ts';

const ROOT = join(import.meta.dirname, '..');
const NOTICES = join(ROOT, 'THIRD_PARTY_NOTICES.md');

function realpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function readManifest(dir: string): Manifest | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Manifest)
    : undefined;
}

// The usual spellings of a licence file. Read only when a package's metadata
// licence is not one the policy recognises.
const LICENSE_FILES = [
  'LICENSE',
  'LICENCE',
  'LICENSE.md',
  'LICENCE.md',
  'LICENSE.txt',
  'LICENCE.txt',
  'COPYING',
  'COPYING.md',
];

function readLicenseText(dir: string): string | undefined {
  for (const name of LICENSE_FILES) {
    const file = join(dir, name);
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  return undefined;
}

const inspector: ManifestInspector = {
  realpath,
  manifest: readManifest,
  licenseText: readLicenseText,
};

// Workspace folders from the `<dir>/*` globs in pnpm-workspace.yaml, plus the root.
function workspaceProjects(): WorkspaceProject[] {
  const text = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const block = /^packages:\s*\n((?:[ \t]+-.*\n?)+)/m.exec(text)?.[1] ?? '';
  const globs = [...block.matchAll(/^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1] ?? '');
  const dirs = [ROOT];
  for (const glob of globs) {
    if (!/^[\w.-]+\/\*$/.test(glob)) {
      throw new Error(`pnpm-workspace.yaml: unsupported glob "${glob}", expected "<dir>/*"`);
    }
    const base = join(ROOT, glob.slice(0, -2));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) dirs.push(join(base, entry));
  }
  const projects: WorkspaceProject[] = [];
  for (const dir of dirs) {
    const real = realpath(dir);
    const manifest = real === undefined ? undefined : readManifest(real);
    if (real === undefined || manifest === undefined) continue;
    const { name, version } = manifest;
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error(`${dir}/package.json needs a name and a version`);
    }
    projects.push({ dir: real, name, version, manifest });
  }
  return projects;
}

function listLicenses(scope: 'prod' | 'dev'): string {
  const command = resolvePnpmCommand(
    process.env['npm_execpath'],
    process.execPath,
    ROOT,
    licensesListArgs(scope),
    {
      realpath,
      packageName: (dir) => {
        const name = readManifest(dir)?.['name'];
        return typeof name === 'string' ? name : undefined;
      },
    },
  );
  return execFileSync(command.file, command.args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function run(): void {
  const result = checkTree({
    prodListing: listLicenses('prod'),
    devListing: listLicenses('dev'),
    lockfile: parseLockfile(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')),
    workspaces: workspaceProjects(),
    platformMap: parsePlatformMap(
      readFileSync(join(import.meta.dirname, 'platform-licenses.json'), 'utf8'),
    ),
    inspector,
  });
  const lines = [
    ...result.problems.map((problem) => `listing: ${problem}`),
    ...result.violations.map(formatViolation),
  ];
  if (lines.length > 0 || result.notices === undefined) {
    fail(
      `${lines.join('\n  ')}\nReplace the dependency, or get the license reviewed before it is added.`,
    );
    return;
  }
  writeFileSync(NOTICES, result.notices);
  process.stdout.write(
    `License check passed: ${String(result.checked)} package versions. Wrote THIRD_PARTY_NOTICES.md.\n`,
  );
}

function fail(message: string): void {
  process.stderr.write(`License check failed:\n  ${message}\n`);
  process.exitCode = 1;
}

try {
  run();
} catch (error) {
  // Expected failures get a one line message; anything else keeps its stack.
  if (
    error instanceof PnpmCommandError ||
    error instanceof LockfileError ||
    error instanceof ListingError
  ) {
    fail(error.message);
  } else {
    throw error;
  }
}
