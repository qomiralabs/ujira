// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkWorkspace,
  trackedFiles,
  trackedIgnored,
  trackedSymlinks,
  LIFECYCLE_SCRIPTS,
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
        const values: Record<string, unknown> = {
          rootDir: '.',
          outDir: 'dist',
          noEmit: true,
          allowImportingTsExtensions: true,
        };
        const options = Object.fromEntries(
          MEMBER_COMPILER_OPTIONS.map((key) => [key, values[key] ?? 'x']),
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

    describe('confinement of member tsconfig paths', () => {
      const withOptions = (
        compilerOptions: Record<string, unknown>,
        extra: Record<string, unknown> = {},
      ) => JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions, ...extra });

      it.each(['..', '../..', '/tmp/out', '../other/dist', 'src', '.'])(
        'rejects a build outDir of %s',
        (outDir) => {
          const root = workspace({
            'packages/a': member('a', {
              'tsconfig.build.json': withOptions({ rootDir: 'src', outDir }),
            }),
          });
          expect(checkWorkspace(root)).toEqual([
            `a: tsconfig.build.json compilerOptions.outDir must be "dist", found "${outDir}"`,
          ]);
        },
      );

      it('accepts outDir dist written as ./dist/', () => {
        const root = workspace({
          'packages/a': member('a', {
            'tsconfig.build.json': withOptions({ rootDir: 'src', outDir: './dist/' }),
          }),
        });
        expect(checkWorkspace(root)).toEqual([]);
      });

      it.each(['..', '../..', '/abs'])('rejects a rootDir of %s', (rootDir) => {
        const root = workspace({
          'packages/a': member('a', { 'tsconfig.json': withOptions({ noEmit: true, rootDir }) }),
        });
        expect(checkWorkspace(root)).toEqual([
          `a: tsconfig.json compilerOptions.rootDir must stay inside the member folder, found "${rootDir}"`,
        ]);
      });

      it.each([
        ['include', ['../other/src']],
        ['include', ['/abs/**/*']],
        ['include', ['src\\..\\..\\x']],
        ['exclude', ['../../scripts']],
        ['files', ['../x.ts']],
      ])('rejects a %s entry outside the member folder', (key, entries) => {
        const root = workspace({
          'packages/a': member('a', {
            'tsconfig.json': withOptions({ noEmit: true }, { [key]: entries }),
          }),
        });
        expect(checkWorkspace(root)).toEqual([
          `a: tsconfig.json ${key} entry "${entries[0] ?? ''}" must stay inside the member folder`,
        ]);
      });

      it('rejects include, exclude or files that are not string arrays', () => {
        const root = workspace({
          'packages/a': member('a', {
            'tsconfig.json': withOptions({ noEmit: true }, { include: 'src' }),
          }),
        });
        expect(checkWorkspace(root)).toEqual([
          'a: tsconfig.json include must be an array of strings',
        ]);
      });

      it('accepts include, exclude and files inside the member folder', () => {
        const extra = {
          include: ['src', './vitest.config.ts'],
          exclude: ['src/**/*.test.ts'],
          files: ['src/index.ts'],
        };
        const root = workspace({
          'packages/a': member('a', { 'tsconfig.json': withOptions({ noEmit: true }, extra) }),
        });
        expect(checkWorkspace(root)).toEqual([]);
      });

      it.each(['references', 'watchOptions', 'compileOnSave', 'typeAcquisition'])(
        'rejects the top level key %s',
        (key) => {
          const root = workspace({
            'packages/a': member('a', {
              'tsconfig.json': withOptions({ noEmit: true }, { [key]: [] }),
            }),
          });
          expect(checkWorkspace(root)).toEqual([`a: tsconfig.json must not set ${key}`]);
        },
      );

      it('allows allowImportingTsExtensions only together with noEmit', () => {
        const ok = workspace({
          'packages/a': member('a', {
            'tsconfig.json': withOptions({ noEmit: true, allowImportingTsExtensions: true }),
          }),
        });
        expect(checkWorkspace(ok)).toEqual([]);
        const bad = workspace({
          'packages/a': member('a', {
            'tsconfig.build.json': withOptions({
              outDir: 'dist',
              allowImportingTsExtensions: true,
            }),
          }),
        });
        expect(checkWorkspace(bad)).toEqual([
          'a: tsconfig.build.json may set allowImportingTsExtensions only together with noEmit: true',
        ]);
      });
    });

    describe('install time scripts', () => {
      it.each(LIFECYCLE_SCRIPTS)('rejects a member %s script', (name) => {
        const pkg = JSON.stringify({
          name: 'a',
          scripts: { ...SCRIPTS, [name]: 'tsc -p tsconfig.json' },
        });
        expect(
          checkWorkspace(workspace({ 'packages/a': member('a', { 'package.json': pkg }) })),
        ).toEqual([
          `a: must not define a "${name}" script; install time scripts run before the gate`,
        ]);
      });

      it('rejects install time scripts in the root package.json', () => {
        const root = workspace(
          { 'packages/a': member('a') },
          {
            'package.json': JSON.stringify({
              name: 'root',
              scripts: { postinstall: 'x', 'pnpm:devPreinstall': 'y' },
            }),
          },
        );
        expect(checkWorkspace(root)).toEqual([
          'package.json: must not define a "pnpm:devPreinstall" script; install time scripts run before the gate',
          'package.json: must not define a "postinstall" script; install time scripts run before the gate',
        ]);
      });

      it('accepts the real repository', () => {
        expect(checkWorkspace(join(import.meta.dirname, '..'))).toEqual([]);
      });
    });

    describe('pnpm-workspace.yaml parsing', () => {
      it('keeps reading the list past a comment in column 0', () => {
        const yaml = 'packages:\n  - packages/*\n# apps live here\n  - apps/*\n';
        const root = workspace(
          { 'packages/a': member('a'), 'apps/b': member('b') },
          { 'pnpm-workspace.yaml': yaml },
        );
        expect(checkWorkspace(root)).toEqual([]);
      });

      it('reads a flow sequence', () => {
        const yaml = 'packages: [packages/*, "apps/*"]\n';
        const root = workspace(
          { 'packages/a': member('a'), 'apps/b': member('b') },
          { 'pnpm-workspace.yaml': yaml },
        );
        expect(checkWorkspace(root)).toEqual([]);
      });

      it.each([
        ['invalid YAML', 'packages: [packages/*\n', /^pnpm-workspace\.yaml: invalid YAML: /],
        [
          'a packages value that is not a list',
          'packages: packages/*\n',
          /^pnpm-workspace\.yaml: "packages" must be a list of strings$/,
        ],
        [
          'a non string entry',
          'packages:\n  - 1\n',
          /^pnpm-workspace\.yaml: "packages" must be a list of strings$/,
        ],
        [
          'a negated entry',
          'packages:\n  - packages/*\n  - "!packages/x"\n',
          /unsupported glob "!packages\/x"/,
        ],
      ])('reports %s', (_label, yaml, pattern) => {
        const problems = checkWorkspace(
          workspace({ 'packages/a': member('a') }, { 'pnpm-workspace.yaml': yaml }),
        );
        expect(problems.some((p) => pattern.test(p))).toBe(true);
      });

      it('fails when pnpm sees a different member set', () => {
        const root = workspace({ 'packages/a': member('a') });
        expect(checkWorkspace(root, { pnpmMembers: ['packages/a', 'tools/x'] })).toEqual([
          'tools/x: pnpm treats this folder as a workspace member, but the checks do not',
        ]);
        expect(checkWorkspace(root, { pnpmMembers: [] })).toEqual([
          'packages/a: the checks treat this folder as a workspace member, but pnpm does not',
        ]);
        expect(checkWorkspace(root, { pnpmMembers: ['packages/a'] })).toEqual([]);
      });
    });

    describe('Next.js apps', () => {
      it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])(
        'rejects a member with next in %s',
        (field) => {
          const pkg = JSON.stringify({
            name: 'web',
            scripts: SCRIPTS,
            [field]: { next: '16.0.0' },
          });
          expect(
            checkWorkspace(workspace({ 'apps/web': member('web', { 'package.json': pkg }) })),
          ).toEqual([
            'web: Next.js apps are not built by the root gate yet; extend scripts/gate.ts first',
          ]);
        },
      );
    });

    describe('symlinks', () => {
      it.each(['dist', 'node_modules', 'coverage', '.turbo'])(
        'rejects a symlink named %s inside a member',
        (name) => {
          const root = workspace({ 'packages/a': member('a') }, { 'elsewhere/x.txt': '' });
          symlinkSync(join(root, 'elsewhere'), join(root, 'packages', 'a', name));
          expect(checkWorkspace(root)).toEqual([
            `packages/a/${name}: symlinks are not allowed in workspace folders`,
          ]);
        },
      );

      it('rejects a tracked symlink in a member, whatever git status says', () => {
        const root = workspace({ 'packages/a': member('a') });
        expect(checkWorkspace(root, { trackedSymlinks: ['packages/a/dist', 'docs/link'] })).toEqual(
          ['packages/a/dist: tracked symlinks are not allowed in workspace members'],
        );
      });

      it('lists tracked symlinks from the git index', () => {
        const root = workspace({ 'packages/a': member('a') }, { 'target/x.txt': '' });
        symlinkSync('../../target', join(root, 'packages', 'a', 'dist'));
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['add', '-A'], { cwd: root });
        expect(trackedSymlinks(root)).toEqual(['packages/a/dist']);
      });
    });

    describe('extra tsconfig files', () => {
      it.each([
        'packages/a/src/tsconfig.json',
        'packages/a/src/money/tsconfig.json',
        'packages/a/src/tsconfig.app.json',
        'packages/a/tsconfig.test.json',
        'packages/a/jsconfig.json',
        'packages/a/src/jsconfig.json',
        'scripts/tsconfig.json',
        'tsconfig.extra.json',
      ])('rejects %s', (path) => {
        const root = workspace({ 'packages/a': member('a') }, { [path]: '{}' });
        expect(checkWorkspace(root)).toEqual([
          `${path}: only the root tsconfig.json, tsconfig.base.json and the two at each member root are allowed`,
        ]);
      });

      it('accepts the root and member root files', () => {
        const root = workspace(
          { 'packages/a': member('a') },
          {
            'tsconfig.json': '{}',
            'tsconfig.base.json': '{}',
            'packages/a/node_modules/x/tsconfig.json': '{}',
          },
        );
        expect(checkWorkspace(root)).toEqual([]);
      });
    });

    describe('formatter configuration', () => {
      it.each([
        'packages/a/.prettierrc',
        'packages/a/.prettierrc.json',
        'packages/a/.prettierrc.yaml',
        'packages/a/.prettierrc.mjs',
        'packages/a/prettier.config.ts',
        'packages/a/src/prettier.config.cjs',
        'packages/a/.editorconfig',
        'scripts/.prettierrc.toml',
        '.editorconfig',
      ])('rejects %s', (path) => {
        const root = workspace({ 'packages/a': member('a') }, { [path]: '' });
        expect(checkWorkspace(root)).toEqual([
          `${path}: formatter configuration lives only in the root .prettierrc.json`,
        ]);
      });

      it('accepts the root .prettierrc.json', () => {
        const root = workspace({ 'packages/a': member('a') }, { '.prettierrc.json': '{}' });
        expect(checkWorkspace(root)).toEqual([]);
      });

      it('rejects a prettier key in a member manifest', () => {
        const pkg = JSON.stringify({ name: 'a', scripts: SCRIPTS, prettier: { semi: false } });
        expect(
          checkWorkspace(workspace({ 'packages/a': member('a', { 'package.json': pkg }) })),
        ).toEqual([
          'a: package.json must not set "prettier"; formatter configuration lives only in the root .prettierrc.json',
        ]);
      });
    });

    describe('tracked files that git ignores', () => {
      it('rejects a tracked file that an ignore rule matches', () => {
        const root = workspace({ 'packages/a': member('a') });
        expect(
          checkWorkspace(root, { trackedIgnored: ['packages/a/src/money/dist/f.ts'] }),
        ).toEqual([
          'packages/a/src/money/dist/f.ts: tracked by git but matched by an ignore rule, so lint and format skip it',
        ]);
      });

      it('lists tracked and ignored files from git, including a forced src/dist/tsconfig.json', () => {
        const root = workspace(
          { 'packages/a': member('a') },
          {
            '.gitignore': 'dist/\ncoverage/\n.turbo/\n',
            'packages/a/src/money/dist/f.ts': '',
            'packages/a/src/dist/tsconfig.json': '{}',
            'packages/a/src/coverage/g.ts': '',
            'packages/a/src/.turbo/h.ts': '',
          },
        );
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['add', '-f', 'packages/a/src'], { cwd: root });
        expect(trackedIgnored(root)).toEqual([
          'packages/a/src/.turbo/h.ts',
          'packages/a/src/coverage/g.ts',
          'packages/a/src/dist/tsconfig.json',
          'packages/a/src/money/dist/f.ts',
        ]);
      });
    });

    describe('config files inside nested ignored folder names', () => {
      it.each([
        ['packages/a/src/dist/tsconfig.json', 'tsconfig'],
        ['packages/a/src/coverage/.prettierrc', 'formatter'],
        ['packages/a/src/.turbo/tsconfig.json', 'tsconfig'],
        ['packages/a/src/node_modules/tsconfig.json', 'tsconfig'],
      ])('rejects %s', (path, kind) => {
        const root = workspace({ 'packages/a': member('a') }, { [path]: '{}' });
        expect(checkWorkspace(root)).toEqual([
          kind === 'tsconfig'
            ? `${path}: only the root tsconfig.json, tsconfig.base.json and the two at each member root are allowed`
            : `${path}: formatter configuration lives only in the root .prettierrc.json`,
        ]);
      });

      it('still skips the member and root output folders', () => {
        const root = workspace(
          { 'packages/a': member('a') },
          {
            'packages/a/dist/tsconfig.json': '{}',
            'packages/a/coverage/.prettierrc': '',
            'coverage/tsconfig.json': '{}',
            'node_modules/x/tsconfig.json': '{}',
            'packages/a/node_modules/x/.prettierrc': '',
          },
        );
        expect(checkWorkspace(root)).toEqual([]);
      });
    });

    describe('config names in any letter case', () => {
      it.each([
        ['packages/a/src/TSConfig.json', 'tsconfig'],
        ['packages/a/JSConfig.json', 'tsconfig'],
        ['packages/a/.PrettierRC', 'formatter'],
        ['packages/a/Prettier.Config.js', 'formatter'],
        ['packages/a/.EditorConfig', 'formatter'],
      ])('rejects %s', (path, kind) => {
        const root = workspace({ 'packages/a': member('a') }, { [path]: '{}' });
        expect(checkWorkspace(root)).toEqual([
          kind === 'tsconfig'
            ? `${path}: only the root tsconfig.json, tsconfig.base.json and the two at each member root are allowed`
            : `${path}: formatter configuration lives only in the root .prettierrc.json`,
        ]);
      });
    });

    describe('ignore files and member output folders', () => {
      it.each([
        'packages/a/.gitignore',
        'packages/a/src/.gitignore',
        'scripts/.gitignore',
        'packages/a/.GitIgnore',
      ])('rejects %s', (path) => {
        const root = workspace({ 'packages/a': member('a') }, { [path]: '!dist/x.js\n' });
        expect(checkWorkspace(root)).toEqual([
          `${path}: only the root .gitignore is allowed; a nested one can re-include ignored files`,
        ]);
      });

      it('accepts the root .gitignore', () => {
        const root = workspace({ 'packages/a': member('a') }, { '.gitignore': 'dist/\n' });
        expect(checkWorkspace(root)).toEqual([]);
      });

      it.each([
        'packages/a/dist/index.js',
        'packages/a/dist/index.d.ts',
        'packages/a/coverage/x.json',
        'packages/a/.turbo/x.log',
        'packages/a/build/x.js',
        'apps/b/out/index.html',
      ])('rejects the tracked path %s, whatever git ignores', (path) => {
        const root = workspace({ 'packages/a': member('a'), 'apps/b': member('b') });
        expect(checkWorkspace(root, { trackedFiles: [path, 'packages/a/src/index.ts'] })).toEqual([
          `${path}: tracked inside a member output folder, which the build replaces and lint skips`,
        ]);
      });

      it('accepts tracked source that only shares an output folder name deeper down', () => {
        const root = workspace({ 'packages/a': member('a') });
        expect(checkWorkspace(root, { trackedFiles: ['packages/a/src/build/x.ts'] })).toEqual([]);
      });

      it('lists tracked files from the git index, even those a nested .gitignore re-includes', () => {
        const root = workspace(
          { 'packages/a': member('a') },
          {
            '.gitignore': 'dist/\n',
            'packages/a/.gitignore': '!dist/\n',
            'packages/a/dist/index.js': 'console.log(1);\n',
          },
        );
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['add', '-A'], { cwd: root });
        expect(trackedIgnored(root)).toEqual([]);
        expect(trackedFiles(root)).toContain('packages/a/dist/index.js');
        expect(checkWorkspace(root, { trackedFiles: trackedFiles(root) })).toEqual([
          'packages/a/dist/index.js: tracked inside a member output folder, which the build replaces and lint skips',
          'packages/a/.gitignore: only the root .gitignore is allowed; a nested one can re-include ignored files',
        ]);
      });
    });
  });
});
