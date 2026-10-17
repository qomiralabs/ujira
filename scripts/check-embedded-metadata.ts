// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fails when a file carries an embedded provenance manifest (C2PA) or an XMP
// packet. These blocks can name the program that produced a file and are
// invisible in a text diff. With no arguments every file tracked by git is
// scanned; with arguments only those files are.
//
//   node scripts/check-embedded-metadata.ts [file...]
//
// Remove what it reports with scripts/strip-embedded-metadata.ts.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { findEmbeddedMetadata } from './embedded-metadata.ts';

const ROOT = join(import.meta.dirname, '..');

function trackedFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split('\0')
    .filter((file) => file !== '')
    .map((file) => join(ROOT, file));
}

const args = process.argv.slice(2);
const explicit = args.length > 0;
const files = explicit ? args.map((file) => resolve(file)) : trackedFiles();
const problems: string[] = [];
let scanned = 0;

for (const file of files) {
  const shown = relative(explicit ? process.cwd() : ROOT, file);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    // A tracked file deleted in the working tree has nothing left to scan.
    if (explicit) problems.push(`${shown}: no such file`);
    continue;
  }
  // Symlinks and submodules are not file content of this repository.
  if (!stat.isFile()) continue;
  scanned += 1;
  for (const reason of findEmbeddedMetadata(file, readFileSync(file))) {
    problems.push(`${shown}: ${reason}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `Embedded metadata check failed:\n  ${problems.join('\n  ')}\n` +
      'Remove it with: node scripts/strip-embedded-metadata.ts <file...>\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Embedded metadata check passed: ${String(scanned)} files scanned.\n`);
}
