// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateLicense,
  findViolations,
  flattenPnpmLicenses,
  formatViolation,
  normalizeRepository,
  parseSpdx,
  PROD_FONT_PACKAGES,
  renderNotices,
  type InstalledPackage,
  type NoticeEntry,
  type PnpmLicensesJson,
} from './license-policy.ts';

const WORKSPACE = new Set(['ujira', '@ujira/core']);

function fixture(name: string): InstalledPackage[] {
  const text = readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
  return flattenPnpmLicenses(JSON.parse(text) as PnpmLicensesJson);
}

function pkg(license: string, name = 'some-package'): InstalledPackage {
  return {
    name,
    version: '1.0.0',
    license,
    path: `/repo/node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`,
    homepage: undefined,
  };
}

describe('check-licenses', () => {
  it('rejects GPL-3.0 in production', () => {
    const violations = findViolations([pkg('GPL-3.0', 'copyleft-lib')], 'prod', WORKSPACE);
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
    expect(findViolations([pkg('UNLICENSED')], 'prod', WORKSPACE)).toHaveLength(1);
  });

  it('rejects an unknown identifier', () => {
    expect(evaluateLicense('LicenseRef-Vendor', 'prod').ok).toBe(false);
    expect(evaluateLicense('Commons-Clause', 'dev').ok).toBe(false);
  });

  it('accepts every production allowlist identifier', () => {
    for (const id of [
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
    ]) {
      expect(evaluateLicense(id, 'prod'), id).toEqual({ ok: true });
    }
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
    expect(
      findViolations([pkg('OFL-1.1', 'icon-kit')], 'prod', WORKSPACE).map(formatViolation),
    ).toEqual([
      'icon-kit@1.0.0 (prod): license "OFL-1.1": "OFL-1.1" not allowed in prod dependencies (font licenses are allowed in production only for packages in PROD_FONT_PACKAGES)',
    ]);
    expect(evaluateLicense('OFL-1.1', 'prod').ok).toBe(false);
  });

  it('accepts OFL-1.1 on an allowlisted production font package', () => {
    const fonts = PROD_FONT_PACKAGES as Set<string>;
    fonts.add('@fontsource/test-font');
    try {
      expect(findViolations([pkg('OFL-1.1', '@fontsource/test-font')], 'prod', WORKSPACE)).toEqual(
        [],
      );
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
    expect(findViolations([pkg('OFL-1.1', 'icon-kit')], 'dev', WORKSPACE)).toEqual([]);
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

  it.each(['MIT OR', '(MIT', 'MIT)', 'AND MIT', 'MIT WITH', 'MIT ISC', '()'])(
    'rejects the malformed expression "%s"',
    (expression) => {
      const decision = evaluateLicense(expression, 'prod');
      expect(decision.ok).toBe(false);
      expect(decision.ok ? '' : decision.reason).toMatch(/^invalid SPDX expression/);
    },
  );

  it('parses WITH tighter than AND', () => {
    expect(parseSpdx('MIT AND Apache-2.0 WITH LLVM-exception')).toEqual({
      kind: 'and',
      left: { kind: 'id', value: 'MIT' },
      right: { kind: 'with', license: 'Apache-2.0', exception: 'LLVM-exception' },
    });
  });

  it('passes the clean fixture and skips workspace packages', () => {
    const packages = fixture('licenses-clean.json');
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      'left-pad@1.3.0',
      'left-pad@1.2.0',
      'dual-licensed@2.0.0',
      '@ujira/core@0.0.0',
    ]);
    expect(findViolations(packages, 'prod', WORKSPACE)).toEqual([]);
  });

  it('names every offender in the violations fixture, sorted', () => {
    const packages = fixture('licenses-violations.json');
    expect(findViolations(packages, 'prod', WORKSPACE).map(formatViolation)).toEqual([
      '@ujira/core@9.9.9 (prod): license "UNLICENSED": no usable license ("UNLICENSED")',
      'copyleft-lib@1.0.0 (prod): license "GPL-3.0": "GPL-3.0" not allowed in prod dependencies',
      'mozilla-lib@3.1.0 (prod): license "MPL-2.0": "MPL-2.0" not allowed in prod dependencies',
      'no-license@0.1.0 (prod): license "Unknown": no usable license ("Unknown")',
    ]);
    expect(findViolations(packages, 'dev', WORKSPACE).map((v) => v.name)).toEqual([
      '@ujira/core',
      'copyleft-lib',
      'no-license',
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

  it('renders sorted, deduplicated and deterministic notices', () => {
    const prod: NoticeEntry[] = [
      { name: 'zeta', version: '1.0.0', license: 'MIT', repository: 'https://github.com/z/zeta' },
      { name: 'alpha', version: '2.0.0', license: 'ISC', repository: undefined },
      { name: 'alpha', version: '10.0.0', license: 'ISC', repository: undefined },
      { name: 'zeta', version: '1.0.0', license: 'MIT', repository: 'https://github.com/z/zeta' },
      { name: 'pipe', version: '1.0.0', license: 'MIT OR | x', repository: undefined },
    ];
    const first = renderNotices(prod, []);
    expect(renderNotices([...prod].reverse(), [])).toBe(first);
    expect(first).toContain(
      [
        '| Package | Version | License | Repository |',
        '| --- | --- | --- | --- |',
        '| alpha | 10.0.0 | ISC |  |',
        '| alpha | 2.0.0 | ISC |  |',
        '| pipe | 1.0.0 | MIT OR \\| x |  |',
        '| zeta | 1.0.0 | MIT | https://github.com/z/zeta |',
        '',
        '## Development dependencies',
      ].join('\n'),
    );
    expect(first).toMatch(/Used to build and test UJIRA\. They are not shipped\.\n\nNone\.\n$/);
  });
});
