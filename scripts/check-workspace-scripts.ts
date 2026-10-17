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
// Finder metadata on macOS; ignored by git and never source.
const IGNORED_FILES = new Set(['.DS_Store']);
const REQUIRED_SCRIPTS = ['build', 'lint', 'typecheck', 'test'];
// Every --max-warnings flag in the lint script and the value it sets.
const MAX_WARNINGS_FLAG = /(?:^|\s)--max-warnings(?:=|\s+|(?=\s|$))(\S*)/g;
// The only shell operator a required script may use to join commands is `&&`,
// which stops at the first failure. Pipes, `;`, `||`, background `&`, command
// and process substitution can all let a failing command exit 0, so anything
// left once `&&` and redirection are removed fails. Redirection (`>`, `<`,
// `2>&1`) is allowed because it does not change the exit code.
const AND_CHAIN = '&&';
const FD_DUPLICATION = /\d*[<>]&(?:\d+|-)/g;
const FORBIDDEN_OPERATORS: readonly [string, RegExp][] = [
  ['|', /\|/],
  [';', /;/],
  ['&', /&/],
  ['`', /`/],
  ['$(', /\$\(/],
  ['<(', /<\(/],
  ['>(', />\(/],
];
// Every `&&` step of a required script must start with one of these tools,
// written as a bare name. Anything else, including package managers, shells,
// wrappers, `node` and negation with `!`, could run something whose exit code
// the check cannot see. Adding a tool here needs review.
export const ALLOWED_TOOLS: readonly string[] = ['tsc', 'eslint', 'vitest', 'prettier', 'next'];
// Characters that let the first word expand, be quoted or set a variable.
const UNSAFE_FIRST_WORD = /[$'"=/\\]/;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;

// Problems with one required script, worded to follow `"<name>" script`.
function scriptProblems(script: string): string[] {
  const found: string[] = [];
  const reasons: string[] = [];
  if (/[\r\n]/.test(script)) found.push('newline');
  for (const segment of script.split(AND_CHAIN)) {
    const command = segment.replace(FD_DUPLICATION, ' ');
    for (const [operator, pattern] of FORBIDDEN_OPERATORS) {
      if (pattern.test(command) && !found.includes(operator)) found.push(operator);
    }
    const word = command.trim().split(/\s+/)[0] ?? '';
    const shown = word === '' ? 'an empty command' : word;
    if (ENV_ASSIGNMENT.test(word)) {
      reasons.push(`must not set environment variables before a command, found ${shown}`);
    } else if (UNSAFE_FIRST_WORD.test(word)) {
      reasons.push(`must start each command with a bare tool name, found ${shown}`);
    } else if (!ALLOWED_TOOLS.includes(word)) {
      reasons.push(
        `must start each command with one of ${ALLOWED_TOOLS.join(', ')}, found ${shown}`,
      );
    }
  }
  if (found.length > 0) {
    reasons.unshift(`may only chain commands with &&, found ${found.join(', ')}`);
  }
  return [...new Set(reasons)];
}

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
    const script = scripts[name];
    if (!script?.trim()) {
      problems.push(`${label}: missing "${name}" script`);
      continue;
    }
    for (const reason of scriptProblems(script)) {
      problems.push(`${label}: "${name}" script ${reason}`);
    }
  }
  const lint = scripts['lint'];
  if (lint) {
    const values = [...lint.matchAll(MAX_WARNINGS_FLAG)].map((match) => match[1]);
    if (values.length !== 1 || values[0] !== '0') {
      problems.push(`${label}: "lint" script must pass --max-warnings 0 exactly once`);
    }
  }
}

const globs = readWorkspaceGlobs();
const manifests: string[] = [];
for (const dir of SCANNED_DIRS) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) continue;
  // Root lint and typecheck skip these folders, so anything directly inside
  // them that is not a package would never be checked.
  for (const entry of readdirSync(base)) {
    if (IGNORED_FILES.has(entry)) continue;
    const path = join(base, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) {
      problems.push(`${relative(ROOT, path)}: only package folders are allowed in ${dir}/`);
    } else if (!existsSync(join(path, 'package.json'))) {
      problems.push(`${relative(ROOT, path)}: folder has no package.json`);
    }
  }
  findManifests(base, manifests);
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
