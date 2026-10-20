// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseLockfile } from './lockfile.ts';
import { formatViolation } from './license-policy.ts';
import {
  checkTree,
  ListingError,
  parsePlatformMap,
  parsePnpmListing,
  resolveListing,
  versionMatches,
  type Manifest,
  type ManifestInspector,
  type PlatformLicense,
  type TreeInputs,
  type WorkspaceProject,
} from './license-tree.ts';

const LOCKFILE = parseLockfile(
  readFileSync(join(import.meta.dirname, 'fixtures', 'pnpm-lock.workspace.yaml'), 'utf8'),
);

const store = (name: string, version: string): string =>
  `/repo/node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}`;

interface Listed {
  name: string;
  version: string;
  license: string;
  path?: string;
  homepage?: string;
}

const PROD: Listed[] = [
  { name: 'copyleft-lib', version: '1.0.0', license: 'MIT' },
  { name: 'string-width', version: '4.2.3', license: 'MIT' },
  { name: 'vendored', version: '1.5.0', license: 'BSD-3-Clause' },
];
const DEV: Listed[] = [
  { name: 'tool', version: '1.0.0', license: 'ISC' },
  { name: 'peer-lib', version: '2.0.0', license: 'MPL-2.0' },
  // Installed on this machine only; the linux build is not listed.
  { name: 'native-darwin-arm64', version: '3.0.0', license: 'MIT' },
];

const PLATFORM_MAP: PlatformLicense[] = [
  {
    name: 'native-darwin-arm64',
    versions: '3.0.0',
    license: 'MIT',
    source: 'https://github.com/x/native',
  },
  {
    name: 'native-linux-x64-musl',
    versions: '3.x',
    license: 'MIT',
    source: 'https://github.com/x/native',
  },
];

const WORKSPACES: WorkspaceProject[] = [
  {
    dir: '/repo',
    name: 'ujira',
    version: '0.0.0',
    manifest: { name: 'ujira', version: '0.0.0', devDependencies: { tool: '1.0.0' } },
  },
  {
    dir: '/repo/packages/core',
    name: '@ujira/core',
    version: '0.0.0',
    manifest: {
      name: '@ujira/core',
      version: '0.0.0',
      dependencies: { '@ujira/shared': 'workspace:*', 'copyleft-lib': '1.0.0' },
    },
  },
  {
    dir: '/repo/packages/shared',
    name: '@ujira/shared',
    version: '0.0.0',
    manifest: { name: '@ujira/shared', version: '0.0.0' },
  },
];

// Groups entries the way pnpm does: one key per license, one entry per name.
function listing(packages: readonly Listed[]): string {
  const groups: Record<
    string,
    { name: string; versions: string[]; paths: string[]; license: string; homepage?: string }[]
  > = {};
  for (const p of packages) {
    const group = (groups[p.license] ??= []);
    let entry = group.find((e) => e.name === p.name);
    if (entry === undefined) {
      entry = { name: p.name, versions: [], paths: [], license: p.license };
      if (p.homepage !== undefined) entry.homepage = p.homepage;
      group.push(entry);
    }
    entry.versions.push(p.version);
    entry.paths.push(p.path ?? store(p.name, p.version));
  }
  return JSON.stringify(groups);
}

function world(
  extra: Record<string, Manifest> = {},
  links: Record<string, string> = {},
  licenses: Record<string, readonly string[]> = {},
): ManifestInspector {
  const manifests: Record<string, Manifest> = {};
  for (const p of [...PROD, ...DEV]) {
    manifests[store(p.name, p.version)] = {
      name: p.name,
      version: p.version,
      repository: `x/${p.name}`,
    };
  }
  for (const w of WORKSPACES) manifests[w.dir] = w.manifest;
  Object.assign(manifests, extra);
  return {
    realpath: (path) => links[path] ?? (path in manifests ? path : undefined),
    manifest: (dir) => manifests[dir],
    licenseTexts: (dir) => licenses[dir] ?? [],
  };
}

