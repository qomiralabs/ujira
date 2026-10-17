// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every character planted here is written as an escape, so this file never
// holds one literally and passes the check it tests.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  findInvisibleCharacters,
  formatCodePoint,
  parseAllowlist,
  showPath,
} from './invisible-characters.ts';

const CHECK = join(import.meta.dirname, 'check-invisible-characters.ts');
const scratch = mkdtempSync(join(tmpdir(), 'invisible-characters-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// Format, line separator and paragraph separator characters (Cf, Zl, Zp).
const ALWAYS_REJECTED: readonly [number, string][] = [
  [0xfeff, 'byte order mark'],
  [0x200b, 'zero width space'],
  [0x200c, 'zero width non-joiner'],
  [0x200d, 'zero width joiner'],
  [0x200e, 'left to right mark'],
  [0x200f, 'right to left mark'],
  [0x202a, 'left to right embedding'],
  [0x202b, 'right to left embedding'],
  [0x202c, 'pop directional formatting'],
  [0x202d, 'left to right override'],
  [0x202e, 'right to left override'],
  [0x2066, 'left to right isolate'],
  [0x2067, 'right to left isolate'],
  [0x2068, 'first strong isolate'],
  [0x2069, 'pop directional isolate'],
  [0x2028, 'line separator'],
  [0x2029, 'paragraph separator'],
  [0x00ad, 'soft hyphen'],
  [0x2060, 'word joiner'],
  [0xe0001, 'language tag'],
];

// Lookalike spaces and minus, allowed only in allowlisted files.
const LOOKALIKES: readonly [number, string][] = [
  [0x00a0, 'no break space'],
  [0x202f, 'narrow no break space'],
  [0x2212, 'minus sign'],
];

function hex(point: number): string {
  return `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;
}

// Test cases titled with the code point in hex, then the name.
function labelled(cases: readonly (readonly [number, string])[]): [string, string, number][] {
  return cases.map(([point, name]) => [hex(point), name, point]);
}

function text(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

let repoCount = 0;
function repo(files: Record<string, Buffer | string>, allowlist?: string): string {
  repoCount += 1;
  const dir = join(scratch, `repo-${String(repoCount)}`);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  if (allowlist !== undefined) {
    writeFileSync(join(dir, 'scripts/invisible-characters-allowlist.txt'), allowlist);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

function check(root: string) {
  return spawnSync(process.execPath, [CHECK, root], { encoding: 'utf8' });
}

describe('findInvisibleCharacters', () => {
  it.each(labelled(ALWAYS_REJECTED))(
    'reports %s (%s) with its line and column',
    (_label, _name, point) => {
      const content = text(`first line\nab${String.fromCodePoint(point)}c\n`);
      expect(findInvisibleCharacters(content, false)).toEqual({
        kind: 'text',
        findings: [{ line: 2, column: 3, codePoint: point }],
      });
      // An allowlisted file still fails on these.
      expect(findInvisibleCharacters(content, true)).toEqual({
        kind: 'text',
        findings: [{ line: 2, column: 3, codePoint: point }],
      });
    },
  );

  it.each(labelled(LOOKALIKES))(
    'reports %s (%s) unless the file is allowlisted',
    (_label, _name, point) => {
      const content = text(`x${String.fromCodePoint(point)}y`);
      expect(findInvisibleCharacters(content, false)).toEqual({
        kind: 'text',
        findings: [{ line: 1, column: 2, codePoint: point }],
      });
      expect(findInvisibleCharacters(content, true)).toEqual({ kind: 'text', findings: [] });
    },
  );

  it('counts columns in code points and reports every occurrence', () => {
    const content = text('\u{1F600}\u200B\n\n  \u2060\u2060');
    expect(findInvisibleCharacters(content, false)).toEqual({
      kind: 'text',
      findings: [
        { line: 1, column: 2, codePoint: 0x200b },
        { line: 3, column: 3, codePoint: 0x2060 },
        { line: 3, column: 4, codePoint: 0x2060 },
      ],
    });
  });

  it('passes ordinary text, including other non ASCII letters and spaces', () => {
    expect(
      findInvisibleCharacters(text('caf\u00E9 na\u00EFve \u4E2D\u6587\ttab\r\n'), false),
    ).toEqual({ kind: 'text', findings: [] });
  });

  it('skips binary content by its NUL bytes, whatever the name', () => {
    const content = Buffer.concat([text('\uFEFF'), Buffer.from([0]), text('\u202E')]);
    expect(findInvisibleCharacters(content, false)).toEqual({ kind: 'binary' });
  });

  it('reports text that is not valid UTF-8', () => {
    expect(findInvisibleCharacters(Buffer.from([0x61, 0xff, 0x62]), false)).toEqual({
      kind: 'invalid',
    });
  });
});

describe('parseAllowlist', () => {
  it('reads one path per line and ignores comments and blank lines', () => {
    expect(parseAllowlist('# comment\n\ndocs/a.md\n  b.txt  \r\n')).toEqual(
      new Set(['docs/a.md', 'b.txt']),
    );
  });
});

describe('formatCodePoint', () => {
  it('pads to four hex digits and keeps longer ones', () => {
    expect(formatCodePoint(0xa0)).toBe('U+00A0');
    expect(formatCodePoint(0xe0001)).toBe('U+E0001');
  });
});

describe('showPath', () => {
  it('prints plain names as they are and escapes anything unsafe', () => {
    expect(showPath(text('docs/a.md'))).toBe('docs/a.md');
    expect(showPath(text('a\nb.md'))).toBe('"a\\x0ab.md"');
    expect(showPath(text('a\u202Eb.md'))).toBe('"a\\xe2\\x80\\xaeb.md"');
    expect(showPath(Buffer.from([0x61, 0xff]))).toBe('"a\\xff"');
  });
});

describe('check-invisible-characters', () => {
  it.each(labelled([...ALWAYS_REJECTED, ...LOOKALIKES]))(
    'fails on a planted %s (%s), naming the file, line and code point',
    (_label, _name, point) => {
      const root = repo({ 'src/planted.ts': `ok\nx${String.fromCodePoint(point)}\n` });
      const result = check(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`src/planted.ts:2:2: ${hex(point)}`);
    },
  );

  it('passes a clean tree and skips binary files by content', () => {
    const root = repo({
      'a.ts': 'clean\n',
      // A text extension does not make binary content text.
      'image.txt': Buffer.concat([Buffer.from([0x89, 0x00]), text('\u202E')]),
    });
    const result = check(root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Invisible character check passed: 1 text files, 1 binary/);
  });

  it('allows lookalikes only in allowlisted files', () => {
    const root = repo(
      { 'docs/typeset.md': 'a\u00A0b\n', 'docs/other.md': 'a\u00A0b\n' },
      '# Typeset prose\ndocs/typeset.md\n',
    );
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/other.md:1:2: U+00A0');
    expect(result.stderr).not.toContain('docs/typeset.md');
  });

  it('fails on invalid UTF-8, a tracked file that is missing, and escapes names', () => {
    const root = repo({
      'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      'gone.ts': 'x\n',
      'bad\nname.ts': '\u200B',
    });
    rmSync(join(root, 'gone.ts'));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('latin1.txt: not valid UTF-8 text');
    expect(result.stderr).toContain('gone.ts: tracked but missing from the working tree');
    expect(result.stderr).toContain('"bad\\x0aname.ts":1:1: U+200B');
  });

  it('does not follow symlinks', () => {
    const outside = join(scratch, 'outside.txt');
    writeFileSync(outside, '\u202E');
    const root = repo({ 'a.ts': 'clean\n' });
    symlinkSync(outside, join(root, 'link.txt'));
    execFileSync('git', ['add', 'link.txt'], { cwd: root });
    expect(check(root).status).toBe(0);
  });

  it('exits 2 outside a git work tree', () => {
    const result = check(join(scratch, 'not-a-repo'));
    expect(result.status).toBe(2);
  });

  it('passes on this repository', () => {
    const result = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
