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
    // time. It is not code, and none of it is served to anyone. It reaches
    // this repository by two paths: the dashboard's framework, a production
    // dependency, and the component catalogue's documentation generator, a
    // development one. Where one of those two is not yet in this
    // repository's lockfile, it is the intended path rather than a current
    // one, so read the lockfile for which of them are present today. Neither
    // can drop caniuse-lite without dropping the tool it comes with.
    // CC-BY-4.0 permits commercial use and requires only attribution, which
    // THIRD_PARTY_NOTICES.md gives. The exception therefore covers both
    // scopes, which is intended rather than an oversight. Reviewed and
    // approved 2026-10-20. It must never widen to a path or name pattern,
    // and never to a second licence: any other CC-BY-4.0 package, and any
    // other licence on this one, still fails.
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

// SPDX identifiers this policy recognises. That is everything it allows,
// plus the ones it refuses by name: the GPL, LGPL and AGPL family, SSPL, the
// Business Source License, Elastic, and the Creative Commons attribution,
// share alike, non commercial and no derivatives licences.
//
// An identifier outside this set is not treated as a licence decision at
// all. It means the package's metadata is not telling us something we can
// act on, so its own licence files are read instead. Add an identifier here
// only when it is a real SPDX identifier, so that a vague string such as
// "BSD" keeps failing over to the files rather than being judged on its
// spelling. Listing an identifier here does not allow it; the allowlist
// above decides that.
const RECOGNISED_SPDX: ReadonlySet<string> = new Set([
  ...PROD_ALLOWED,
  ...FONT_LICENSES,
  'MPL-2.0',
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'SSPL-1.0',
  'BUSL-1.1',
  'Elastic-2.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-ND-4.0',
]);

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

// `packageName` matters only for font licenses in production; without it a
// font license is treated as coming from a non font package.
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

// Identifies a LICENSE file by its text. Deliberately narrow: each entry
// needs a phrase that only that licence uses, and the text must match exactly
// one entry. Zero matches or more than one means we cannot tell, and the
// caller fails rather than guessing. A licence missing from this table is not
// "allowed by default": it simply cannot be recognised from its text.
// Phrases that turn a permissive licence into something else. A text
// carrying one of these is never identified as the licence it is built on:
// the base phrases are all still present, so presence alone cannot tell them
// apart. Real npm packages carry every one of these.
//
// This list is a backstop against reviewer error, not a control, and it
// cannot be complete: a rider can always be paraphrased past it. A text that
// passes it is not thereby clean. What actually holds the line is
// PACKAGE_LICENSE_FROM_FILE below, which admits a package only at an exact
// version that a person has read, so a later version carrying a new rider
// fails on the version key rather than on anything matched here.
const ADDED_RESTRICTIONS: readonly RegExp[] = [
  /used for good,? not evil/,
  /commons clause/,
  /non-?commercial/,
  /all advertising materials mentioning features or use/,
  /without fee is hereby granted[^.]*provided that[^.]*not be used in advertising/,
];

const LICENSE_TEXTS: readonly { id: string; needs: RegExp[]; rejects?: RegExp[] }[] = [
  {
    id: 'MIT',
    needs: [/permission is hereby granted, free of charge/],
  },
  {
    id: 'ISC',
    needs: [
      /permission to use, copy, modify,? and\/or distribute this software for any purpose/,
      /copyright notice and this permission notice appear in all copies/,
    ],
  },
  {
    id: 'Apache-2.0',
    needs: [/apache license/, /version 2\.0/],
  },
  {
    // The two clause form: redistribution conditions without the third, no
    // endorsement, clause.
    id: 'BSD-2-Clause',
    needs: [
      /redistribution and use in source and binary forms/,
      /redistributions in binary form must reproduce/,
    ],
    rejects: [/endorse or promote/],
  },
  {
    id: 'BSD-3-Clause',
    needs: [
      /redistribution and use in source and binary forms/,
      /redistributions in binary form must reproduce/,
      /endorse or promote/,
    ],
  },
  {
    id: 'GPL-3.0',
    needs: [/gnu general public license/, /version 3/],
    rejects: [/affero/, /lesser/],
  },
  {
    id: 'AGPL-3.0',
    needs: [/gnu affero general public license/],
  },
  {
    id: 'LGPL-3.0',
    needs: [/gnu lesser general public license/, /version 3/],
  },
];

/**
 * The SPDX identifier a LICENSE file clearly carries, or undefined when the
 * text matches none or several. Never guesses.
 */
export function identifyLicenseText(text: string): string | undefined {
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalised === '') return undefined;
  if (ADDED_RESTRICTIONS.some((pattern) => pattern.test(normalised))) return undefined;
  const matches = LICENSE_TEXTS.filter(
    (entry) =>
      entry.needs.every((pattern) => pattern.test(normalised)) &&
      !(entry.rejects ?? []).some((pattern) => pattern.test(normalised)),
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
}