function inputs(overrides: Partial<TreeInputs> = {}): TreeInputs {
  return {
    prodListing: listing(PROD),
    devListing: listing(DEV),
    lockfile: LOCKFILE,
    workspaces: WORKSPACES,
    platformMap: PLATFORM_MAP,
    inspector: world(),
    ...overrides,
  };
}

function report(overrides: Partial<TreeInputs> = {}): string[] {
  const result = checkTree(inputs(overrides));
  return [...result.problems, ...result.violations.map(formatViolation)];
}

describe('license-tree', () => {
  it('passes a clean tree and writes notices for every section', () => {
    const result = checkTree(inputs());
    expect(result.problems).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.checked).toBe(7);
    expect(result.notices).toContain(
      '| copyleft-lib | 1.0.0 | MIT | https://github.com/x/copyleft-lib |',
    );
    expect(result.notices).toContain(
      '| native-linux-x64-musl | 3.0.0 | MIT | https://github.com/x/native |',
    );
    const devPlatform = result.notices?.split('## Development platform specific packages')[1];
    expect(devPlatform).toContain('| native-darwin-arm64 | 3.0.0 | MIT |');
  });

  describe('metadata that is not a recognised SPDX expression', () => {
    // The old `licenses: [{ type: "BSD" }]` form, as parse-cache-control
    // uses. copyleft-lib is not in the reviewed license map, so nothing it
    // ships can answer for it.
    const vague = (): Listed[] =>
      PROD.map((p) => (p.name === 'copyleft-lib' ? { ...p, license: 'BSD' } : p));
    const dir = store('copyleft-lib', '1.0.0');

    const THREE_CLAUSE = `Copyright (c) 2012-2014, Walmart and other contributors.
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright notice.
    * Redistributions in binary form must reproduce the above copyright notice.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.`;

    it.each([
      ['a clean three clause BSD file', [THREE_CLAUSE]],
      ['a permissive file of another licence', ['Permission is hereby granted, free of charge']],
      ['no licence file at all', []],
      ['two licence files that disagree', [THREE_CLAUSE, 'GNU GENERAL PUBLIC LICENSE Version 3']],
    ])('fails an unreviewed package with %s', (_label, texts) => {
      expect(
        report({ prodListing: listing(vague()), inspector: world({}, {}, { [dir]: texts }) }),
      ).toEqual([
        'copyleft-lib@1.0.0: license "BSD" is not an SPDX expression and copyleft-lib@1.0.0 is not in the reviewed license map; read its LICENSE file and add it only once a maintainer agrees',
      ]);
    });

    it('reads no licence file when every package declares a licence we recognise', () => {
      const read: string[] = [];
      const base = world({}, {}, { [dir]: [THREE_CLAUSE] });
      const watched = {
        ...base,
        licenseTexts: (d: string) => {
          read.push(d);
          return base.licenseTexts(d);
        },
      };
      expect(report({ inspector: watched })).toEqual([]);
      expect(read).toEqual([]);
    });
  });

  it('rejects a GPL dependency declared by a workspace package', () => {
    const prod = PROD.map((p) => (p.name === 'copyleft-lib' ? { ...p, license: 'GPL-3.0' } : p));
    expect(report({ prodListing: listing(prod) })).toEqual([
      'copyleft-lib@1.0.0 (prod): license "GPL-3.0": "GPL-3.0" not allowed in prod dependencies',
    ]);
  });

  it('fails when a workspace dependency is missing from the listing', () => {
    // What a root only listing (no -r) looks like.
    const prod = PROD.filter((p) => p.name !== 'copyleft-lib');
    expect(report({ prodListing: listing(prod) })).toEqual([
      'copyleft-lib@1.0.0: in pnpm-lock.yaml but missing from pnpm licenses list',
    ]);
  });

  it('checks a dev listed package as production when the lockfile reaches it from production', () => {
    const prod = PROD.filter((p) => p.name !== 'string-width');
    const dev = [...DEV, { name: 'string-width', version: '4.2.3', license: 'MPL-2.0' }];
    expect(report({ prodListing: listing(prod), devListing: listing(dev) })).toEqual([
      'string-width@4.2.3 (prod): license "MPL-2.0": "MPL-2.0" not allowed in prod dependencies',
    ]);
  });

  it('fails when pnpm lists a package that is not in the lockfile', () => {
    const extra = { name: 'stray', version: '1.0.0', license: 'MIT' };
    const inspector = world({ [store('stray', '1.0.0')]: { name: 'stray', version: '1.0.0' } });
    expect(report({ prodListing: listing([...PROD, extra]), inspector })).toEqual([
      'stray@1.0.0: listed by pnpm but not in pnpm-lock.yaml',
    ]);
  });

  describe('workspace packages', () => {
    const gplCore = (versions: string[], paths: string[]): string =>
      JSON.stringify({
        ...JSON.parse(listing(PROD)),
        'GPL-3.0': [{ name: '@ujira/core', versions, paths, license: 'GPL-3.0' }],
      });

    it('skips a workspace project at its own folder', () => {
      expect(report({ prodListing: gplCore(['0.0.0'], ['/repo/packages/core']) })).toEqual([]);
    });

    it('follows a symlink to the workspace folder', () => {
      const inspector = world({}, { '/repo/node_modules/@ujira/core': '/repo/packages/core' });
      expect(
        report({ prodListing: gplCore(['0.0.0'], ['/repo/node_modules/@ujira/core']), inspector }),
      ).toEqual([]);
    });

    it('fails closed on an entry with no paths', () => {
      expect(report({ prodListing: gplCore(['0.0.0'], []) })).toEqual([
        '@ujira/core: pnpm listed 1 version(s) and 0 path(s); cannot tell which path holds which version',
      ]);
    });

    it('fails closed when a second version would borrow the first path', () => {
      expect(report({ prodListing: gplCore(['0.0.0', '6.6.6'], ['/repo/packages/core']) })).toEqual(
        [
          '@ujira/core: pnpm listed 2 version(s) and 1 path(s); cannot tell which path holds which version',
        ],
      );
    });

    it('fails when a registry version is paired with the workspace folder', () => {
      const paths = ['/repo/packages/core', '/repo/packages/core'];
      expect(report({ prodListing: gplCore(['0.0.0', '6.6.6'], paths) })).toEqual([
        '@ujira/core@6.6.6: package.json at "/repo/packages/core" has version "0.0.0"',
      ]);
    });

    it('checks a package with a workspace name outside the workspace folders', () => {
      const inspector = world({ '/elsewhere/ujira': { name: '@ujira/core', version: '0.0.0' } });
      expect(report({ prodListing: gplCore(['0.0.0'], ['/elsewhere/ujira']), inspector })).toEqual([
        '@ujira/core@0.0.0: listed by pnpm but not in pnpm-lock.yaml',
        '@ujira/core@0.0.0 (prod): license "GPL-3.0": "GPL-3.0" not allowed in prod dependencies',
      ]);
    });

    it('checks a registry package that shares a workspace name', () => {
      const path = store('@ujira/core', '9.9.9');
      const inspector = world({ [path]: { name: '@ujira/core', version: '9.9.9' } });
      expect(report({ prodListing: gplCore(['9.9.9'], [path]), inspector })).toContain(
        '@ujira/core@9.9.9 (prod): license "GPL-3.0": "GPL-3.0" not allowed in prod dependencies',
      );
    });

    it('checks a workspace folder whose manifest version differs from the project', () => {
      const inspector = world({ '/repo/packages/core': { name: '@ujira/core', version: '1.0.0' } });
      expect(
        report({ prodListing: gplCore(['1.0.0'], ['/repo/packages/core']), inspector }),
      ).toContain(
        '@ujira/core@1.0.0 (prod): license "GPL-3.0": "GPL-3.0" not allowed in prod dependencies',
      );
    });
  });

  describe('listing resolution', () => {
    const inspector = world({
      [store('multi', '1.0.0')]: { name: 'multi', version: '1.0.0' },
      [store('multi', '2.0.0')]: { name: 'multi', version: '2.0.0' },
    });
    const entry = (versions: string[], paths: string[], license = 'MIT') => ({
      name: 'multi',
      versions,
      paths,
      license,
      homepage: undefined,
    });

    it('pairs each version with its own path', () => {
      const { packages, problems } = resolveListing(
        [entry(['1.0.0', '2.0.0'], [store('multi', '1.0.0'), store('multi', '2.0.0')])],
        WORKSPACES,
        inspector,
      );
      expect(problems).toEqual([]);
      expect(packages.map((p) => `${p.version}=${p.path}`)).toEqual([
        `1.0.0=${store('multi', '1.0.0')}`,
        `2.0.0=${store('multi', '2.0.0')}`,
      ]);
    });

    it('fails when versions and paths are out of order', () => {
      const { packages, problems } = resolveListing(
        [entry(['1.0.0', '2.0.0'], [store('multi', '2.0.0'), store('multi', '1.0.0')])],
        WORKSPACES,
        inspector,
      );
      expect(packages).toEqual([]);
      expect(problems).toEqual([
        `multi@1.0.0: package.json at "${store('multi', '2.0.0')}" has version "2.0.0"`,
        `multi@2.0.0: package.json at "${store('multi', '1.0.0')}" has version "1.0.0"`,
      ]);
    });

    it('fails on an empty, missing or misnamed path', () => {
      const { problems } = resolveListing(
        [
          entry(['1.0.0'], ['']),
          entry(['1.0.0'], ['/gone']),
          { ...entry(['4.2.3'], [store('string-width', '4.2.3')]), name: 'other' },
        ],
        WORKSPACES,
        { ...inspector, realpath: (p) => (p === '/gone' ? '/gone' : inspector.realpath(p)) },
      );
      expect(problems).toEqual([
        'multi@1.0.0: listed path "" does not exist',
        'multi@1.0.0: no package.json at "/gone"',
        `other@4.2.3: package.json at "${store('string-width', '4.2.3')}" is named "string-width"`,
      ]);
    });

    it('fails on an empty version list', () => {
      expect(resolveListing([entry([], [])], WORKSPACES, inspector).problems).toHaveLength(1);
    });

    it('keeps a non registry version as listed', () => {
      const path = '/repo/vendor/local';
      const { packages } = resolveListing(
        [{ ...entry(['file:vendor/local'], [path]), name: 'local' }],
        WORKSPACES,
        world({ [path]: { name: 'local', version: '1.0.0' } }),
      );
      expect(packages.map((p) => p.version)).toEqual(['file:vendor/local']);
    });
  });

  describe('listing shape', () => {
    it('prefers the entry license over the group key', () => {
      const entries = parsePnpmListing(
        JSON.stringify({
          MIT: [{ name: 'a', versions: ['1.0.0'], paths: ['/p'], license: 'GPL-3.0' }],
        }),
        'prod',
      );
      expect(entries[0]?.license).toBe('GPL-3.0');
      const fallback = parsePnpmListing(
        JSON.stringify({ ISC: [{ name: 'a', versions: ['1.0.0'], paths: ['/p'] }] }),
        'prod',
      );
      expect(fallback[0]?.license).toBe('ISC');
    });

    it('applies the entry license in the check', () => {
      const prod = JSON.parse(listing(PROD)) as Record<string, { license: string }[]>;
      const first = prod['MIT']?.[0];
      if (first) first.license = 'GPL-3.0';
      expect(report({ prodListing: JSON.stringify(prod) })).toEqual([
        'copyleft-lib@1.0.0 (prod): license "GPL-3.0": "GPL-3.0" not allowed in prod dependencies',
      ]);
    });

    it.each([
      ['empty output', '', 'printed nothing'],
      ['whitespace', ' \n', 'printed nothing'],
      ['invalid JSON', '{', 'did not print valid JSON'],
      ['a top level array', '[]', 'did not print a JSON object'],
      ['null', 'null', 'did not print a JSON object'],
      ['a group that is not an array', '{"MIT":{}}', 'is not an array'],
      ['an entry that is not an object', '{"MIT":[1]}', 'is not an object'],
      ['an entry without a name', '{"MIT":[{"versions":[],"paths":[]}]}', 'has no name'],
      ['an entry without versions', '{"MIT":[{"name":"a","paths":[]}]}', 'needs string arrays'],
      [
        'non string paths',
        '{"MIT":[{"name":"a","versions":["1"],"paths":[1]}]}',
        'needs string arrays',
      ],
      [
        'a non string license',
        '{"MIT":[{"name":"a","versions":[],"paths":[],"license":1}]}',
        'license is not a string',
      ],
      [
        'a non string homepage',
        '{"MIT":[{"name":"a","versions":[],"paths":[],"homepage":[]}]}',
        'homepage is not a string',
      ],
    ])('fails closed on %s', (_label, stdout, message) => {
      expect(() => parsePnpmListing(stdout, 'dev')).toThrow(ListingError);
      expect(report({ devListing: stdout }).join('\n')).toContain(message);
      expect(checkTree(inputs({ devListing: stdout })).notices).toBeUndefined();
    });

    it('fails when the dev listing is empty but the root declares dev dependencies', () => {
      expect(report({ devListing: '{}' })).toContain(
        'pnpm licenses list --dev is empty, but ujira declare devDependencies',
      );
    });

    it('allows an empty production listing when only workspace dependencies are declared', () => {
      const workspaces = WORKSPACES.map((w) =>
        w.name === '@ujira/core'
          ? { ...w, manifest: { ...w.manifest, dependencies: { '@ujira/shared': 'workspace:*' } } }
          : w,
      );
      const problems = checkTree(inputs({ prodListing: '{}', workspaces })).problems;
      expect(problems.filter((p) => p.includes('is empty'))).toEqual([]);
    });

    it('allows an empty production listing when only platform specific builds are declared', () => {
      const workspaces = WORKSPACES.map((w) =>
        w.name === '@ujira/core'
          ? {
              ...w,
              manifest: { ...w.manifest, dependencies: { 'native-linux-x64-musl': '3.0.0' } },
            }
          : w,
      );
      const problems = checkTree(inputs({ prodListing: '{}', workspaces })).problems;
      expect(problems.filter((p) => p.includes('is empty'))).toEqual([]);
    });

    it('fails when the production listing is empty but a workspace declares dependencies', () => {
      expect(report({ prodListing: '{}' })).toContain(
        'pnpm licenses list --prod is empty, but @ujira/core declare dependencies or optionalDependencies',
      );
    });
  });

  describe('platform specific packages', () => {
    it('fails on a platform package missing from the map', () => {
      const platformMap = PLATFORM_MAP.filter((e) => e.name !== 'native-linux-x64-musl');
      expect(report({ platformMap })).toEqual([
        'native-linux-x64-musl@3.0.0: platform specific package missing from scripts/platform-licenses.json; review its license and add it',
      ]);
    });

    it('checks the mapped license against the allowlist of the package scope', () => {
      const platformMap = PLATFORM_MAP.map((e) =>
        e.name === 'native-linux-x64-musl' ? { ...e, license: 'MPL-2.0' } : e,
      );
      expect(report({ platformMap })).toEqual([
        'native-linux-x64-musl@3.0.0 (prod): license "MPL-2.0": "MPL-2.0" not allowed in prod dependencies',
      ]);
      const gpl = PLATFORM_MAP.map((e) =>
        e.name === 'native-darwin-arm64' ? { ...e, license: 'GPL-3.0' } : e,
      );
      expect(report({ platformMap: gpl })).toContain(
        'native-darwin-arm64@3.0.0 (dev): license "GPL-3.0": "GPL-3.0" not allowed in dev dependencies',
      );
    });

    it('fails when the installed license differs from the map', () => {
      const dev = DEV.map((p) => (p.name === 'native-darwin-arm64' ? { ...p, license: 'ISC' } : p));
      expect(report({ devListing: listing(dev) })).toEqual([
        'native-darwin-arm64@3.0.0: installed license "ISC" differs from scripts/platform-licenses.json "MIT"',
      ]);
    });

    it('fails on an unused or ambiguous map entry', () => {
      const unused = [
        ...PLATFORM_MAP,
        { name: 'gone', versions: '3.0.0', license: 'MIT', source: 'https://github.com/x/gone' },
      ];
      expect(report({ platformMap: unused })).toEqual([
        'scripts/platform-licenses.json: gone@3.0.0 matches nothing in pnpm-lock.yaml; remove it',
      ]);
      const twice = [
        ...PLATFORM_MAP,
        {
          name: 'native-linux-x64-musl',
          versions: '*',
          license: 'MIT',
          source: 'https://github.com/x/native',
        },
      ];
      expect(report({ platformMap: twice })).toContain(
        'native-linux-x64-musl@3.0.0: matches more than one entry in scripts/platform-licenses.json',
      );
    });

    it('matches exact versions, x ranges and *', () => {
      expect(versionMatches('1.2.3', '1.2.3')).toBe(true);
      expect(versionMatches('1.2.3', '1.2.4')).toBe(false);
      expect(versionMatches('1.x', '1.9.0')).toBe(true);
      expect(versionMatches('1.2.x', '1.2.9')).toBe(true);
      expect(versionMatches('1.2.x', '1.3.0')).toBe(false);
      expect(versionMatches('1.x', '1.2.3-beta.1')).toBe(false);
      expect(versionMatches('*', '0.0.1')).toBe(true);
    });

    it('reads a valid map', () => {
      const text = JSON.stringify({ $comment: 'reviewed', packages: PLATFORM_MAP });
      expect(parsePlatformMap(text)).toEqual(PLATFORM_MAP);
    });

    it.each([
      ['invalid JSON', '{', 'not valid JSON'],
      ['a missing packages array', '{}', 'needs a "packages" array'],
      ['an unknown top level key', '{"packages":[],"extra":1}', 'unknown key "extra"'],
      ['an entry that is not an object', '{"packages":[1]}', 'is not an object'],
      [
        'a missing field',
        '{"packages":[{"name":"a","versions":"1.0.0","license":"MIT"}]}',
        'exactly name',
      ],
      [
        'an empty name',
        '{"packages":[{"name":"","versions":"1.0.0","license":"MIT","source":"https://x"}]}',
        'invalid name',
      ],
      [
        'an unsupported range',
        '{"packages":[{"name":"a","versions":"^1.0.0","license":"MIT","source":"https://x"}]}',
        'unsupported version range',
      ],
      [
        'an empty license',
        '{"packages":[{"name":"a","versions":"1.0.0","license":" ","source":"https://x"}]}',
        'invalid license',
      ],
      [
        'a non https source',
        '{"packages":[{"name":"a","versions":"1.0.0","license":"MIT","source":"http://x"}]}',
        'https URL',
      ],
      [
        'a source with credentials',
        '{"packages":[{"name":"a","versions":"1.0.0","license":"MIT","source":"https://u:p@x"}]}',
        'https URL',
      ],
    ])('rejects a map with %s', (_label, text, message) => {
      expect(() => parsePlatformMap(text)).toThrow(message);
    });

    it('validates the checked in map', () => {
      const text = readFileSync(join(import.meta.dirname, 'platform-licenses.json'), 'utf8');
      expect(parsePlatformMap(text).length).toBeGreaterThan(0);
    });
  });

  it('strips credentials from homepage fallbacks in the notices', () => {
    const prod = PROD.map((p) =>
      p.name === 'string-width' ? { ...p, homepage: 'https://user:token@example.com/sw' } : p,
    );
    const inspector = world({
      [store('string-width', '4.2.3')]: { name: 'string-width', version: '4.2.3' },
    });
    const notices = checkTree(inputs({ prodListing: listing(prod), inspector })).notices;
    expect(notices).toContain('| string-width | 4.2.3 | MIT | https://example.com/sw |');
    expect(notices).not.toContain('token');
  });
});
