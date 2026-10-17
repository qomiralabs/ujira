// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkWorkspace,
  MEMBER_COMPILER_OPTIONS,
  scriptProblems,
} from './check-workspace-scripts.ts';

const SCRIPTS = {
  build: 'tsc -p tsconfig.build.json',
  typecheck: 'tsc -p tsconfig.json',
  lint: 'eslint --max-warnings 0 .',
  test: 'vitest run',
};

const TSCONFIG = JSON.stringify({
  extends: '../../tsconfig.base.json',
  compilerOptions: { noEmit: true },
});
const TSCONFIG_BUILD = JSON.stringify({
  extends: '../../tsconfig.base.json',
  compilerOptions: { rootDir: 'src', outDir: 'dist' },
});

function member(
  name: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const files: Record<string, string | undefined> = {
    'package.json': JSON.stringify({ name, scripts: SCRIPTS }),
    'tsconfig.json': TSCONFIG,
    'tsconfig.build.json': TSCONFIG_BUILD,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(files).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

const roots: string[] = [];

// Writes a workspace into a fresh temp folder and returns its path.
function workspace(
  members: Record<string, Record<string, string>>,
  extra: Record<string, string> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'ujira-ws-'));
  roots.push(root);
  const files: Record<string, string> = {
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - apps/*\n',
    ...extra,
  };
  for (const [path, memberFiles] of Object.entries(members)) {
    for (const [file, text] of Object.entries(memberFiles)) files[`${path}/${file}`] = text;
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-workspace-scripts', () => {
  describe('scriptProblems', () => {
    it.each([
      'tsc -p tsconfig.json',
      'eslint --max-warnings 0 .',
      'vitest run --coverage',
      'prettier --check .',
      'next build',
      'tsc -p tsconfig.build.json && vitest run',
      'vitest run > out.txt 2>&1',
      'eslint . < input',
    ])('accepts %s', (script) => {
      expect(scriptProblems(script)).toEqual([]);
    });

    it.each([
      ['eslint . || true', 'may only chain commands with &&, found |'],
      ['eslint . | cat', 'may only chain commands with &&, found |'],
      ['eslint .; true', 'may only chain commands with &&, found ;'],
      ['eslint . &', 'may only chain commands with &&, found &'],
      ['eslint `x`', 'may only chain commands with &&, found `'],
      ['eslint $(x)', 'may only chain commands with &&, found $('],
      ['eslint <(x)', 'may only chain commands with &&, found <('],
      ['eslint >(x)', 'may only chain commands with &&, found >('],
      ['eslint .\ntrue', 'may only chain commands with &&, found newline'],
      [
        'pnpm run lint:raw --max-warnings 0',
        'must start each command with one of tsc, eslint, vitest, prettier, next, found pnpm',
      ],
      [
        'bash -c "eslint ."',
        'must start each command with one of tsc, eslint, vitest, prettier, next, found bash',
      ],
      [
        'node lint.js',
        'must start each command with one of tsc, eslint, vitest, prettier, next, found node',
      ],
      [
        '! eslint .',
        'must start each command with one of tsc, eslint, vitest, prettier, next, found !',
      ],
      ['CI=1 eslint .', 'must not set environment variables before a command, found CI=1'],
      ['"eslint" .', 'must start each command with a bare tool name, found "eslint"'],
      [
        './node_modules/.bin/eslint .',
        'must start each command with a bare tool name, found ./node_modules/.bin/eslint',
      ],
      ['$ESLINT .', 'must start each command with a bare tool name, found $ESLINT'],
      [
        'tsc -p a &&',
        'must start each command with one of tsc, eslint, vitest, prettier, next, found an empty command',
      ],
    ])('rejects %s', (script, reason) => {
      expect(scriptProblems(script)).toContain(reason);
    });
  });

  describe('checkWorkspace', () => {
    it('passes a clean workspace', () => {
      expect(
        checkWorkspace(workspace({ 'packages/a': member('a'), 'apps/b': member('b') })),
      ).toEqual([]);
    });

    it('passes when apps/ does not exist and ignores .DS_Store and node_modules', () => {
      const root = workspace(
        { 'packages/a': member('a') },
        { 'packages/.DS_Store': '', 'packages/a/node_modules/x/package.json': '{}' },
      );
      expect(checkWorkspace(root)).toEqual([]);
    });

    it('rejects a missing script and an empty one', () => {
      const pkg = JSON.stringify({
        name: 'a',
        scripts: { ...SCRIPTS, build: ' ', test: undefined },
      });
      expect(
        checkWorkspace(workspace({ 'packages/a': member('a', { 'package.json': pkg }) })),
      ).toEqual(['a: missing "build" script', 'a: missing "test" script']);
    });

    it('rejects a package without scripts', () => {
      const pkg = JSON.stringify({ name: 'a' });
      expect(
        checkWorkspace(workspace({ 'packages/a': member('a', { 'package.json': pkg }) })),
      ).toHaveLength(4);
    });

    it.each([
      ['no --max-warnings', 'eslint .'],
      ['a non zero value', 'eslint --max-warnings 5 .'],
      ['the flag twice', 'eslint --max-warnings 0 --max-warnings 9 .'],
      ['a flag with no value', 'eslint . --max-warnings'],
    ])('rejects a lint script with %s', (_label, lint) => {
      const pkg = JSON.stringify({ name: 'a', scripts: { ...SCRIPTS, lint } });
      expect(
        checkWorkspace(workspace({ 'packages/a': member('a', { 'package.json': pkg }) })),
      ).toContain('a: "lint" script must pass --max-warnings 0 exactly once');
    });

    it('accepts --max-warnings=0', () => {
      const pkg = JSON.stringify({
        name: 'a',
        scripts: { ...SCRIPTS, lint: 'eslint --max-warnings=0 .' },
      });
      expect(
        checkWorkspace(workspace({ 'packages/a': member('a', { 'package.json': pkg }) })),
      ).toEqual([]);
    });

    it('reports a script problem with the package and script name', () => {
      const pkg = JSON.stringify({
        name: 'a',
        scripts: { ...SCRIPTS, test: 'vitest run || true' },
      });
      expect(
        checkWorkspace(workspace({ 'packages/a': member('a', { 'package.json': pkg }) })),
      ).toEqual(['a: "test" script may only chain commands with &&, found |']);
    });

    it('rejects loose files, folders without a package.json and nested packages', () => {
      const root = workspace(
        { 'packages/a': member('a') },
        {
          'packages/notes.md': '',
          'packages/empty/src/index.ts': '',
          'packages/a/nested/package.json': '{"name":"nested"}',
        },
      );
      expect(checkWorkspace(root)).toEqual([
        'packages/empty: folder has no package.json',
        'packages/notes.md: only package folders are allowed in packages/',
        'packages/a/nested: has a package.json but is not a workspace member',
      ]);
    });

    it('rejects a symlinked folder', () => {
      const root = workspace({ 'packages/a': member('a') }, { 'elsewhere/package.json': '{}' });
      symlinkSync(join(root, 'elsewhere'), join(root, 'packages', 'linked'));
      expect(checkWorkspace(root)).toEqual([
        'packages/linked: symlinks are not allowed in workspace folders',
      ]);
    });

    it.each([
      [
        'an empty package list',
        'packages:\n',
        [
          'pnpm-workspace.yaml: no entries found under "packages:"',
          'packages/a: has a package.json but is not a workspace member',
        ],
      ],
      [
        'a nested glob',
        'packages:\n  - packages/**\n',
        [
          'pnpm-workspace.yaml: unsupported glob "packages/**", expected the form "<dir>/*"',
          'pnpm-workspace.yaml: "packages/**" is outside packages and apps, which the checks scan',
          'packages/a: has a package.json but is not a workspace member',
        ],
      ],
      [
        'a folder the checks do not scan',
        'packages:\n  - packages/*\n  - tools/*\n',
        ['pnpm-workspace.yaml: "tools/*" is outside packages and apps, which the checks scan'],
      ],
    ])('rejects a workspace file with %s', (_label, yaml, expected) => {
      const root = workspace({ 'packages/a': member('a') }, { 'pnpm-workspace.yaml': yaml });
      expect(checkWorkspace(root)).toEqual(expected);
    });

    it('reads quoted globs and ignores comments and later keys', () => {
      const yaml = 'packages:\n  - \'packages/*\' # members\n\n  - "apps/*"\nengineStrict: true\n';
      expect(
        checkWorkspace(workspace({ 'packages/a': member('a') }, { 'pnpm-workspace.yaml': yaml })),
      ).toEqual([]);
    });

    it('rejects a missing or duplicate package name', () => {
      const unnamed = JSON.stringify({ scripts: SCRIPTS });
      const root = workspace({
        'packages/a': member('same'),
        'packages/b': member('same'),
        'packages/c': member('c', { 'package.json': unnamed }),
      });
      expect(checkWorkspace(root)).toEqual([
        'packages/b: name "same" is also used by packages/a',
        'packages/c: package.json needs a name',
      ]);
    });

    it('rejects a Next.js app until the gate builds one', () => {
      const root = workspace({ 'apps/web': member('web', { 'next.config.ts': '' }) });
      expect(checkWorkspace(root)).toEqual([
        'web: Next.js apps are not built by the root gate yet; extend scripts/gate.ts first',
      ]);
    });

    describe('member tsconfig files', () => {
      const tsconfig = (compilerOptions: unknown, base = '../../tsconfig.base.json'): string =>
        JSON.stringify({ extends: base, compilerOptions });

      it.each(['tsconfig.json', 'tsconfig.build.json'])('rejects a missing %s', (file) => {
        expect(
          checkWorkspace(workspace({ 'packages/a': member('a', { [file]: undefined }) })),
        ).toEqual([`a: ${file} is missing`]);
      });

      it.each([
        ['strict', false],
        ['noCheck', true],
        ['skipLibCheck', false],
        ['noUncheckedIndexedAccess', false],
        ['allowJs', true],
      ])('rejects compilerOptions.%s', (key, value) => {
        const root = workspace({
          'packages/a': member('a', { 'tsconfig.json': tsconfig({ [key]: value }) }),
        });
        expect(checkWorkspace(root)).toEqual([
          `a: tsconfig.json must not set compilerOptions.${key}; shared options live in tsconfig.base.json`,
        ]);
      });

      it('accepts every allowed compiler option', () => {
        const options = Object.fromEntries(
          MEMBER_COMPILER_OPTIONS.map((key) => [key, key === 'noEmit' ? true : 'x']),
        );
        const root = workspace({
          'packages/a': member('a', { 'tsconfig.json': tsconfig(options) }),
        });
        expect(checkWorkspace(root)).toEqual([]);
      });

      it('accepts comments and trailing commas', () => {
        const text =
          '{\n  // shared\n  "extends": "../../tsconfig.base.json",\n  "include": ["src"],\n}\n';
        expect(
          checkWorkspace(workspace({ 'packages/a': member('a', { 'tsconfig.json': text }) })),
        ).toEqual([]);
      });

      it('rejects a different base or no base', () => {
        const root = workspace({
          'packages/a': member('a', { 'tsconfig.json': tsconfig({}, './loose.json') }),
          'packages/b': member('b', { 'tsconfig.json': '{}' }),
        });
        expect(checkWorkspace(root)).toEqual([
          'a: tsconfig.json must extend exactly "../../tsconfig.base.json"',
          'b: tsconfig.json must extend exactly "../../tsconfig.base.json"',
        ]);
      });

      it('rejects noEmit in the build config', () => {
        const root = workspace({
          'packages/a': member('a', {
            'tsconfig.build.json': tsconfig({ outDir: 'dist', noEmit: false }),
          }),
        });
        expect(checkWorkspace(root)).toEqual([
          'a: tsconfig.build.json must not set noEmit; the build has to emit',
        ]);
      });

      it('rejects invalid JSON, a non object and non object compilerOptions', () => {
        const root = workspace({
          'packages/a': member('a', { 'tsconfig.json': '{ "extends": ' }),
          'packages/b': member('b', { 'tsconfig.json': '[]' }),
          'packages/c': member('c', { 'tsconfig.json': tsconfig([]) }),
        });
        const problems = checkWorkspace(root);
        expect(problems).toHaveLength(3);
        expect(problems[0]).toMatch(/^a: tsconfig\.json is not valid: /);
        expect(problems[1]).toMatch(/^b: tsconfig\.json is not valid: /);
        expect(problems[2]).toBe('c: tsconfig.json: compilerOptions must be an object');
      });
    });
  });
});
