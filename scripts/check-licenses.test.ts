// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateLicense,
  findViolations,
  formatViolation,
  normalizeRepository,
  parseSpdx,
  PROD_FONT_PACKAGES,
  renderNotices,
  sanitizeUrl,
  type NoticeEntry,
  type Scope,
  type ScopedLicense,
} from './license-policy.ts';
import {
  AssetRegisterError,
  checkAssets,
  globToRegExp,
  OWN_LICENSE,
  parseAssetRegister,
  type AssetEntry,
} from './asset-register.ts';

function pkg(license: string, name = 'some-package', scope: Scope = 'prod'): ScopedLicense {
  return { name, version: '1.0.0', license, scope };
}

describe('check-licenses', () => {
  it('rejects GPL-3.0 in production', () => {
    const violations = findViolations([pkg('GPL-3.0', 'copyleft-lib')]);
    expect(violations.map(formatViolation)).toEqual([
      'copyleft-lib@1.0.0 (prod): license "GPL-3.0": "GPL-3.0" not allowed in prod dependencies',
    ]);
  });

  it('rejects GPL-3.0 in dev', () => {
    expect(evaluateLicense('GPL-3.0-only', 'dev').ok).toBe(false);
  });

  it('accepts MPL-2.0 in dev', () => {
    expect(evaluateLicense('MPL-2.0', 'dev')).toEqual({ ok: true });
  });

  it('rejects MPL-2.0 in production', () => {
    expect(evaluateLicense('MPL-2.0', 'prod')).toEqual({
      ok: false,
      reason: '"MPL-2.0" not allowed in prod dependencies',
    });
  });

  it('rejects a package with no license', () => {
    expect(evaluateLicense('', 'prod')).toEqual({ ok: false, reason: 'no license' });
    expect(evaluateLicense('Unknown', 'dev').ok).toBe(false);
    expect(evaluateLicense('SEE LICENSE IN LICENSE.md', 'prod').ok).toBe(false);
  });

  it('rejects UNLICENSED on a third party package', () => {
    expect(findViolations([pkg('UNLICENSED')])).toHaveLength(1);
  });

  it('rejects an unknown identifier', () => {
    expect(evaluateLicense('LicenseRef-Vendor', 'prod').ok).toBe(false);
    expect(evaluateLicense('Commons-Clause', 'dev').ok).toBe(false);
  });

  it('accepts every production allowlist identifier', () => {
    for (const id of [
      'MIT',
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
    ]) {
      expect(evaluateLicense(id, 'prod'), id).toEqual({ ok: true });
    }
  });

  it('accepts MIT-0 in production and dev', () => {
    expect(evaluateLicense('MIT-0', 'prod')).toEqual({ ok: true });
    expect(evaluateLicense('MIT-0', 'dev')).toEqual({ ok: true });
    expect(findViolations([pkg('MIT-0', 'jsdom-helper', 'dev')])).toEqual([]);
  });

  it('matches identifiers case sensitively', () => {
    expect(evaluateLicense('mit', 'prod').ok).toBe(false);
    expect(evaluateLicense('mit-0', 'dev').ok).toBe(false);
  });

  it.each([
    'AGPL-3.0',
    'LGPL-2.1',
    'SSPL-1.0',
    'BUSL-1.1',
    'Elastic-2.0',
    'CC-BY-NC-4.0',
    'CC-BY-ND-4.0',
  ])('rejects %s in dev and production', (id) => {
    expect(evaluateLicense(id, 'prod').ok).toBe(false);
    expect(evaluateLicense(id, 'dev').ok).toBe(false);
  });

  it('rejects OFL-1.1 on a production package that is not an allowlisted font', () => {
    expect(PROD_FONT_PACKAGES.has('icon-kit')).toBe(false);
    expect(findViolations([pkg('OFL-1.1', 'icon-kit')]).map(formatViolation)).toEqual([
      'icon-kit@1.0.0 (prod): license "OFL-1.1": "OFL-1.1" not allowed in prod dependencies (font licenses are allowed in production only for packages in PROD_FONT_PACKAGES)',
    ]);
    expect(evaluateLicense('OFL-1.1', 'prod').ok).toBe(false);
  });

  it('accepts OFL-1.1 on an allowlisted production font package', () => {
    const fonts = PROD_FONT_PACKAGES as Set<string>;
    fonts.add('@fontsource/test-font');
    try {
      expect(findViolations([pkg('OFL-1.1', '@fontsource/test-font')])).toEqual([]);
      expect(evaluateLicense('OFL-1.1 AND GPL-3.0', 'prod', '@fontsource/test-font').ok).toBe(
        false,
      );
    } finally {
      fonts.delete('@fontsource/test-font');
    }
  });

  it('starts with an empty production font allowlist', () => {
    expect([...PROD_FONT_PACKAGES]).toEqual([]);
  });

  it('accepts OFL-1.1 on any dev package', () => {
    expect(findViolations([pkg('OFL-1.1', 'icon-kit', 'dev')])).toEqual([]);
  });

  it('accepts (MIT OR GPL-3.0)', () => {
    expect(evaluateLicense('(MIT OR GPL-3.0)', 'prod')).toEqual({ ok: true });
    expect(evaluateLicense('GPL-3.0 OR MIT', 'prod')).toEqual({ ok: true });
  });

  it('rejects (MIT AND GPL-3.0)', () => {
    expect(evaluateLicense('(MIT AND GPL-3.0)', 'prod')).toEqual({
      ok: false,
      reason: '"GPL-3.0" not allowed in prod dependencies',
    });
  });

  it('gives AND precedence over OR', () => {
    // MIT OR (Apache-2.0 AND GPL-3.0): passes through the MIT branch.
    expect(evaluateLicense('MIT OR Apache-2.0 AND GPL-3.0', 'prod').ok).toBe(true);
    // (GPL-3.0 AND MIT) OR GPL-2.0: both branches blocked.
    expect(evaluateLicense('GPL-3.0 AND MIT OR GPL-2.0', 'prod').ok).toBe(false);
    expect(evaluateLicense('(MIT OR GPL-3.0) AND (ISC OR AGPL-3.0)', 'prod').ok).toBe(true);
    expect(evaluateLicense('(MIT OR GPL-3.0) AND MPL-2.0', 'prod').ok).toBe(false);
    expect(evaluateLicense('(MIT OR GPL-3.0) AND MPL-2.0', 'dev').ok).toBe(true);
  });

  it('reports the OR branch with the fewest blockers', () => {
    expect(evaluateLicense('(GPL-3.0 AND AGPL-3.0) OR SSPL-1.0', 'prod')).toEqual({
      ok: false,
      reason: '"SSPL-1.0" not allowed in prod dependencies',
    });
    expect(evaluateLicense('GPL-3.0 OR (SSPL-1.0 AND AGPL-3.0)', 'prod')).toEqual({
      ok: false,
      reason: '"GPL-3.0" not allowed in prod dependencies',
    });
  });

  it('rejects an unreviewed WITH exception', () => {
    expect(evaluateLicense('Apache-2.0 WITH LLVM-exception', 'prod')).toEqual({
      ok: false,
      reason: '"Apache-2.0 WITH LLVM-exception" not allowed in prod dependencies',
    });
  });

  it.each([
    'MIT OR',
    '(MIT',
    'MIT)',
    'AND MIT',
    'MIT WITH',
    'MIT ISC',
    '()',
    '(MIT AND ISC GPL-3.0',
  ])('rejects the malformed expression "%s"', (expression) => {
    const decision = evaluateLicense(expression, 'prod');
    expect(decision.ok).toBe(false);
    expect(decision.ok ? '' : decision.reason).toMatch(/^invalid SPDX expression/);
  });

  it('names the missing ")" when a token follows an unclosed group', () => {
    expect(evaluateLicense('(MIT AND ISC GPL-3.0', 'prod')).toEqual({
      ok: false,
      reason: 'invalid SPDX expression "(MIT AND ISC GPL-3.0": missing ")"',
    });
  });

  it('parses WITH tighter than AND', () => {
    expect(parseSpdx('MIT AND Apache-2.0 WITH LLVM-exception')).toEqual({
      kind: 'and',
      left: { kind: 'id', value: 'MIT' },
      right: { kind: 'with', license: 'Apache-2.0', exception: 'LLVM-exception' },
    });
  });

  it('sorts violations by name then version', () => {
    const violations = findViolations([
      { ...pkg('GPL-3.0', 'b'), version: '2.0.0' },
      { ...pkg('GPL-3.0', 'b'), version: '10.0.0' },
      pkg('GPL-3.0', 'a'),
    ]);
    expect(violations.map((v) => `${v.name}@${v.version}`)).toEqual([
      'a@1.0.0',
      'b@10.0.0',
      'b@2.0.0',
    ]);
  });

  it('normalizes repository fields to https URLs', () => {
    expect(
      normalizeRepository({ type: 'git', url: 'git+https://github.com/eslint/rewrite.git' }),
    ).toBe('https://github.com/eslint/rewrite');
    expect(normalizeRepository('eslint/eslint-visitor-keys')).toBe(
      'https://github.com/eslint/eslint-visitor-keys',
    );
    expect(normalizeRepository({ url: 'git@github.com:isaacs/minimatch' })).toBe(
      'https://github.com/isaacs/minimatch',
    );
    expect(normalizeRepository({ url: 'git://github.com/isaacs/node-which.git' })).toBe(
      'https://github.com/isaacs/node-which',
    );
    expect(normalizeRepository({ url: 'http://github.com/garycourt/uri-js' })).toBe(
      'https://github.com/garycourt/uri-js',
    );
    expect(normalizeRepository({ url: 'git+ssh://git@github.com/a/b.git' })).toBe(
      'https://github.com/a/b',
    );
    expect(normalizeRepository('github:a/b')).toBe('https://github.com/a/b');
    expect(normalizeRepository('gitlab:a/b')).toBe('https://gitlab.com/a/b');
    expect(normalizeRepository('bitbucket:a/b')).toBe('https://bitbucket.org/a/b');
    expect(normalizeRepository(undefined)).toBeUndefined();
    expect(normalizeRepository({ type: 'git' })).toBeUndefined();
    expect(normalizeRepository('  ')).toBeUndefined();
  });

  it('strips credentials from repository and homepage URLs', () => {
    expect(normalizeRepository({ url: 'git+https://user:s3cr3tTOKEN@github.com/a/b.git' })).toBe(
      'https://github.com/a/b',
    );
    expect(normalizeRepository('https://token@gitlab.com/a/b')).toBe('https://gitlab.com/a/b');
    expect(sanitizeUrl('https://u:p@example.com/x?y=1#z')).toBe('https://example.com/x?y=1#z');
    expect(sanitizeUrl('https://example.com/a@b')).toBe('https://example.com/a@b');
    expect(sanitizeUrl(' ')).toBeUndefined();
    expect(sanitizeUrl(undefined)).toBeUndefined();
  });

  it('renders sorted, deduplicated and deterministic notices', () => {
    const prod: NoticeEntry[] = [
      { name: 'zeta', version: '1.0.0', license: 'MIT', repository: 'https://github.com/z/zeta' },
      { name: 'alpha', version: '2.0.0', license: 'ISC', repository: undefined },
      { name: 'alpha', version: '10.0.0', license: 'ISC', repository: undefined },
      { name: 'zeta', version: '1.0.0', license: 'MIT', repository: 'https://github.com/z/zeta' },
      { name: 'pipe', version: '1.0.0', license: 'MIT OR | x', repository: undefined },
    ];
    const sections = { prod, dev: [], platformProd: [], platformDev: [], assets: [] };
    const first = renderNotices(sections);
    expect(renderNotices({ ...sections, prod: [...prod].reverse() })).toBe(first);
    expect(first).toContain(
      [
        '## Production dependencies',
        '',
        '| Package | Version | License | Repository |',
        '| --- | --- | --- | --- |',
        '| alpha | 10.0.0 | ISC |  |',
        '| alpha | 2.0.0 | ISC |  |',
        '| pipe | 1.0.0 | MIT OR \\| x |  |',
        '| zeta | 1.0.0 | MIT | https://github.com/z/zeta |',
        '',
        '## Production platform specific packages',
      ].join('\n'),
    );
    expect(first).toMatch(/## Development platform specific packages\n\nNone\.\n\n## Assets\n/);
  });

  it('sorts notices by code unit, not by locale', () => {
    const entry = (name: string): NoticeEntry => ({
      name,
      version: '1.0.0',
      license: 'MIT',
      repository: undefined,
    });
    // Locale order would be @x, a, B, e, é; code unit order puts upper case
    // before lower case and accented letters last.
    const notices = renderNotices({
      prod: ['é', 'a', 'B', '@x', 'e'].map(entry),
      dev: [],
      platformProd: [],
      platformDev: [],
      assets: [],
    });
    const names = [...notices.matchAll(/^\| (\S+) \| 1\.0\.0 /gm)].map((m) => m[1]);
    expect(names).toEqual(['@x', 'B', 'a', 'e', 'é']);
  });

  it('places each section in its own table', () => {
    const one = (name: string): NoticeEntry[] => [
      { name, version: '1.0.0', license: 'MIT', repository: undefined },
    ];
    const notices = renderNotices({
      prod: one('p'),
      dev: one('d'),
      platformProd: one('pp'),
      platformDev: one('pd'),
      assets: [],
    });
    const order = ['| p |', '| pp |', '| d |', '| pd |'].map((cell) => notices.indexOf(cell));
    expect(order.every((index, i) => index > (order[i - 1] ?? -1))).toBe(true);
  });
});

function asset(overrides: Partial<AssetEntry> = {}): AssetEntry {
  return {
    path: 'packages/ui/fonts/inter-*.woff2',
    kind: 'font',
    source: 'https://github.com/rsms/inter',
    license: 'OFL-1.1',
    copyright: 'The Inter Project Authors',
    added: '2026-10-18',
    ...overrides,
  };
}

function register(entries: readonly object[]): string {
  return JSON.stringify({ assets: entries });
}

it('an unregistered woff2 under packages/ui/fonts fails', () => {
  const result = checkAssets([], ['packages/ui/fonts/inter-regular.woff2']);
  expect(result.problems).toEqual([
    'packages/ui/fonts/inter-regular.woff2: not in assets.licenses.json',
  ]);
});

it('a font entry with a licence other than OFL-1.1 fails', () => {
  const result = checkAssets(
    [asset({ license: 'MIT' })],
    ['packages/ui/fonts/inter-regular.woff2'],
  );
  expect(result.problems).toEqual([
    'packages/ui/fonts/inter-*.woff2: license "MIT" not allowed for font assets (allowed: OFL-1.1)',
  ]);
});

it('an entry matching no file fails', () => {
  const result = checkAssets([asset()], []);
  expect(result.problems).toEqual(['packages/ui/fonts/inter-*.woff2: matches no file']);
});

describe('asset register', () => {
  it('passes a registered font and lists it in the notices', () => {
    const result = checkAssets(
      [asset()],
      ['packages/ui/fonts/inter-regular.woff2', 'packages/ui/fonts/inter-bold.woff2'],
    );
    expect(result.problems).toEqual([]);
    expect(result.notices).toEqual([
      {
        path: 'packages/ui/fonts/inter-*.woff2',
        files: 2,
        license: 'OFL-1.1',
        copyright: 'The Inter Project Authors',
        source: 'https://github.com/rsms/inter',
        added: '2026-10-18',
      },
    ]);
  });

  it.each(['CC0-1.0', 'ISC', 'MIT', OWN_LICENSE])('accepts %s for images and data', (license) => {
    const files = ['packages/ui/assets/brand/sprite.svg', 'packages/ui/assets/maps/world.topojson'];
    const entries = [
      asset({ path: 'packages/ui/assets/brand/*.svg', kind: 'image', license }),
      asset({ path: 'packages/ui/assets/maps/*.topojson', kind: 'data', license }),
    ];
    expect(checkAssets(entries, files).problems).toEqual([]);
  });

  it.each(['GPL-3.0', 'CC-BY-4.0', 'OFL-1.1', 'MIT OR GPL-3.0'])(
    'rejects %s for an image',
    (license) => {
      const entries = [asset({ path: 'packages/ui/assets/a.svg', kind: 'image', license })];
      expect(checkAssets(entries, ['packages/ui/assets/a.svg']).problems).toEqual([
        `packages/ui/assets/a.svg: license "${license}" not allowed for image assets (allowed: CC0-1.0, ISC, MIT, ${OWN_LICENSE})`,
      ]);
    },
  );

  it('requires every file in an asset folder to be registered, whatever its type', () => {
    const files = [
      'packages/ui/assets/brand/Tokens.json',
      'apps/website/public/logo.png',
      'apps/dashboard/assets/flags/ke.svg',
      'packages/core/src/index.ts',
      'README.md',
    ];
    expect(checkAssets([], files).problems).toEqual([
      'apps/dashboard/assets/flags/ke.svg: not in assets.licenses.json',
      'apps/website/public/logo.png: not in assets.licenses.json',
      'packages/ui/assets/brand/Tokens.json: not in assets.licenses.json',
    ]);
  });

  it('requires fonts, images and map data anywhere in the tree to be registered', () => {
    const files = [
      'docs/diagram.SVG',
      'scripts/fixtures/clean.png',
      'packages/ui/src/fonts/Inter.ttf',
      'data/world.geojson',
      'packages/core/src/data.json',
    ];
    expect(checkAssets([], files).problems).toEqual([
      'data/world.geojson: not in assets.licenses.json',
      'docs/diagram.SVG: not in assets.licenses.json',
      'packages/ui/src/fonts/Inter.ttf: not in assets.licenses.json',
      'scripts/fixtures/clean.png: not in assets.licenses.json',
    ]);
  });

  it('rejects a file that two entries match', () => {
    const entries = [
      asset({ path: 'packages/ui/assets/**', kind: 'image', license: OWN_LICENSE }),
      asset({ path: 'packages/ui/assets/a.svg', kind: 'image', license: 'MIT' }),
    ];
    expect(checkAssets(entries, ['packages/ui/assets/a.svg']).problems).toEqual([
      'packages/ui/assets/a.svg: matched by more than one entry (packages/ui/assets/**, packages/ui/assets/a.svg)',
    ]);
  });

  it('rejects a font file under an image entry and a non-font file under a font entry', () => {
    const entries = [
      asset({ path: 'packages/ui/assets/*.woff2', kind: 'image', license: 'MIT' }),
      asset({ path: 'packages/ui/fonts/*', kind: 'font' }),
    ];
    const files = [
      'packages/ui/assets/x.woff2',
      'packages/ui/fonts/README.md',
      'packages/ui/fonts/inter.woff2',
    ];
    expect(checkAssets(entries, files).problems).toEqual([
      'packages/ui/assets/x.woff2: a font file must be under a font entry, not image',
      'packages/ui/fonts/README.md: not a font file but under the font entry packages/ui/fonts/*',
    ]);
  });

  it('lets a font entry carry the font licence text', () => {
    const files = ['packages/ui/fonts/inter.woff2', 'packages/ui/fonts/OFL.txt'];
    expect(checkAssets([asset({ path: 'packages/ui/fonts/*' })], files).problems).toEqual([]);
  });

  it('matches globs by path segment', () => {
    expect(globToRegExp('a/*.svg').test('a/b.svg')).toBe(true);
    expect(globToRegExp('a/*.svg').test('a/b/c.svg')).toBe(false);
    expect(globToRegExp('a/**').test('a/b/c.svg')).toBe(true);
    expect(globToRegExp('a/**/c.svg').test('a/c.svg')).toBe(true);
    expect(globToRegExp('a/?.svg').test('a/bb.svg')).toBe(false);
    expect(globToRegExp('a.b/c+d.svg').test('aXb/c+d.svg')).toBe(false);
  });

  it('parses a valid register', () => {
    const entry = asset();
    expect(parseAssetRegister(register([{ ...entry }]))).toEqual([entry]);
  });

  it.each([
    ['an unknown field', { ...asset(), note: 'x' }, 'assets[0]: unknown field "note"'],
    [
      'a missing field',
      { path: 'a', kind: 'font', source: 'https://x', license: 'OFL-1.1', copyright: 'x' },
      'assets[0]: "added" must be a non-empty string',
    ],
    [
      'a bad date',
      { ...asset(), added: '2026-13-01' },
      'assets[0]: "added" must be a date as YYYY-MM-DD',
    ],
    [
      'a non https source',
      { ...asset(), source: 'http://x.example' },
      'assets[0]: "source" must be an https URL',
    ],
    [
      'an unknown kind',
      { ...asset(), kind: 'video' },
      'assets[0]: "kind" must be font, image or data',
    ],
  ])('rejects %s', (_name, entry, message) => {
    expect(() => parseAssetRegister(register([entry]))).toThrow(new AssetRegisterError(message));
  });

  it('rejects two entries with the same path', () => {
    expect(() => parseAssetRegister(register([asset(), asset()]))).toThrow(
      new AssetRegisterError('assets[1]: path "packages/ui/fonts/inter-*.woff2" is listed twice'),
    );
  });

  it('rejects a duplicate key', () => {
    expect(() => parseAssetRegister('{"assets": [], "assets": [{"path": "x"}]}')).toThrow(
      AssetRegisterError,
    );
  });

  it('registers the brand assets as our own in the committed register', () => {
    const entries = parseAssetRegister(
      readFileSync(join(import.meta.dirname, '..', 'assets.licenses.json'), 'utf8'),
    );
    const brand = entries.filter((e) => e.path.startsWith('packages/ui/assets/brand/'));
    expect(brand.map((e) => e.path).sort()).toEqual([
      'packages/ui/assets/brand/*.svg',
      'packages/ui/assets/brand/Tokens.json',
    ]);
    expect(brand.every((e) => e.license === OWN_LICENSE && e.copyright === 'Qomira Labs')).toBe(
      true,
    );
  });

  it('renders assets in their own section', () => {
    const notices = renderNotices({
      prod: [],
      dev: [],
      platformProd: [],
      platformDev: [],
      assets: [
        {
          path: 'packages/ui/fonts/*.woff2',
          files: 2,
          license: 'OFL-1.1',
          copyright: 'The Inter Project Authors',
          source: 'https://github.com/rsms/inter',
          added: '2026-10-18',
        },
        {
          path: 'packages/ui/assets/brand/*',
          files: 1,
          license: OWN_LICENSE,
          copyright: 'Qomira Labs',
          source: 'https://github.com/qomiralabs/ujira',
          added: '2026-10-18',
        },
      ],
    });
    expect(notices).toContain(
      [
        '## Assets',
        '',
        'Files that do not come from npm, from `assets.licenses.json`.',
        '',
        '| Asset | Files | License | Copyright | Source | Added |',
        '| --- | --- | --- | --- | --- | --- |',
        `| packages/ui/assets/brand/* | 1 | ${OWN_LICENSE} | Qomira Labs | https://github.com/qomiralabs/ujira | 2026-10-18 |`,
        '| packages/ui/fonts/*.woff2 | 2 | OFL-1.1 | The Inter Project Authors | https://github.com/rsms/inter | 2026-10-18 |',
        '',
      ].join('\n'),
    );
  });
});
