// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Root gate for typecheck and build. Runs a fixed tsc command for every
// workspace member and never runs package scripts, so what a package script
// says cannot change what the gate checks. tsc is resolved from the
// typescript package and run with the current node binary, not looked up on
// PATH, so a dependency that ships a `tsc` bin cannot stand in for it.
//
//   node scripts/gate.ts typecheck   root tsconfig.json, then each member's tsconfig.json
//   node scripts/gate.ts build       each member's tsconfig.build.json, dependencies first

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import {
  buildOrder,
  listMembers,
  readWorkspaceGlobs,
  workspaceDependencies,
  type Member,
} from './workspace.ts';

const ROOT = join(import.meta.dirname, '..');
const TSC = createRequire(join(ROOT, 'package.json')).resolve('typescript/bin/tsc');

export type Task = 'typecheck' | 'build';

export interface Step {
  label: string;
  args: string[];
}

// The exact tsc invocations for a task. Only the project file differs between
// members; no flag comes from the member.
// A build that fails must not leave output behind, inside dist or next to a
// source outside rootDir.
function buildStep(m: Member): Step {
  return {
    label: `${m.name} build`,
    args: ['-p', join(m.dir, 'tsconfig.build.json'), '--noEmitOnError'],
  };
}

// The member's dist, when it exists, must be a real folder inside the member,
// so the build cannot write through a link into node_modules or elsewhere.
function distProblem(memberDir: string): string | undefined {
  const dist = join(memberDir, 'dist');
  if (!existsSync(dist) && !isLink(dist)) return undefined;
  const stat = lstatSync(dist);
  const real = realpathSync(dist);
  const inside = real.startsWith(realpathSync(memberDir) + sep);
  return stat.isDirectory() && !stat.isSymbolicLink() && inside
    ? undefined
    : 'dist must be a folder inside the member';
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function plan(task: Task, root: string, members: readonly Member[]): Step[] {
  const ordered = buildOrder(members);
  if (task === 'build') {
    return ordered.map(buildStep);
  }
  // Members typecheck against the built output of the members they depend on,
  // so those are built first.
  const names = new Set(members.map((m) => m.name));
  const needed = new Set(members.flatMap((m) => workspaceDependencies(m, names)));
  return [
    ...ordered.filter((m) => needed.has(m.name)).map(buildStep),
    { label: 'root typecheck', args: ['-p', join(root, 'tsconfig.json'), '--noEmit'] },
    ...ordered.map((m) => ({
      label: `${m.name} typecheck`,
      args: ['-p', join(m.dir, 'tsconfig.json'), '--noEmit'],
    })),
  ];
}

export interface Io {
  // Runs tsc with these arguments and returns its exit status.
  tsc(args: readonly string[]): number | null;
  out(text: string): void;
  err(text: string): void;
}

export function run(task: Task, root: string, io: Io): number {
  const { globs, problems } = readWorkspaceGlobs(root);
  if (problems.length > 0) {
    io.err(`${problems.join('\n')}\n`);
    return 1;
  }
  const failed: string[] = [];
  for (const step of plan(task, root, listMembers(root, globs))) {
    io.out(
      `> tsc ${step.args.map((a) => (a.startsWith(root) ? relative(root, a) : a)).join(' ')}\n`,
    );
    const project = step.args[1] ?? '';
    if (project.endsWith('tsconfig.build.json')) {
      const problem = distProblem(dirname(project));
      if (problem !== undefined) {
        failed.push(step.label);
        io.err(`${step.label.slice(0, -' build'.length)}: ${problem}\n`);
        break;
      }
    }
    if (io.tsc(step.args) !== 0) {
      failed.push(step.label);
      // A failed build leaves later members without the output they need.
      if (task === 'build') break;
    }
  }
  if (failed.length > 0) {
    io.err(`${task} failed: ${failed.join(', ')}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  const task = process.argv[2];
  if (task !== 'typecheck' && task !== 'build') {
    process.stderr.write('usage: node scripts/gate.ts typecheck|build\n');
    process.exitCode = 2;
  } else {
    process.exitCode = run(task, ROOT, {
      tsc: (args) =>
        spawnSync(process.execPath, [TSC, ...args], { cwd: ROOT, stdio: 'inherit' }).status,
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    });
  }
}
