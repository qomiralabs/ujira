// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { plan, run } from './gate.ts';
import { buildOrder, workspaceDependencies, type Member } from './workspace.ts';

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
      { label: '@u/core build', args: ['-p', '/r/packages/core/tsconfig.build.json'] },
      { label: '@u/ui build', args: ['-p', '/r/packages/ui/tsconfig.build.json'] },
      { label: '@u/web build', args: ['-p', '/r/apps/web/tsconfig.build.json'] },
    ]);
  });

  it('typechecks the root and every member after building the members others need', () => {
    expect(plan('typecheck', '/r', [web, ui, core])).toEqual([
      { label: '@u/core build', args: ['-p', '/r/packages/core/tsconfig.build.json'] },
      { label: '@u/ui build', args: ['-p', '/r/packages/ui/tsconfig.build.json'] },
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
        step.label.endsWith('typecheck') ? ['--noEmit'] : [],
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
        '-p <root>/packages/a/tsconfig.build.json',
        '-p <root>/tsconfig.json --noEmit',
        '-p <root>/packages/a/tsconfig.json --noEmit',
        '-p <root>/packages/b/tsconfig.json --noEmit',
      ]);
      expect(result.out).toContain('> tsc -p packages/a/tsconfig.build.json\n');
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
      expect(result.calls).toEqual(['-p <root>/packages/a/tsconfig.build.json']);
      expect(result.err).toBe('build failed: a build\n');
    });

    it('fails without running tsc when the workspace file is unsupported', () => {
      const result = exec(tree('packages:\n  - packages/**\n'), 'build', () => false);
      expect(result.status).toBe(1);
      expect(result.calls).toEqual([]);
      expect(result.err).toContain('unsupported glob');
    });
  });
});
