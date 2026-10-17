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
import { join, sep } from 'node:path';

import { findEmbeddedMetadata, showPath } from './embedded-metadata.ts';

const ROOT = join(import.meta.dirname, '..');

interface Listed {
  // Raw bytes, so a name that is not valid UTF-8 still opens the real file.
  path: Buffer;
  shown: string;
}

function trackedFiles(): Listed[] {
  const output = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  const root = Buffer.from(ROOT + sep);
  const listed: Listed[] = [];
  let start = 0;
  for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
    const name = output.subarray(start, end);
    listed.push({ path: Buffer.concat([root, name]), shown: showPath(name) });
    start = end + 1;
  }
  return listed;
}

const args = process.argv.slice(2);
const explicit = args.length > 0;
const files = explicit
  ? args.map((file) => ({ path: Buffer.from(file), shown: showPath(Buffer.from(file)) }))
  : trackedFiles();
const problems: string[] = [];
let scanned = 0;

for (const { path, shown } of files) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    // Fail closed: a file that cannot be opened cannot be vouched for.
    problems.push(
      `${shown}: ${explicit ? 'no such file' : 'tracked but missing from the working tree'}`,
    );
    continue;
  }
  // Symlinks and submodules are not file content of this repository.
  if (!stat.isFile()) continue;
  scanned += 1;
  for (const reason of findEmbeddedMetadata(path.toString('latin1'), readFileSync(path))) {
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
  process.stdout.write(
    `Embedded metadata check passed: ${String(scanned)} of ${String(files.length)} listed files scanned.\n`,
  );
}
