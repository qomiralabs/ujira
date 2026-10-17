// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Pure parts of the dependency license check: SPDX expression evaluation, the
// allowlist decision per package and rendering of THIRD_PARTY_NOTICES.md. No
// file system or process access here, so everything is testable from fixtures.

export type Scope = 'prod' | 'dev';

export const PROD_ALLOWED: ReadonlySet<string> = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Zlib',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  // Fonts only in practice, but the license itself permits commercial use.
  'OFL-1.1',
]);

export const DEV_ALLOWED: ReadonlySet<string> = new Set([...PROD_ALLOWED, 'MPL-2.0']);

export function allowlistFor(scope: Scope): ReadonlySet<string> {
  return scope === 'prod' ? PROD_ALLOWED : DEV_ALLOWED;
}

// One entry of `pnpm licenses list --json`, grouped under its license key.
export interface PnpmLicenseEntry {
  name: string;
  versions: string[];
  paths: string[];
  license?: string;
  homepage?: string;
}

export type PnpmLicensesJson = Record<string, PnpmLicenseEntry[]>;

// One installed package version, flattened out of the pnpm output.
export interface InstalledPackage {
  name: string;
  version: string;
  license: string;
  path: string;
  homepage: string | undefined;
}

export function flattenPnpmLicenses(json: PnpmLicensesJson): InstalledPackage[] {
  const out: InstalledPackage[] = [];
  for (const [key, entries] of Object.entries(json)) {
    for (const entry of entries) {
      entry.versions.forEach((version, i) => {
        out.push({
          name: entry.name,
          version,
          // pnpm groups by the license it read; prefer the entry field when present.
          license: (entry.license ?? key).trim(),
          path: entry.paths[i] ?? entry.paths[0] ?? '',
          homepage: entry.homepage,
        });
      });
    }
  }
  return out;
}

// SPDX expression evaluation. Precedence follows the SPDX spec: WITH binds
// tightest, then AND, then OR. An expression passes when it can be satisfied
// using allowed identifiers only.

type Token =
  | { kind: 'id'; value: string }
  | { kind: 'op'; value: 'AND' | 'OR' | 'WITH' }
  | { kind: '(' }
  | { kind: ')' };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  for (const raw of expression.replace(/([()])/g, ' $1 ').split(/\s+/)) {
    if (raw === '') continue;
    if (raw === '(' || raw === ')') tokens.push({ kind: raw });
    else if (raw === 'AND' || raw === 'OR' || raw === 'WITH')
      tokens.push({ kind: 'op', value: raw });
    else tokens.push({ kind: 'id', value: raw });
  }
  return tokens;
}

export class SpdxSyntaxError extends Error {}

type Node =
  | { kind: 'id'; value: string }
  | { kind: 'with'; license: string; exception: string }
  | { kind: 'and' | 'or'; left: Node; right: Node };

export function parseSpdx(expression: string): Node {
  const tokens = tokenize(expression);
  let pos = 0;

  const fail = (message: string): never => {
    throw new SpdxSyntaxError(`invalid SPDX expression "${expression}": ${message}`);
  };

  const parseOr = (): Node => {
    let left = parseAnd();
    for (let t = tokens[pos]; t?.kind === 'op' && t.value === 'OR'; t = tokens[pos]) {
      pos++;
      left = { kind: 'or', left, right: parseAnd() };
    }
    return left;
  };

  const parseAnd = (): Node => {
    let left = parseAtom();
    for (let t = tokens[pos]; t?.kind === 'op' && t.value === 'AND'; t = tokens[pos]) {
      pos++;
      left = { kind: 'and', left, right: parseAtom() };
    }
    return left;
  };

  const parseAtom = (): Node => {
    const token = tokens[pos++];
    if (!token) return fail('unexpected end');
    if (token.kind === '(') {
      const inner = parseOr();
      if (tokens[pos++]?.kind !== ')') fail('missing ")"');
      return inner;
    }
    if (token.kind !== 'id') return fail(`unexpected "${token.kind === 'op' ? token.value : ')'}"`);
    const next = tokens[pos];
    if (next?.kind === 'op' && next.value === 'WITH') {
      pos++;
      const exception = tokens[pos++];
      if (exception?.kind !== 'id') return fail('WITH needs an exception identifier');
      return { kind: 'with', license: token.value, exception: exception.value };
    }
    return { kind: 'id', value: token.value };
  };

  const tree = parseOr();
  if (pos !== tokens.length) fail('trailing tokens');
  return tree;
}