// True when every identifier in the expression is one this policy recognises,
// so its verdict can be trusted without reading the package's own files.
function allIdentifiersRecognised(node: Node): boolean {
  switch (node.kind) {
    case 'id':
      return RECOGNISED_SPDX.has(node.value);
    // A WITH clause is a recognised construct, so it is judged here and
    // blocked by the allowlist, which admits no exception. Treating it as
    // unrecognised would send a copyleft licence with an exception to the
    // file reader, where a second licence file could answer for it.
    case 'with':
      return true;
    case 'and':
    case 'or':
      return allIdentifiersRecognised(node.left) && allIdentifiersRecognised(node.right);
  }
}

/**
 * The LICENSE text, or a function returning it. A function is only called
 * when the metadata licence turns out to be unusable, so a clean tree never
 * touches the file system.
 */
/**
 * Packages whose metadata licence is not a recognised SPDX expression and
 * whose real licence a maintainer has read and agreed. The map decides. The
 * package's own LICENSE file is the evidence a reviewer checks it against,
 * and must still agree, so a package that adds a restriction in a later
 * version fails rather than inheriting this entry. Keyed by name and exact
 * version for the same reason.
 *
 * Nothing resolves from file text alone: identifying a licence by the
 * phrases it contains cannot tell a licence from the same licence with a
 * restriction bolted on, and both carry every phrase of the permissive base.
 */
export const PACKAGE_LICENSE_FROM_FILE: ReadonlyMap<string, string> = new Map([
  // parse-cache-control's package.json uses the old
  // `licenses: [{ type: "BSD" }]` array, and "BSD" is not an SPDX
  // identifier. Its LICENSE file is the three clause BSD text, copyright
  // Walmart and other contributors, carrying the no endorsement clause and
  // no advertising clause. Development only, through @lhci/cli.
  // Reviewed and approved 2026-10-20.
  ['parse-cache-control@1.0.1', 'BSD-3-Clause'],
]);

export interface PackageRef {
  name: string;
  version: string;
}

/**
 * Every licence file the package ships, or a function returning them. A
 * function is only called when the metadata licence turns out to be
 * unusable, so a clean tree never touches the file system. All of them are
 * read: taking the first filename found would let the order of LICENSE,
 * COPYING and the rest decide which licence a package is published under.
 */
export type LicenseTextSource = readonly string[] | (() => readonly string[]);

export type ResolvedLicense =
  | { license: string; fromFile: boolean; problem?: undefined }
  | { license?: undefined; fromFile?: undefined; problem: string };

/**
 * The licence to judge a package by. Normally the string in its metadata.
 * When that is not an SPDX expression this policy recognises, such as the
 * old `licenses: [{ type: "BSD" }]` form, the package must appear in
 * PACKAGE_LICENSE_FROM_FILE, and its own LICENSE text must still read as the
 * licence recorded there. A package with no licence at all is never rescued
 * by its files, and an unreviewed package never resolves on its text alone.
 */
export function resolveLicense(
  pkg: PackageRef,
  metadata: string,
  licenseTexts: LicenseTextSource,
): ResolvedLicense {
  const value = metadata.trim();
  if (MISSING.has(value.toLowerCase()) || /^see license in /i.test(value)) {
    return { problem: value === '' ? 'no license' : `no usable license ("${value}")` };
  }
  let recognised = false;
  try {
    recognised = allIdentifiersRecognised(parseSpdx(value));
  } catch (error) {
    if (!(error instanceof SpdxSyntaxError)) throw error;
  }
  if (recognised) return { license: value, fromFile: false };

  const key = `${pkg.name}@${pkg.version}`;
  const prefix = `license "${value}" is not an SPDX expression`;
  const reviewed = PACKAGE_LICENSE_FROM_FILE.get(key);
  if (reviewed === undefined) {
    return {
      problem: `${prefix} and ${key} is not in the reviewed license map; read its LICENSE file and add it only once a maintainer agrees`,
    };
  }
  const texts = typeof licenseTexts === 'function' ? licenseTexts() : licenseTexts;
  if (texts.length === 0) {
    return {
      problem: `${prefix}; ${key} is reviewed as "${reviewed}" but ships no LICENSE file to check that against`,
    };
  }
  const identified = texts.map((text) => identifyLicenseText(text));
  if (identified.some((id) => id === undefined)) {
    return {
      problem: `${prefix}; ${key} is reviewed as "${reviewed}" but ships a license file this policy cannot identify`,
    };
  }
  const distinct = [...new Set(identified)];
  if (distinct.length > 1) {
    return {
      problem: `${prefix}; ${key} ships license files that disagree: ${distinct.join(', ')}`,
    };
  }
  if (distinct[0] !== reviewed) {
    return {
      problem: `${prefix}; ${key} is reviewed as "${reviewed}" but its LICENSE file reads as "${String(distinct[0])}"`,
    };
  }
  return { license: reviewed, fromFile: true };
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
  // True when the licence came from reading the package's own licence file
  // rather than from the licence it declares. Marked in the table, because a
  // reader of a legal document should be able to tell the two apart.
  fromFile?: boolean;
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
    const license = e.fromFile === true ? `${e.license} (read from file)` : e.license;
    rows.push(
      `| ${cell(e.name)} | ${cell(e.version)} | ${cell(license)} | ${cell(e.repository ?? '')} |`,
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
