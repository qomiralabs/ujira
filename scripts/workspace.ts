// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reads the workspace layout: the member globs in pnpm-workspace.yaml, the
// member folders they match and the order to build them in. Shared by the
// workspace check and the root gate so both see the same members.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

export const SCANNED_DIRS = ['packages', 'apps'];

export interface Member {
  // Absolute path of the member folder.
  dir: string;
  // Path relative to the root, with forward slashes.
  path: string;
  name: string;
  manifest: Record<string, unknown>;
}

const PLAIN_GLOB = /^[\w.-]+\/\*$/;

// Reads the `packages` list from pnpm-workspace.yaml with a YAML parser, so
// comments, quoting and flow sequences are read the way pnpm reads them. Only
// plain `<dir>/*` globs under the scanned folders are supported; anything
// else is reported so the checks are extended rather than silently matching
// the wrong folders.
export function readWorkspaceGlobs(root: string): { globs: string[]; problems: string[] } {
  const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  let doc: unknown;
  try {
    doc = parseYaml(text, { prettyErrors: false });
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    return { globs: [], problems: [`pnpm-workspace.yaml: invalid YAML: ${message}`] };
  }
  const packages =
    typeof doc === 'object' && doc !== null
      ? (doc as Record<string, unknown>)['packages']
      : undefined;
  if (
    packages === undefined ||
    packages === null ||
    (Array.isArray(packages) && packages.length === 0)
  ) {
    return { globs: [], problems: ['pnpm-workspace.yaml: no entries found under "packages:"'] };
  }
  if (!Array.isArray(packages) || !packages.every((item) => typeof item === 'string')) {
    return { globs: [], problems: ['pnpm-workspace.yaml: "packages" must be a list of strings'] };
  }
  const globs = packages;
  const problems: string[] = [];
  for (const glob of globs) {
    if (!PLAIN_GLOB.test(glob)) {
      problems.push(`pnpm-workspace.yaml: unsupported glob "${glob}", expected the form "<dir>/*"`);
    }
    if (!SCANNED_DIRS.includes(glob.slice(0, -'/*'.length))) {
      problems.push(
        `pnpm-workspace.yaml: "${glob}" is outside ${SCANNED_DIRS.join(' and ')}, which the checks scan`,
      );
    }
  }
  return { globs, problems };
}

// Every folder directly under a glob's directory that has a package.json.
// Structure problems (loose files, folders without a manifest, symlinks) are
// reported by the workspace check, not here.
export function listMembers(root: string, globs: readonly string[]): Member[] {
  const members: Member[] = [];
  for (const glob of globs) {
    // Unsupported globs are reported by readWorkspaceGlobs and match nothing.
    if (!PLAIN_GLOB.test(glob)) continue;
    const base = glob.slice(0, -'/*'.length);
    const baseDir = join(root, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir).sort()) {
      const dir = join(baseDir, entry);
      const file = join(dir, 'package.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const name = typeof manifest['name'] === 'string' ? manifest['name'] : `${base}/${entry}`;
      members.push({ dir, path: `${base}/${entry}`, name, manifest });
    }
  }
  return members;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const NEXT_CONFIG = /^next\.config\.(?:js|mjs|cjs|ts|mts)$/;

// A member is a Next.js app when it declares next in any dependency field or
// has a next.config file. The gate builds these with next build instead of tsc.
export function isNextApp(manifest: Record<string, unknown>, dir: string): boolean {
  const declared = DEPENDENCY_FIELDS.some((field) => {
    const deps = manifest[field];
    return typeof deps === 'object' && deps !== null && Object.hasOwn(deps, 'next');
  });
  return declared || (existsSync(dir) && readdirSync(dir).some((entry) => NEXT_CONFIG.test(entry)));
}

// Names of the other members this member depends on.
export function workspaceDependencies(member: Member, names: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = member.manifest[field];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const name of Object.keys(deps)) {
      if (names.has(name) && name !== member.name) found.add(name);
    }
  }
  return [...found].sort();
}

// Members ordered so each comes after the members it depends on. Ties keep
// path order, so the result is the same on every run. Throws on a cycle.
export function buildOrder(members: readonly Member[]): Member[] {
  const byName = new Map(members.map((m) => [m.name, m]));
  const names = new Set(byName.keys());
  const ordered: Member[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (member: Member, trail: string[]): void => {
    const seen = state.get(member.name);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw new Error(`workspace dependency cycle: ${[...trail, member.name].join(' -> ')}`);
    }
    state.set(member.name, 'visiting');
    for (const dep of workspaceDependencies(member, names)) {
      const next = byName.get(dep);
      if (next) visit(next, [...trail, member.name]);
    }
    state.set(member.name, 'done');
    ordered.push(member);
  };
  for (const member of [...members].sort((a, b) => (a.path < b.path ? -1 : 1))) visit(member, []);
  return ordered;
}

// Test settings the root config may set for one member. Kept to the fields a
// member actually needs, so the root config stays the only place they live.
export interface MemberTestSettings {
  include?: string[];
  environment?: string;
  setupFiles?: string[];
  // Run once for the whole project, before any of its test files. The
  // database member starts one Postgres here and migrates a template that
  // every test file is cloned from.
  globalSetup?: string[];
  hookTimeout?: number;
  testTimeout?: number;
}

export interface TestProject {
  test: { name: string; root: string; include: string[] } & Omit<MemberTestSettings, 'include'>;
}

// Vitest projects for every member, defined here instead of loaded from the
// members' own vitest.config files. Vitest only reads a member config when a
// project points at it, so with inline projects member code cannot change
// what `pnpm test` runs. `settings` holds per member overrides by package name.
export function testProjects(
  root: string,
  settings: Readonly<Record<string, MemberTestSettings>> = {},
): TestProject[] {
  const { globs, problems } = readWorkspaceGlobs(root);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const members = listMembers(root, globs);
  const names = new Set(members.map((m) => m.name));
  for (const name of Object.keys(settings)) {
    if (!names.has(name)) {
      throw new Error(
        `vitest.config.ts has test settings for "${name}", which is not a workspace member`,
      );
    }
  }
  return members.map((member) => ({
    test: {
      name: member.name,
      root: member.dir,
      include: ['src/**/*.test.ts'],
      ...settings[member.name],
    },
  }));
}

// The tsconfig files the type-aware lint uses: the root one and one per
// member. Given to ESLint as an explicit list, so a tsconfig anywhere else in
// the tree can never change the types lint sees for a file.
export function lintProjects(root: string): string[] {
  const { globs, problems } = readWorkspaceGlobs(root);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return ['./tsconfig.json', ...listMembers(root, globs).map((m) => `./${m.path}/tsconfig.json`)];
}