// The identifiers that block an expression, or an empty list when it passes.
// For OR the branch with fewer blockers is reported, so the message points at
// what would have to change.
function blockers(node: Node, allowed: ReadonlySet<string>): string[] {
  switch (node.kind) {
    case 'id':
      return allowed.has(node.value) ? [] : [node.value];
    case 'with':
      // No exceptions have been reviewed yet, so any WITH clause blocks.
      return [`${node.license} WITH ${node.exception}`];
    case 'and':
      return [...blockers(node.left, allowed), ...blockers(node.right, allowed)];
    case 'or': {
      const left = blockers(node.left, allowed);
      if (left.length === 0) return left;
      const right = blockers(node.right, allowed);
      if (right.length === 0) return right;
      return left.length <= right.length ? left : right;
    }
  }
}

// Values that mean there is no usable license at all.
const MISSING = new Set([
  '',
  'unknown',
  'unlicensed',
  'none',
  'see license in license',
  'proprietary',
]);

export type Decision = { ok: true } | { ok: false; reason: string };

export function evaluateLicense(license: string, scope: Scope): Decision {
  const value = license.trim();
  if (MISSING.has(value.toLowerCase()) || /^see license in /i.test(value)) {
    return { ok: false, reason: value === '' ? 'no license' : `no usable license ("${value}")` };
  }
  let tree: Node;
  try {
    tree = parseSpdx(value);
  } catch (error) {
    if (error instanceof SpdxSyntaxError) return { ok: false, reason: error.message };
    throw error;
  }
  const blocked = blockers(tree, allowlistFor(scope));
  if (blocked.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `${blocked.map((id) => `"${id}"`).join(', ')} not allowed in ${scope} dependencies`,
  };
}

export interface Violation {
  name: string;
  version: string;
  license: string;
  scope: Scope;
  reason: string;
}

// Workspace packages are ours and UNLICENSED by design. A package only counts
// as one when its name is a workspace name and it is not installed from the
// registry, so a third party package cannot borrow a workspace name to pass.
export function isWorkspacePackage(
  pkg: InstalledPackage,
  workspaceNames: ReadonlySet<string>,
): boolean {
  return workspaceNames.has(pkg.name) && !pkg.path.split(/[\\/]/).includes('node_modules');
}

export function findViolations(
  packages: readonly InstalledPackage[],
  scope: Scope,
  workspaceNames: ReadonlySet<string>,
): Violation[] {
  const violations: Violation[] = [];
  for (const pkg of packages) {
    if (isWorkspacePackage(pkg, workspaceNames)) continue;
    const decision = evaluateLicense(pkg.license, scope);
    if (!decision.ok) {
      violations.push({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        scope,
        reason: decision.reason,
      });
    }
  }
  return sortBy(violations);
}

export function formatViolation(v: Violation): string {
  return `${v.name}@${v.version} (${v.scope}): license "${v.license}": ${v.reason}`;
}

// Turns a package.json `repository` field into a browsable https URL.
export function normalizeRepository(repository: unknown): string | undefined {
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' &&
          repository !== null &&
          'url' in repository &&
          typeof repository.url === 'string'
        ? repository.url
        : undefined;
  if (raw === undefined || raw.trim() === '') return undefined;
  let url = raw.trim();
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/.exec(url);
  if (shorthand?.[1] && shorthand[2]) {
    url = `https://${shorthand[1]}.${shorthand[1] === 'bitbucket' ? 'org' : 'com'}/${shorthand[2]}`;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    url = `https://github.com/${url}`;
  }
  url = url
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^(?:git|ssh|http):\/\/(?:git@)?/, 'https://')
    .replace(/^https:\/\/git@/, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return url;
}

export interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  repository: string | undefined;
}

function sortBy<T extends { name: string; version: string }>(items: T[]): T[] {
  return items.sort((a, b) =>
    a.name === b.name ? compareStrings(a.version, b.version) : compareStrings(a.name, b.name),
  );
}

// Locale independent so the output is byte identical on every machine.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

function table(entries: readonly NoticeEntry[]): string[] {
  if (entries.length === 0) return ['None.'];
  const rows = ['| Package | Version | License | Repository |', '| --- | --- | --- | --- |'];
  const seen = new Set<string>();
  for (const e of sortBy([...entries])) {
    const key = `${e.name}@${e.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(
      `| ${cell(e.name)} | ${cell(e.version)} | ${cell(e.license)} | ${cell(e.repository ?? '')} |`,
    );
  }
  return rows;
}

export function renderNotices(prod: readonly NoticeEntry[], dev: readonly NoticeEntry[]): string {
  return [
    '# Third party notices',
    '',
    'This file is generated by `pnpm licenses:check`. Do not edit it by hand.',
    '',
    'UJIRA uses the open source packages listed below under the licenses shown. Platform specific',
    'binary builds of a listed package (packages that declare `os`, `cpu` or `libc`) are covered by',
    'the entry of the package they belong to and are not listed separately, so this file is the same',
    'on every platform.',
    '',
    '## Production dependencies',
    '',
    ...table(prod),
    '',
    '## Development dependencies',
    '',
    'Used to build and test UJIRA. They are not shipped.',
    '',
    ...table(dev),
    '',
  ].join('\n');
}
