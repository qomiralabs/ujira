// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import {
  evaluateLicense,
  findViolations,
  formatViolation,
  normalizeRepository,
  parseSpdx,
  DEV_DATA_PACKAGES,
  PROD_FONT_PACKAGES,
  renderNotices,
  sanitizeUrl,
  type NoticeEntry,
  type Scope,
  type ScopedLicense,
} from './license-policy.ts';

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

  it('accepts CC-BY-4.0 only on the reviewed dev data packages', () => {
    expect([...DEV_DATA_PACKAGES]).toEqual(['caniuse-lite']);
    expect(findViolations([pkg('CC-BY-4.0', 'caniuse-lite', 'dev')])).toEqual([]);
    expect(evaluateLicense('CC-BY-4.0 AND GPL-3.0', 'dev', 'caniuse-lite').ok).toBe(false);
  });

  it('rejects CC-BY-4.0 on any other dev package and on every production package', () => {
    expect(findViolations([pkg('CC-BY-4.0', 'icon-kit', 'dev')]).map(formatViolation)).toEqual([
      'icon-kit@1.0.0 (dev): license "CC-BY-4.0": "CC-BY-4.0" not allowed in dev dependencies (data licenses are allowed in development only for packages in DEV_DATA_PACKAGES)',
    ]);
    expect(evaluateLicense('CC-BY-4.0', 'prod', 'caniuse-lite').ok).toBe(false);
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
    const sections = { prod, dev: [], platformProd: [], platformDev: [] };
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
    expect(first).toMatch(/## Development platform specific packages\n\nNone\.\n$/);
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
    });
    const order = ['| p |', '| pp |', '| d |', '| pd |'].map((cell) => notices.indexOf(cell));
    expect(order.every((index, i) => index > (order[i - 1] ?? -1))).toBe(true);
  });
});
