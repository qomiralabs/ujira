// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Decides how to run pnpm without a PATH lookup. Under `pnpm run`,
// node_modules/.bin comes first on PATH, so any dependency that ships a bin
// named `pnpm` would otherwise answer for pnpm. pnpm sets npm_execpath to its
// own executable; that path is used only when it is outside the repository
// and, if it sits in a node_modules folder, belongs to the pnpm package.

import { dirname, isAbsolute, sep } from 'node:path';

export interface PathInspector {
  // Resolved real path, or undefined when the path does not exist.
  realpath(path: string): string | undefined;
  // `name` from the package.json in `dir`, or undefined when there is none.
  packageName(dir: string): string | undefined;
}

export interface Command {
  file: string;
  args: string[];
}

export class PnpmCommandError extends Error {}

const SCRIPT_EXTENSIONS = /\.(?:c|m)?js$/;

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function owningPackage(path: string, inspector: PathInspector): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const name = inspector.packageName(dir);
    if (name !== undefined) return name;
    if (dirname(dir) === dir) return undefined;
  }
}

export function resolvePnpmCommand(
  execpath: string | undefined,
  nodePath: string,
  root: string,
  args: readonly string[],
  inspector: PathInspector,
): Command {
  if (execpath === undefined || execpath.trim() === '') {
    throw new PnpmCommandError(
      'npm_execpath is not set. Run this check through pnpm: `pnpm licenses:check`.',
    );
  }
  if (!isAbsolute(execpath)) {
    throw new PnpmCommandError(`npm_execpath "${execpath}" is not an absolute path`);
  }
  const real = inspector.realpath(execpath);
  if (real === undefined) throw new PnpmCommandError(`npm_execpath "${execpath}" does not exist`);
  const realRoot = inspector.realpath(root) ?? root;
  if (isInside(real, realRoot)) {
    throw new PnpmCommandError(
      `npm_execpath "${real}" is inside the repository; refusing to run a pnpm installed as a dependency`,
    );
  }
  if (real.split(sep).includes('node_modules')) {
    const owner = owningPackage(real, inspector);
    if (owner !== 'pnpm' && !owner?.startsWith('@pnpm/')) {
      throw new PnpmCommandError(
        `npm_execpath "${real}" is inside node_modules but belongs to "${owner ?? 'no package'}", not pnpm`,
      );
    }
  }
  return SCRIPT_EXTENSIONS.test(real)
    ? { file: nodePath, args: [real, ...args] }
    : { file: real, args: [...args] };
}

export function licensesListArgs(scope: 'prod' | 'dev'): string[] {
  // -r includes every workspace project, not only the root.
  return ['licenses', 'list', '--json', '-r', `--${scope}`];
}
