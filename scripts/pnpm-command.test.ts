// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import {
  licensesListArgs,
  PnpmCommandError,
  resolvePnpmCommand,
  type PathInspector,
} from './pnpm-command.ts';

const ROOT = '/work/repo';
const NODE = '/usr/bin/node';

// Every path exists and resolves to itself unless listed in `links`.
function inspector(
  packages: Record<string, string> = {},
  links: Record<string, string | undefined> = {},
): PathInspector {
  return {
    realpath: (path) => (path in links ? links[path] : path),
    packageName: (dir) => packages[dir],
  };
}

describe('pnpm-command', () => {
  it('lists every workspace project, not only the root', () => {
    expect(licensesListArgs('prod')).toEqual(['licenses', 'list', '--json', '-r', '--prod']);
    expect(licensesListArgs('dev')).toEqual(['licenses', 'list', '--json', '-r', '--dev']);
  });

  it('runs a native pnpm binary directly', () => {
    const path = '/home/me/.cache/node/corepack/v1/pnpm/12.14.0/pnpm-native';
    expect(resolvePnpmCommand(path, NODE, ROOT, ['x'], inspector())).toEqual({
      file: path,
      args: ['x'],
    });
  });

  it('runs a JavaScript pnpm entry point through the current node binary', () => {
    const path = '/opt/pnpm/bin/pnpm.cjs';
    expect(resolvePnpmCommand(path, NODE, ROOT, ['x'], inspector())).toEqual({
      file: NODE,
      args: [path, 'x'],
    });
  });

  it('accepts pnpm installed in a node_modules folder outside the repository', () => {
    const path = '/home/runner/setup-pnpm/node_modules/pnpm/pnpm';
    const packages = { '/home/runner/setup-pnpm/node_modules/pnpm': 'pnpm' };
    expect(resolvePnpmCommand(path, NODE, ROOT, [], inspector(packages)).file).toBe(path);
    const exe = '/home/runner/setup-pnpm/node_modules/@pnpm/exe/pnpm';
    const exePackages = { '/home/runner/setup-pnpm/node_modules/@pnpm/exe': '@pnpm/exe' };
    expect(resolvePnpmCommand(exe, NODE, ROOT, [], inspector(exePackages)).file).toBe(exe);
  });

  it('fails when npm_execpath is missing or empty', () => {
    expect(() => resolvePnpmCommand(undefined, NODE, ROOT, [], inspector())).toThrow(
      /npm_execpath is not set/,
    );
    expect(() => resolvePnpmCommand(' ', NODE, ROOT, [], inspector())).toThrow(PnpmCommandError);
  });

  it('fails on a relative or missing npm_execpath', () => {
    expect(() => resolvePnpmCommand('pnpm', NODE, ROOT, [], inspector())).toThrow(
      /not an absolute path/,
    );
    const missing = '/nowhere/pnpm';
    expect(() =>
      resolvePnpmCommand(missing, NODE, ROOT, [], inspector({}, { [missing]: undefined })),
    ).toThrow(/does not exist/);
  });

  it('refuses a pnpm bin shipped by a dependency of the repository', () => {
    const bin = `${ROOT}/node_modules/.bin/pnpm`;
    const target = `${ROOT}/node_modules/.pnpm/fx-pnpmbin@1.0.0/node_modules/fx-pnpmbin/x.js`;
    expect(() => resolvePnpmCommand(bin, NODE, ROOT, [], inspector({}, { [bin]: target }))).toThrow(
      /inside the repository/,
    );
    expect(() => resolvePnpmCommand(ROOT, NODE, ROOT, [], inspector())).toThrow(
      /inside the repository/,
    );
  });

  it('compares against the real path of the repository', () => {
    const bin = '/private/work/repo/node_modules/.bin/pnpm';
    expect(() =>
      resolvePnpmCommand(bin, NODE, ROOT, [], inspector({}, { [ROOT]: '/private/work/repo' })),
    ).toThrow(/inside the repository/);
  });

  it('refuses a node_modules path outside the repository that is not the pnpm package', () => {
    const store = '/home/me/.pnpm-store/links/fx-pnpmbin/node_modules/fx-pnpmbin/x.js';
    const packages = {
      '/home/me/.pnpm-store/links/fx-pnpmbin/node_modules/fx-pnpmbin': 'fx-pnpmbin',
    };
    expect(() => resolvePnpmCommand(store, NODE, ROOT, [], inspector(packages))).toThrow(
      /belongs to "fx-pnpmbin", not pnpm/,
    );
    expect(() => resolvePnpmCommand('/x/node_modules/pnpm', NODE, ROOT, [], inspector())).toThrow(
      /belongs to "no package", not pnpm/,
    );
  });

  it('does not treat a sibling folder that shares the repository prefix as inside it', () => {
    const path = '/work/repo-tools/pnpm';
    expect(resolvePnpmCommand(path, NODE, ROOT, [], inspector()).file).toBe(path);
  });
});
