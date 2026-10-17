// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fails on literal invisible, bidirectional control and separator characters
// in tracked text files, naming the file, line, column and code point. Tests
// and data that need such a character must write it as an escape. The no
// break space, narrow no break space and minus sign are also rejected except
// in the files listed in scripts/invisible-characters-allowlist.txt.
//
//   node scripts/check-invisible-characters.ts [repository root]
//
// Exit codes: 0 clean, 1 findings named on stderr, 2 the tree could not be
// listed.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import {
  findInvisibleCharacters,
  formatCodePoint,
  parseAllowlist,
  showPath,
} from './invisible-characters.ts';

const ALLOWLIST = 'scripts/invisible-characters-allowlist.txt';
const UNICODE = process.versions['unicode'] ?? 'unknown';
const start = process.argv[2] ?? join(import.meta.dirname, '..');

let root: string;
let listing: Buffer;
try {
  root = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  listing = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached'], {
    maxBuffer: 256 * 1024 * 1024,
  });
} catch {
  process.stderr.write(`check-invisible-characters: ${start} is not inside a git work tree\n`);
  process.exit(2);
}

const allowlistPath = join(root, ALLOWLIST);
const allowed = existsSync(allowlistPath)
  ? parseAllowlist(readFileSync(allowlistPath, 'utf8'))
  : new Set<string>();

const problems: string[] = [];
let textFiles = 0;
let binaryFiles = 0;
const rootBytes = Buffer.from(root + sep);
const seen = new Set<string>();
let from = 0;
for (let end = listing.indexOf(0); end !== -1; end = listing.indexOf(0, from)) {
  const name = listing.subarray(from, end);
  from = end + 1;
  // git lists a conflicted file once per stage; scan it once.
  const key = name.toString('latin1');
  if (seen.has(key)) continue;
  seen.add(key);
  const shown = showPath(name);
  const path = Buffer.concat([rootBytes, name]);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    problems.push(`${shown}: tracked but missing from the working tree`);
    continue;
  }
  // Symlink targets and submodules are not file content of this repository.
  if (!stat.isFile()) continue;
  const scan = findInvisibleCharacters(
    name.toString('utf8'),
    readFileSync(path),
    allowed.has(name.toString('utf8')),
  );
  if (scan.kind === 'binary') {
    binaryFiles += 1;
  } else if (scan.kind === 'mismatch') {
    problems.push(`${shown}: named .${scan.extension} but its content is not ${scan.extension}`);
  } else if (scan.kind === 'invalid') {
    problems.push(`${shown}: not valid UTF-8 text`);
  } else {
    textFiles += 1;
    for (const { line, column, codePoint } of scan.findings) {
      problems.push(`${shown}:${String(line)}:${String(column)}: ${formatCodePoint(codePoint)}`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `Invisible character check failed (Unicode ${UNICODE}):\n  ${problems.join('\n  ')}\n` +
      'Write these characters as escapes. Lookalike spaces and minus signs may be allowed per file in ' +
      `${ALLOWLIST}.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Invisible character check passed: ${String(textFiles)} text files, ${String(binaryFiles)} binary files skipped (Unicode ${UNICODE}).\n`,
  );
}
