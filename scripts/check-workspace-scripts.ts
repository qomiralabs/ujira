// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Structure check for the workspace. The root gate (`pnpm lint`,
// `pnpm typecheck`, `pnpm build`) runs fixed commands over every member and
// never runs package scripts, but it relies on every member being found and
// on member tsconfig files not weakening the shared compiler options. This
// check enforces both, and keeps package scripts to plain tool commands so
// running them by hand behaves like the gate.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { resolvePnpmCommand } from './pnpm-command.ts';
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
  // Only together with noEmit, since tsc cannot emit such imports.
  'allowImportingTsExtensions',
];
// Top level keys a member tsconfig may set. `references` would pull other
// projects into a build, so it is not one of them.
const MEMBER_TSCONFIG_KEYS = new Set([
  '$schema',
  'extends',
  'compilerOptions',
  'include',
  'exclude',
  'files',
]);
const PATH_LISTS = ['include', 'exclude', 'files'];
// The only output folder a member may write to. CI also fails if a gate step
// changes anything git tracks or a new unignored file appears.
const OUT_DIR = 'dist';
// Scripts that pnpm runs during install, before any gate step.
export const LIFECYCLE_SCRIPTS: readonly string[] = [
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
  'prepublish',
  'pnpm:devPreinstall',
];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
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

// True when `entry`, read relative to `dir` the way tsc reads it, cannot
// point outside `dir`. Absolute paths, drive letters and backslashes are
// rejected outright.
function staysInside(dir: string, entry: string): boolean {
  if (entry === '' || isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.includes('\\')) {
    return false;
  }
  const target = resolve(dir, entry);
  return target === dir || target.startsWith(dir + sep);
}

function isOutDir(outDir: string): boolean {
  return !isAbsolute(outDir) && posix.normalize(outDir).replace(/\/+$/, '') === OUT_DIR;
}

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function lifecycleProblems(scripts: Record<string, unknown>, label: string): string[] {
  return Object.keys(scripts)
    .filter((name) => LIFECYCLE_SCRIPTS.includes(name))
    .sort()
    .map(
      (name) =>
        `${label}: must not define a "${name}" script; install time scripts run before the gate`,
    );
}

// A member is a Next.js app when it depends on next or has a next.config.
function usesNext(manifest: Record<string, unknown>, dir: string): boolean {
  const declared = DEPENDENCY_FIELDS.some((field) => {
    const deps = manifest[field];
    return isObject(deps) && Object.hasOwn(deps, 'next');
  });
  return declared || readdirSync(dir).some((entry) => NEXT_CONFIG.test(entry));
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
    for (const key of Object.keys(value)) {
      if (!MEMBER_TSCONFIG_KEYS.has(key)) problems.push(`${where} must not set ${key}`);
    }
    for (const key of PATH_LISTS) {
      const list = value[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) {
        problems.push(`${where} ${key} must be an array of strings`);
        continue;
      }
      for (const entry of list) {
        if (!staysInside(memberDir, entry)) {
          problems.push(`${where} ${key} entry "${entry}" must stay inside the member folder`);
        }
      }
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
    const { rootDir, outDir } = options;
    if (
      rootDir !== undefined &&
      (typeof rootDir !== 'string' || !staysInside(memberDir, rootDir))
    ) {
      problems.push(
        `${where} compilerOptions.rootDir must stay inside the member folder, found "${show(rootDir)}"`,
      );
    }
    if (outDir !== undefined && (typeof outDir !== 'string' || !isOutDir(outDir))) {
      problems.push(
        `${where} compilerOptions.outDir must be "${OUT_DIR}", found "${show(outDir)}"`,
      );
    }
    if (name === 'tsconfig.build.json' && options['noEmit'] !== undefined) {
      problems.push(`${where} must not set noEmit; the build has to emit`);
    }
    if (options['allowImportingTsExtensions'] !== undefined && options['noEmit'] !== true) {
      problems.push(`${where} may set allowImportingTsExtensions only together with noEmit: true`);
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

export interface CheckOptions {
  // Member paths relative to the root as pnpm sees them. When given, they
  // must match the members the checks find.
  pnpmMembers?: readonly string[];
}

export function checkWorkspace(root: string, options: CheckOptions = {}): string[] {
  const { globs, problems } = readWorkspaceGlobs(root);
  const members = listMembers(root, globs);
  const memberDirs = new Set(members.map((m) => m.dir));
  const rootManifest = join(root, 'package.json');
  if (existsSync(rootManifest)) {
    const rootPkg = JSON.parse(readFileSync(rootManifest, 'utf8')) as { scripts?: unknown };
    if (isObject(rootPkg.scripts)) {
      problems.push(...lifecycleProblems(rootPkg.scripts, 'package.json'));
    }
  }
  if (options.pnpmMembers !== undefined) {
    const ours = new Set(members.map((m) => m.path));
    const theirs = new Set(options.pnpmMembers);
    for (const path of [...theirs].sort()) {
      if (!ours.has(path)) {
        problems.push(
          `${path}: pnpm treats this folder as a workspace member, but the checks do not`,
        );
      }
    }
    for (const path of [...ours].sort()) {
      if (!theirs.has(path)) {
        problems.push(
          `${path}: the checks treat this folder as a workspace member, but pnpm does not`,
        );
      }
    }
  }
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
    problems.push(...lifecycleProblems(pkg.scripts ?? {}, label));
    if (usesNext(pkg as Record<string, unknown>, manifestDir)) {
      problems.push(
        `${label}: Next.js apps are not built by the root gate yet; extend scripts/gate.ts first`,
      );
    }
    problems.push(...scriptsProblems(manifestDir, label));
    problems.push(...tsconfigProblems(manifestDir, label));
  }
  return problems;
}

// Member folders as pnpm resolves them, relative to the root. pnpm is run
// from npm_execpath, never looked up on PATH.
function pnpmMembers(root: string): string[] {
  const realpath = (path: string): string | undefined => {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  };
  const command = resolvePnpmCommand(
    process.env['npm_execpath'],
    process.execPath,
    root,
    ['ls', '-r', '--json', '--depth', '-1'],
    {
      realpath,
      packageName: (dir) => {
        const file = join(dir, 'package.json');
        if (!existsSync(file)) return undefined;
        const name = (JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }).name;
        return typeof name === 'string' ? name : undefined;
      },
    },
  );
  const out = execFileSync(command.file, command.args, { cwd: root, encoding: 'utf8' });
  const projects = JSON.parse(out) as { path?: unknown }[];
  const realRoot = realpathSync(root);
  return projects
    .map((project) =>
      typeof project.path === 'string'
        ? relative(realRoot, realpath(project.path) ?? project.path)
        : '',
    )
    .filter((path) => path !== '')
    .map((path) => path.split(sep).join('/'));
}

if (import.meta.main) {
  const root = join(import.meta.dirname, '..');
  let problems: string[];
  try {
    problems = checkWorkspace(root, { pnpmMembers: pnpmMembers(root) });
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  if (problems.length > 0) {
    process.stderr.write(`Workspace check failed:\n  ${problems.join('\n  ')}\n`);
    process.exitCode = 1;
  }
}
