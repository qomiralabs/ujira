// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Root gate for typecheck and build. Runs a fixed tsc command for every
// workspace member and never runs package scripts, so what a package script
// says cannot change what the gate checks. tsc is resolved from the
// typescript package and run with the current node binary, not looked up on
// PATH, so a dependency that ships a `tsc` bin cannot stand in for it.
// Next.js apps are built with `next build`, resolved the same way from the
// app's own next dependency.
//
//   node scripts/gate.ts typecheck   root tsconfig.json, then each member's tsconfig.json
//   node scripts/gate.ts build       each member's tsconfig.build.json, or next build for a
//                                    Next.js app, dependencies first

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import {
  buildOrder,
  isNextApp,
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
  tool: 'tsc' | 'next';
  args: string[];
}

// The exact tsc invocations for a task. Only the project file differs between
// members; no flag comes from the member.
// A build that fails must not leave output behind, inside dist or next to a
// source outside rootDir.
function buildStep(m: Member): Step {
  if (isNextApp(m.manifest, m.dir)) {
    return { label: `${m.name} build`, tool: 'next', args: ['build', m.dir] };
  }
  return {
    label: `${m.name} build`,
    tool: 'tsc',
    args: ['-p', join(m.dir, 'tsconfig.build.json'), '--noEmitOnError'],
  };
}

// The member folder a build step writes into, and the output folder it uses.
function buildOutput(step: Step): { dir: string; output: string } | undefined {
  if (step.tool === 'next') return { dir: step.args[1] ?? '', output: '.next' };
  const project = step.args[1] ?? '';
  return project.endsWith('tsconfig.build.json')
    ? { dir: dirname(project), output: 'dist' }
    : undefined;
}

// The member's output folder, when it exists, must be a real folder inside
// the member, so the build cannot write through a link into node_modules or
// elsewhere.
function outputProblem(memberDir: string, output: string): string | undefined {
  const folder = join(memberDir, output);
  if (!existsSync(folder) && !isLink(folder)) return undefined;
  const stat = lstatSync(folder);
  let real: string;
  try {
    real = realpathSync(folder);
  } catch {
    // A dangling symlink: nothing a build could safely write into.
    return `${output} must be a folder inside the member`;
  }
  const inside = real.startsWith(realpathSync(memberDir) + sep);
  return stat.isDirectory() && !stat.isSymbolicLink() && inside
    ? undefined
    : `${output} must be a folder inside the member`;
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
    { label: 'root typecheck', tool: 'tsc', args: ['-p', join(root, 'tsconfig.json'), '--noEmit'] },
    ...ordered.map((m): Step => ({
      label: `${m.name} typecheck`,
      tool: 'tsc',
      args: ['-p', join(m.dir, 'tsconfig.json'), '--noEmit'],
    })),
  ];
}

export interface Io {
  // Runs tsc with these arguments and returns its exit status.
  tsc(args: readonly string[]): number | null;
  // Runs next with these arguments, the app folder last, and returns its exit status.
  next(args: readonly string[]): number | null;
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
      `> ${step.tool} ${step.args.map((a) => (a.startsWith(root) ? relative(root, a) : a)).join(' ')}\n`,
    );
    const target = buildOutput(step);
    if (target !== undefined) {
      const problem = outputProblem(target.dir, target.output);
      if (problem !== undefined) {
        failed.push(step.label);
        io.err(`${step.label.slice(0, -' build'.length)}: ${problem}\n`);
        break;
      }
      // Start from an empty dist, so nothing committed or left there by an
      // earlier run can end up in the build output. next build empties .next
      // itself and keeps only its cache and a running dev server's folder.
      if (step.tool === 'tsc') {
        rmSync(join(target.dir, target.output), { recursive: true, force: true });
      }
    }
    const status = step.tool === 'next' ? io.next(step.args) : io.tsc(step.args);
    if (status !== 0) {
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
      next: (args) => {
        const app = args.at(-1) ?? '';
        let bin: string;
        try {
          bin = createRequire(join(app, 'package.json')).resolve('next/dist/bin/next');
        } catch {
          process.stderr.write(`${relative(ROOT, app)}: next is not installed\n`);
          return 1;
        }
        // Telemetry stays off, so no build reports to the Next.js team.
        return spawnSync(process.execPath, [bin, ...args], {
          cwd: ROOT,
          stdio: 'inherit',
          env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
        }).status;
      },
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    });
  }
}
