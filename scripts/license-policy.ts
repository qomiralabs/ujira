// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Pure parts of the dependency license check: SPDX expression evaluation, the
// allowlist decision per package and rendering of THIRD_PARTY_NOTICES.md. No
// file system or process access here, so everything is testable from fixtures.

export type Scope = 'prod' | 'dev';

export const PROD_ALLOWED: ReadonlySet<string> = new Set([
  'MIT',
  // MIT without the attribution requirement, so strictly more permissive.
  'MIT-0',
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
]);

// Licenses accepted in production only for the font packages listed below.
export const FONT_LICENSES: ReadonlySet<string> = new Set(['OFL-1.1']);

// Production packages allowed to use a font license. Adding a package here
// needs a license review: confirm it ships font files only, not code.
export const PROD_FONT_PACKAGES: ReadonlySet<string> = new Set<string>([]);

// Licenses allowed for one named package and nothing else. Every entry is a
// standing decision by the maintainer, recorded here with its reason and
// date. Keep this list short, and never widen an entry to a pattern: the
// point is that the exception cannot spread to the next package that happens
// to carry the same license.
export const PACKAGE_LICENSE_EXCEPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    // caniuse-lite is browser support data that browserslist reads at build
    // time. It is not code, and none of it reaches a browser. CC-BY-4.0
    // permits commercial use and asks only for attribution, which
    // THIRD_PARTY_NOTICES.md already gives. It arrives as a transitive
    // dependency of Next.js and cannot be removed without removing Next.js.
    // Reviewed and approved 2026-10-20. Any other CC-BY-4.0 package still fails.
    'caniuse-lite',
    new Set(['CC-BY-4.0']),
  ],
]);

// Dev dependencies never ship, so font licenses are not restricted there.
export const DEV_ALLOWED: ReadonlySet<string> = new Set([
  ...PROD_ALLOWED,
  ...FONT_LICENSES,
  'MPL-2.0',
]);

const PROD_FONT_ALLOWED: ReadonlySet<string> = new Set([...PROD_ALLOWED, ...FONT_LICENSES]);

export function allowlistFor(scope: Scope, packageName?: string): ReadonlySet<string> {
  const base =
    scope === 'dev'
      ? DEV_ALLOWED
      : packageName !== undefined && PROD_FONT_PACKAGES.has(packageName)
        ? PROD_FONT_ALLOWED
        : PROD_ALLOWED;
  const exception =
    packageName === undefined ? undefined : PACKAGE_LICENSE_EXCEPTIONS.get(packageName);
  return exception === undefined ? base : new Set([...base, ...exception]);
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
      // Case sensitive on purpose: SPDX identifiers have one canonical
      // spelling, and "mit" or "Apache 2.0" fail closed until someone reviews
      // the package. Do not relax this without a license review.
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

// `packageName` decides whether a per package allowance applies: a font
// license in production, or an entry in PACKAGE_LICENSE_EXCEPTIONS. Without
// it, the license is judged as if it came from a package with no allowance,
// which is the stricter reading.
export function evaluateLicense(license: string, scope: Scope, packageName?: string): Decision {
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
  const blocked = blockers(tree, allowlistFor(scope, packageName));
  if (blocked.length === 0) return { ok: true };
  const fontHint = blocked.some((id) => FONT_LICENSES.has(id))
    ? ' (font licenses are allowed in production only for packages in PROD_FONT_PACKAGES)'
    : '';
  return {
    ok: false,
    reason: `${blocked.map((id) => `"${id}"`).join(', ')} not allowed in ${scope} dependencies${fontHint}`,
  };
}

export interface Violation {
  name: string;
  version: string;
  license: string;
  scope: Scope;
  reason: string;
}

export interface ScopedLicense {
  name: string;
  version: string;
  license: string;
  scope: Scope;
}

export function findViolations(packages: readonly ScopedLicense[]): Violation[] {
  const violations: Violation[] = [];
  for (const pkg of packages) {
    const decision = evaluateLicense(pkg.license, pkg.scope, pkg.name);
    if (!decision.ok) violations.push({ ...pkg, reason: decision.reason });
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
  return sanitizeUrl(url);
}

// Drops `user:password@` from a URL so tokens in a manifest never reach the
// notices file.
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '') return undefined;
  return url.trim().replace(/^([a-z][\w+.-]*:\/\/)[^/?#]*@/i, '$1');
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

// A file or group of files that does not come from npm, from
// assets.licenses.json.
export interface AssetNotice {
  path: string;
  files: number;
  license: string;
  copyright: string;
  source: string;
  added: string;
}

function assetTable(assets: readonly AssetNotice[]): string[] {
  if (assets.length === 0) return ['None.'];
  const rows = [
    '| Asset | Files | License | Copyright | Source | Added |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const a of [...assets].sort((x, y) => compareStrings(x.path, y.path))) {
    rows.push(
      `| ${cell(a.path)} | ${String(a.files)} | ${cell(a.license)} | ${cell(a.copyright)} | ${cell(a.source)} | ${cell(a.added)} |`,
    );
  }
  return rows;
}

export interface NoticeSections {
  prod: readonly NoticeEntry[];
  dev: readonly NoticeEntry[];
  platformProd: readonly NoticeEntry[];
  platformDev: readonly NoticeEntry[];
  assets: readonly AssetNotice[];
}

export function renderNotices(sections: NoticeSections): string {
  return [
    '# Third party notices',
    '',
    'This file is generated by `pnpm licenses:check`. Do not edit it by hand.',
    '',
    'UJIRA uses the open source packages and assets listed below under the licenses shown.',
    '',
    '## Production dependencies',
    '',
    ...table(sections.prod),
    '',
    '## Production platform specific packages',
    '',
    'Builds that declare `os`, `cpu` or `libc` and are installed only on matching platforms. Their',
    'licenses come from the reviewed map in `scripts/platform-licenses.json`, so this file is the same',
    'on every platform.',
    '',
    ...table(sections.platformProd),
    '',
    '## Development dependencies',
    '',
    'Used to build and test UJIRA. They are not shipped.',
    '',
    ...table(sections.dev),
    '',
    '## Development platform specific packages',
    '',
    ...table(sections.platformDev),
    '',
    '## Assets',
    '',
    'Files that do not come from npm, from `assets.licenses.json`.',
    '',
    ...assetTable(sections.assets),
    '',
  ].join('\n');
}
