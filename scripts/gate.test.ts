// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { globSync, readFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { ESLint } from 'eslint';
import * as prettier from 'prettier';

import { parse as parseYaml } from 'yaml';

import eslintConfig from '../eslint.config.js';
import vitestConfig from '../vitest.config.ts';
import { plan, run } from './gate.ts';
import {
  buildOrder,
  lintProjects,
  testProjects,
  workspaceDependencies,
  type Member,
} from './workspace.ts';

function member(name: string, path: string, manifest: Record<string, unknown> = {}): Member {
  return { dir: `/r/${path}`, path, name, manifest: { name, ...manifest } };
}

const core = member('@u/core', 'packages/core');
const ui = member('@u/ui', 'packages/ui', {
  dependencies: { '@u/core': 'workspace:*', react: '19' },
});
const web = member('@u/web', 'apps/web', {
  devDependencies: { '@u/ui': 'workspace:*' },
  peerDependencies: { '@u/web': 'workspace:*' },
});

describe('gate', () => {
  it('finds workspace dependencies in every dependency field, ignoring itself', () => {
    const names = new Set(['@u/core', '@u/ui', '@u/web']);
    expect(workspaceDependencies(ui, names)).toEqual(['@u/core']);
    expect(workspaceDependencies(web, names)).toEqual(['@u/ui']);
    expect(workspaceDependencies(member('x', 'packages/x', { dependencies: null }), names)).toEqual(
      [],
    );
  });

  it('orders members after the members they depend on', () => {
    expect(buildOrder([web, ui, core]).map((m) => m.name)).toEqual(
      ['@u/web', '@u/ui', '@u/core'].reverse(),
    );
  });

  it('keeps path order between independent members', () => {
    const b = member('b', 'packages/b');
    const a = member('a', 'packages/a');
    expect(buildOrder([b, a]).map((m) => m.name)).toEqual(['a', 'b']);
  });

  it('fails on a dependency cycle', () => {
    const a = member('a', 'packages/a', { dependencies: { b: 'workspace:*' } });
    const b = member('b', 'packages/b', { dependencies: { a: 'workspace:*' } });
    expect(() => buildOrder([a, b])).toThrow('workspace dependency cycle: a -> b -> a');
  });

  it('builds every member from its tsconfig.build.json, dependencies first', () => {
    expect(plan('build', '/r', [web, ui, core])).toEqual([
      {
        label: '@u/core build',
        args: ['-p', '/r/packages/core/tsconfig.build.json', '--noEmitOnError'],
      },
      {
        label: '@u/ui build',
        args: ['-p', '/r/packages/ui/tsconfig.build.json', '--noEmitOnError'],
      },
      { label: '@u/web build', args: ['-p', '/r/apps/web/tsconfig.build.json', '--noEmitOnError'] },
    ]);
  });

  it('typechecks the root and every member after building the members others need', () => {
    expect(plan('typecheck', '/r', [web, ui, core])).toEqual([
      {
        label: '@u/core build',
        args: ['-p', '/r/packages/core/tsconfig.build.json', '--noEmitOnError'],
      },
      {
        label: '@u/ui build',
        args: ['-p', '/r/packages/ui/tsconfig.build.json', '--noEmitOnError'],
      },
      { label: 'root typecheck', args: ['-p', '/r/tsconfig.json', '--noEmit'] },
      { label: '@u/core typecheck', args: ['-p', '/r/packages/core/tsconfig.json', '--noEmit'] },
      { label: '@u/ui typecheck', args: ['-p', '/r/packages/ui/tsconfig.json', '--noEmit'] },
      { label: '@u/web typecheck', args: ['-p', '/r/apps/web/tsconfig.json', '--noEmit'] },
    ]);
  });

  it('takes no flags from the member', () => {
    const sneaky = member('s', 'packages/s', { scripts: { typecheck: 'tsc --noCheck' } });
    for (const step of plan('typecheck', '/r', [sneaky])) {
      expect(step.args.filter((arg) => arg.startsWith('--'))).toEqual(
        step.label.endsWith('typecheck') ? ['--noEmit'] : ['--noEmitOnError'],
      );
    }
  });

  describe('run', () => {
    // A workspace with two members, b depending on a.
    function tree(yaml = 'packages:\n  - packages/*\n'): string {
      const root = mkdtempSync(join(tmpdir(), 'ujira-gate-'));
      writeFileSync(join(root, 'pnpm-workspace.yaml'), yaml);
      for (const [name, deps] of [
        ['a', {}],
        ['b', { a: 'workspace:*' }],
      ] as const) {
        mkdirSync(join(root, 'packages', name), { recursive: true });
        writeFileSync(
          join(root, 'packages', name, 'package.json'),
          JSON.stringify({ name, dependencies: deps }),
        );
      }
      return root;
    }

    function exec(
      root: string,
      task: 'typecheck' | 'build',
      fail: (args: readonly string[]) => boolean,
    ) {
      const calls: string[] = [];
      let out = '';
      let err = '';
      const status = run(task, root, {
        tsc: (args) => {
          calls.push(args.join(' ').replaceAll(root, '<root>'));
          return fail(args) ? 1 : 0;
        },
        out: (text) => (out += text),
        err: (text) => (err += text),
      });
      rmSync(root, { recursive: true, force: true });
      return { status, calls, out, err };
    }

    it('runs every step and passes when tsc passes', () => {
      const result = exec(tree(), 'typecheck', () => false);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([
        '-p <root>/packages/a/tsconfig.build.json --noEmitOnError',
        '-p <root>/tsconfig.json --noEmit',
        '-p <root>/packages/a/tsconfig.json --noEmit',
        '-p <root>/packages/b/tsconfig.json --noEmit',
      ]);
      expect(result.out).toContain('> tsc -p packages/a/tsconfig.build.json --noEmitOnError\n');
      expect(result.err).toBe('');
    });

    it('keeps typechecking after a failure and names every failed step', () => {
      const result = exec(tree(), 'typecheck', (args) =>
        args.some((a) => a.endsWith('tsconfig.json')),
      );
      expect(result.status).toBe(1);
      expect(result.calls).toHaveLength(4);
      expect(result.err).toBe('typecheck failed: root typecheck, a typecheck, b typecheck\n');
    });

    it('stops the build at the first failure', () => {
      const result = exec(tree(), 'build', () => true);
      expect(result.status).toBe(1);
      expect(result.calls).toEqual(['-p <root>/packages/a/tsconfig.build.json --noEmitOnError']);
      expect(result.err).toBe('build failed: a build\n');
    });

    it('fails without running tsc when the workspace file is unsupported', () => {
      const result = exec(tree('packages:\n  - packages/**\n'), 'build', () => false);
      expect(result.status).toBe(1);
      expect(result.calls).toEqual([]);
      expect(result.err).toContain('unsupported glob');
    });
  });

  describe('testProjects', () => {
    it('defines one inline project per member, so member Vitest configs are never loaded', () => {
      const root = mkdtempSync(join(tmpdir(), 'ujira-projects-'));
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      for (const name of ['b', 'a']) {
        mkdirSync(join(root, 'packages', name), { recursive: true });
        writeFileSync(
          join(root, 'packages', name, 'package.json'),
          JSON.stringify({ name: `@u/${name}` }),
        );
        writeFileSync(
          join(root, 'packages', name, 'vitest.config.ts'),
          'throw new Error("loaded");\n',
        );
      }
      const projects = testProjects(root);
      rmSync(root, { recursive: true, force: true });
      expect(projects).toEqual([
        {
          test: { name: '@u/a', root: join(root, 'packages', 'a'), include: ['src/**/*.test.ts'] },
        },
        {
          test: { name: '@u/b', root: join(root, 'packages', 'b'), include: ['src/**/*.test.ts'] },
        },
      ]);
    });

    it('applies per member settings from the root config', () => {
      const root = mkdtempSync(join(tmpdir(), 'ujira-projects-'));
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      for (const name of ['a', 'ui']) {
        mkdirSync(join(root, 'packages', name), { recursive: true });
        writeFileSync(
          join(root, 'packages', name, 'package.json'),
          JSON.stringify({ name: `@u/${name}` }),
        );
      }
      const projects = testProjects(root, {
        '@u/ui': {
          include: ['src/**/*.test.{ts,tsx}', 'tokens/**/*.test.ts'],
          environment: 'jsdom',
          setupFiles: ['./src/test-setup.ts'],
        },
      });
      expect(projects).toEqual([
        {
          test: { name: '@u/a', root: join(root, 'packages', 'a'), include: ['src/**/*.test.ts'] },
        },
        {
          test: {
            name: '@u/ui',
            root: join(root, 'packages', 'ui'),
            include: ['src/**/*.test.{ts,tsx}', 'tokens/**/*.test.ts'],
            environment: 'jsdom',
            setupFiles: ['./src/test-setup.ts'],
          },
        },
      ]);
      expect(() => testProjects(root, { '@u/gone': { include: ['x'] } })).toThrow(
        'test settings for "@u/gone", which is not a workspace member',
      );
      rmSync(root, { recursive: true, force: true });
    });

    it('fails on an unsupported workspace file', () => {
      const root = mkdtempSync(join(tmpdir(), 'ujira-projects-'));
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/**\n');
      expect(() => testProjects(root)).toThrow('unsupported glob');
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe('dist folders', () => {
    it('refuses to build when a member dist resolves outside the member', () => {
      const root = mkdtempSync(join(tmpdir(), 'ujira-gate-'));
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      mkdirSync(join(root, 'packages', 'a'), { recursive: true });
      mkdirSync(join(root, 'node_modules', 'eslint'), { recursive: true });
      writeFileSync(join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }));
      symlinkSync(join(root, 'node_modules', 'eslint'), join(root, 'packages', 'a', 'dist'));
      const calls: string[] = [];
      let err = '';
      const status = run('build', root, {
        tsc: (args) => {
          calls.push(args.join(' '));
          return 0;
        },
        out: () => undefined,
        err: (text) => (err += text),
      });
      rmSync(root, { recursive: true, force: true });
      expect(status).toBe(1);
      expect(calls).toEqual([]);
      expect(err).toContain('a: dist must be a folder inside the member');
    });
  });

  describe('lint projects', () => {
    it('lists the root tsconfig and every member tsconfig', () => {
      const root = mkdtempSync(join(tmpdir(), 'ujira-lint-'));
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      for (const name of ['b', 'a']) {
        mkdirSync(join(root, 'packages', name), { recursive: true });
        writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name }));
      }
      const projects = lintProjects(root);
      rmSync(root, { recursive: true, force: true });
      expect(projects).toEqual([
        './tsconfig.json',
        './packages/a/tsconfig.json',
        './packages/b/tsconfig.json',
      ]);
    });

    it('gives ESLint that explicit list instead of the nearest tsconfig', () => {
      const withParser = (
        eslintConfig as { languageOptions?: { parserOptions?: Record<string, unknown> } }[]
      )
        .map((entry) => entry.languageOptions?.parserOptions)
        .filter(
          (options) =>
            options !== undefined && ('project' in options || 'projectService' in options),
        );
      expect(withParser).toEqual([
        expect.objectContaining({
          project: lintProjects(join(import.meta.dirname, '..')),
        }),
      ]);
      expect(
        withParser.some((options) => options !== undefined && 'projectService' in options),
      ).toBe(false);
    });
  });

  describe('root scripts and CI', () => {
    const root = join(import.meta.dirname, '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    it('pins Prettier to the root config and ignores .editorconfig', () => {
      expect(pkg.scripts['format']).toBe(
        'prettier --config .prettierrc.json --no-editorconfig --ignore-path .prettierignore --write .',
      );
      expect(pkg.scripts['format:check']).toBe(
        'prettier --config .prettierrc.json --no-editorconfig --ignore-path .prettierignore --check .',
      );
    });

    it('loads the Vitest config without writing a bundled copy into node_modules', () => {
      // The default loader writes node_modules/.vite-temp, which fails on the
      // read-only checkout CI tests run on.
      expect(pkg.scripts['test']).toBe('vitest run --coverage --configLoader native');
    });

    it('builds before any test code runs in CI', () => {
      const workflow = parseYaml(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
        jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
      };
      const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
      const build = steps.findIndex((step) => step.run?.includes('pnpm build') === true);
      const test = steps.findIndex((step) => step.run?.includes('pnpm test') === true);
      expect(build).toBeGreaterThan(-1);
      expect(test).toBeGreaterThan(-1);
      expect(build).toBeLessThan(test);
    });
  });

  describe('ESLint under CI', () => {
    it('still type checks text that is not on disk when CI is set', async () => {
      const root = join(import.meta.dirname, '..');
      const before = process.env['CI'];
      process.env['CI'] = 'true';
      try {
        const eslint = new ESLint({ cwd: root });
        const [result] = await eslint.lintText(
          '// Copyright (c) 2026 Qomira Labs. All rights reserved.\n' +
            '// Proprietary and confidential. Unauthorized copying is prohibited.\n\n' +
            'export function half(value: number): number {\n  return value / 2;\n}\n',
          // An existing file with new text, the way the money lint tests run.
          { filePath: join(root, 'packages/core/src/money/money.ts') },
        );
        expect(result?.messages.map((m) => m.ruleId)).toContain('ujira/no-number-arithmetic');
        expect(result?.messages.some((m) => m.fatal === true)).toBe(false);
      } finally {
        if (before === undefined) delete process.env['CI'];
        else process.env['CI'] = before;
      }
    }, 60_000);
  });

  describe('ignore rules are anchored to the repository and member roots', () => {
    const root = join(import.meta.dirname, '..');

    it.each([
      ['packages/core/dist/index.js', true],
      ['packages/core/coverage/x.js', true],
      ['coverage/x.js', true],
      ['packages/core/.turbo/x.js', true],
      ['packages/core/src/money/dist/f.ts', false],
      ['packages/core/src/coverage/f.ts', false],
      ['packages/core/src/.turbo/f.ts', false],
    ])('ESLint ignores %s: %s', async (path, ignored) => {
      const eslint = new ESLint({ cwd: root });
      expect(await eslint.isPathIgnored(join(root, path))).toBe(ignored);
    });

    it.each([
      ['packages/core/dist/index.js', true],
      ['coverage/x.js', true],
      ['packages/core/src/money/dist/f.ts', false],
      ['packages/core/src/coverage/f.ts', false],
    ])('Prettier ignores %s: %s', async (path, ignored) => {
      const info = await prettier.getFileInfo(join(root, path), {
        ignorePath: join(root, '.prettierignore'),
      });
      expect(info.ignored).toBe(ignored);
    });

    it('reads only .prettierignore, not .gitignore', () => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts['format:check']).toContain('--ignore-path .prettierignore');
      expect(pkg.scripts['format']).toContain('--ignore-path .prettierignore');
    });
  });

  describe('test projects cover every test file', () => {
    const root = join(import.meta.dirname, '..');

    it('includes every tracked test file in some project', () => {
      const projects = (
        vitestConfig as { test: { projects: { test: { root?: string; include: string[] } }[] } }
      ).test.projects;
      const covered = new Set(
        projects.flatMap(({ test }) => {
          const base = test.root ?? root;
          return globSync(test.include, { cwd: base }).map((file) =>
            relative(root, join(base, file)).split('\\').join('/'),
          );
        }),
      );
      const tracked = execFileSync('git', ['ls-files', '-z', '*.test.ts', '*.test.tsx'], {
        cwd: root,
        encoding: 'utf8',
      })
        .split('\0')
        .filter((file) => file !== '');
      expect(tracked.filter((file) => !covered.has(file))).toEqual([]);
    });

    it('passes per member timeouts through', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ujira-projects-'));
      writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      mkdirSync(join(tmp, 'packages', 'p'), { recursive: true });
      writeFileSync(join(tmp, 'packages', 'p', 'package.json'), JSON.stringify({ name: '@u/p' }));
      const [project] = testProjects(tmp, {
        '@u/p': { include: ['spikes/**/*.test.ts'], hookTimeout: 180_000, testTimeout: 60_000 },
      });
      rmSync(tmp, { recursive: true, force: true });
      expect(project?.test).toEqual(
        expect.objectContaining({ hookTimeout: 180_000, testTimeout: 60_000 }),
      );
    });

    it('keeps the Vitest cache outside node_modules and the checkout', () => {
      const cacheDir = (vitestConfig as { cacheDir?: string }).cacheDir ?? '';
      expect(cacheDir).not.toBe('');
      expect(relative(root, cacheDir).startsWith('..')).toBe(true);
      // Vitest keeps transformed modules in a second cache, by default
      // node_modules/.vitest-cache.
      const modules =
        (vitestConfig as { test?: { fsModuleCachePath?: string } }).test?.fsModuleCachePath ?? '';
      expect(modules).not.toBe('');
      expect(relative(root, modules).startsWith('..')).toBe(true);
    });
  });

  describe('the test step cannot change the checkout', () => {
    const root = join(import.meta.dirname, '..');
    const workflow = parseYaml(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<
        string,
        { steps: { name?: string; run?: string; with?: Record<string, unknown> }[] }
      >;
    };
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    const testIndex = steps.findIndex((step) => step.run?.includes('pnpm test') === true);
    const testStep = steps[testIndex];

    it('runs the tests on a read-only mount of the checkout, node_modules included', () => {
      expect(testStep?.run).toMatch(/sudo mount --bind "\$\{?PWD\}?" "\$\{?PWD\}?"/);
      expect(testStep?.run).toMatch(/sudo mount -o remount,bind,ro "\$\{?PWD\}?"/);
      expect(testStep?.run).toContain('--coverage.reportsDirectory="${RUNNER_TEMP}/coverage"');
      expect(testStep?.run).toContain('--outputFile.junit="${RUNNER_TEMP}/vitest/junit.xml"');
    });

    it('checks the tree and node_modules after the tests', () => {
      const after = steps.slice(testIndex + 1);
      const check = after.find(
        (step) => step.name === 'Working tree and node_modules unchanged after test',
      );
      expect(check?.run).toContain('git status --porcelain --untracked-files=all');
      expect(check?.run).toContain('-newer');
    });
  });

  describe('dangling dist', () => {
    it('reports a dangling dist symlink instead of throwing', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ujira-gate-'));
      writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      mkdirSync(join(tmp, 'packages', 'a'), { recursive: true });
      writeFileSync(join(tmp, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }));
      symlinkSync(join(tmp, 'nowhere'), join(tmp, 'packages', 'a', 'dist'));
      let err = '';
      const status = run('build', tmp, {
        tsc: () => 0,
        out: () => undefined,
        err: (text) => (err += text),
      });
      rmSync(tmp, { recursive: true, force: true });
      expect(status).toBe(1);
      expect(err).toContain('a: dist must be a folder inside the member');
    });
  });
});
