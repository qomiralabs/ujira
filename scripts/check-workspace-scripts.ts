// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turborepo only runs workspace members, and skips a member that has no script
// for a task. Root lint leaves packages/ and apps/ to those per package tasks,
// so a folder that is not a member, or a member without a lint or typecheck
// script, would never be checked. Fail on both instead.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCANNED_DIRS = ['packages', 'apps'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);
const REQUIRED_SCRIPTS = ['build', 'lint', 'typecheck', 'test'];
const MAX_WARNINGS_ZERO = /(^|\s)--max-warnings(=|\s+)0(\s|$)/;
const SUPPRESSION = [/\|\|/, /;\s*(true|:|exit\s+0)(\s|;|$)/];

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

const problems: string[] = [];

// Reads the `packages:` list from pnpm-workspace.yaml. Only plain `<dir>/*`
// globs are supported; anything else is reported so this check is extended
// rather than silently matching the wrong folders.
function readWorkspaceGlobs(): string[] {
  const text = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (line.trim() === '') continue;
    const item = /^\s+-\s+['"]?([^'"]+?)['"]?\s*$/.exec(line);
    if (!item?.[1]) break;
    globs.push(item[1]);
  }
  if (globs.length === 0) {
    problems.push('pnpm-workspace.yaml: no entries found under "packages:"');
  }
  for (const glob of globs) {
    if (!/^[\w.-]+\/\*$/.test(glob)) {
      problems.push(`pnpm-workspace.yaml: unsupported glob "${glob}", expected the form "<dir>/*"`);
    }
  }
  return globs;
}

function isMember(manifestDir: string, globs: string[]): boolean {
  const parts = relative(ROOT, manifestDir).split(sep);
  return parts.length === 2 && globs.some((glob) => glob.slice(0, -'/*'.length) === parts[0]);
}

// Every folder that holds a package.json under the scanned dirs, at any depth.
// Symlinks are reported, not followed, so nothing can hide behind one.
function findManifests(dir: string, found: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      problems.push(`${relative(ROOT, path)}: symlinks are not allowed in workspace folders`);
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (existsSync(join(path, 'package.json'))) found.push(path);
    findManifests(path, found);
  }
}

function checkScripts(manifestDir: string): void {
  const pkg = JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8')) as PackageJson;
  const label = pkg.name ?? relative(ROOT, manifestDir);
  const scripts = pkg.scripts ?? {};
  for (const name of REQUIRED_SCRIPTS) {
    const script = scripts[name]?.trim();
    if (!script) {
      problems.push(`${label}: missing "${name}" script`);
      continue;
    }
    if (SUPPRESSION.some((pattern) => pattern.test(script))) {
      problems.push(`${label}: "${name}" script must not suppress failures`);
    }
  }
  const lint = scripts['lint'];
  if (lint && !MAX_WARNINGS_ZERO.test(lint)) {
    problems.push(`${label}: "lint" script must pass --max-warnings 0`);
  }
}

const globs = readWorkspaceGlobs();
const manifests: string[] = [];
for (const dir of SCANNED_DIRS) {
  const base = join(ROOT, dir);
  if (existsSync(base)) findManifests(base, manifests);
}

for (const manifestDir of manifests) {
  if (!isMember(manifestDir, globs)) {
    problems.push(
      `${relative(ROOT, manifestDir)}: has a package.json but is not a workspace member`,
    );
    continue;
  }
  checkScripts(manifestDir);
}

if (problems.length > 0) {
  process.stderr.write(`Workspace script check failed:\n  ${problems.join('\n  ')}\n`);
  process.exitCode = 1;
}
