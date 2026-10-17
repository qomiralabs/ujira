// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Structure check for the workspace. The root gate (`pnpm lint`,
// `pnpm typecheck`, `pnpm build`) runs fixed commands over every member and
// never runs package scripts, but it relies on every member being found and
// on member tsconfig files not weakening the shared compiler options. This
// check enforces both, and keeps package scripts to plain tool commands so
// running them by hand behaves like the gate.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';

import { listMembers, readWorkspaceGlobs, SCANNED_DIRS } from './workspace.ts';

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
export function scriptProblems(script: string): string[] {
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

// Compiler options a member tsconfig may set. Everything else, including
// every strictness flag and noCheck, comes from tsconfig.base.json only, so a
// member cannot switch a check off for itself.
export const MEMBER_COMPILER_OPTIONS: readonly string[] = [
  'rootDir',
  'outDir',
  'noEmit',
  'lib',
  'types',
  'jsx',
  'plugins',
];
const MEMBER_TSCONFIGS = ['tsconfig.json', 'tsconfig.build.json'];
const BASE_TSCONFIG = '../../tsconfig.base.json';
const NEXT_CONFIG = /^next\.config\.(?:js|mjs|cjs|ts|mts)$/;

function readJsonc(file: string): { value?: unknown; error?: string } {
  const result = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  if (result.error) {
    return { error: ts.flattenDiagnosticMessageText(result.error.messageText, ' ') };
  }
  return { value: result.config as unknown };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tsconfigProblems(memberDir: string, label: string): string[] {
  const problems: string[] = [];
  for (const name of MEMBER_TSCONFIGS) {
    const file = join(memberDir, name);
    const where = `${label}: ${name}`;
    if (!existsSync(file)) {
      problems.push(`${where} is missing`);
      continue;
    }
    const { value, error } = readJsonc(file);
    if (error !== undefined || !isObject(value)) {
      problems.push(`${where} is not valid: ${error ?? 'expected an object'}`);
      continue;
    }
    if (value['extends'] !== BASE_TSCONFIG) {
      problems.push(`${where} must extend exactly "${BASE_TSCONFIG}"`);
    }
    const options = value['compilerOptions'] ?? {};
    if (!isObject(options)) {
      problems.push(`${where}: compilerOptions must be an object`);
      continue;
    }
    for (const key of Object.keys(options)) {
      if (!MEMBER_COMPILER_OPTIONS.includes(key)) {
        problems.push(
          `${where} must not set compilerOptions.${key}; shared options live in tsconfig.base.json`,
        );
      }
    }
    if (name === 'tsconfig.build.json' && options['noEmit'] !== undefined) {
      problems.push(`${where} must not set noEmit; the build has to emit`);
    }
  }
  return problems;
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

function scriptsProblems(manifestDir: string, label: string): string[] {
  const problems: string[] = [];
  const pkg = JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8')) as PackageJson;
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
  return problems;
}

// Every folder that holds a package.json under `dir`, at any depth. Symlinks
// are reported, not followed, so nothing can hide behind one.
function findManifests(root: string, dir: string, found: string[], problems: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      problems.push(`${relative(root, path)}: symlinks are not allowed in workspace folders`);
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (existsSync(join(path, 'package.json'))) found.push(path);
    findManifests(root, path, found, problems);
  }
}

export function checkWorkspace(root: string): string[] {
  const { globs, problems } = readWorkspaceGlobs(root);
  const memberDirs = new Set(listMembers(root, globs).map((m) => m.dir));
  const manifests: string[] = [];
  for (const dir of SCANNED_DIRS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    // Anything directly inside these folders that is not a package would
    // never be found by the gate.
    for (const entry of readdirSync(base).sort()) {
      if (IGNORED_FILES.has(entry)) continue;
      const path = join(base, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory()) {
        problems.push(`${relative(root, path)}: only package folders are allowed in ${dir}/`);
      } else if (!existsSync(join(path, 'package.json'))) {
        problems.push(`${relative(root, path)}: folder has no package.json`);
      }
    }
    findManifests(root, base, manifests, problems);
  }
  const names = new Map<string, string>();
  for (const manifestDir of manifests) {
    const path = relative(root, manifestDir);
    if (!memberDirs.has(manifestDir)) {
      problems.push(`${path}: has a package.json but is not a workspace member`);
      continue;
    }
    const pkg = JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8')) as PackageJson;
    if (typeof pkg.name !== 'string' || pkg.name === '') {
      problems.push(`${path}: package.json needs a name`);
    } else if (names.has(pkg.name)) {
      problems.push(`${path}: name "${pkg.name}" is also used by ${names.get(pkg.name) ?? ''}`);
    } else {
      names.set(pkg.name, path);
    }
    const label = pkg.name ?? path;
    if (readdirSync(manifestDir).some((entry) => NEXT_CONFIG.test(entry))) {
      problems.push(
        `${label}: Next.js apps are not built by the root gate yet; extend scripts/gate.ts first`,
      );
    }
    problems.push(...scriptsProblems(manifestDir, label));
    problems.push(...tsconfigProblems(manifestDir, label));
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkWorkspace(join(import.meta.dirname, '..'));
  if (problems.length > 0) {
    process.stderr.write(`Workspace check failed:\n  ${problems.join('\n  ')}\n`);
    process.exitCode = 1;
  }
}
