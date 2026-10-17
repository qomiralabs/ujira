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
  BINARY_SIGNATURES,
  findInvisibleCharacters,
  formatCodePoint,
  parseAllowlist,
  showPath,
  type Signature,
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

// Bytes that match a signature, with 0x00 for any byte it leaves open.
function fromSignature(signature: Signature): Buffer {
  return Buffer.from(signature.map((byte) => byte ?? 0));
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
      expect(findInvisibleCharacters('a.txt', content, false)).toEqual({
        kind: 'text',
        findings: [{ line: 2, column: 3, codePoint: point }],
      });
      // An allowlisted file still fails on these.
      expect(findInvisibleCharacters('a.txt', content, true)).toEqual({
        kind: 'text',
        findings: [{ line: 2, column: 3, codePoint: point }],
      });
    },
  );

  it.each(labelled(LOOKALIKES))(
    'reports %s (%s) unless the file is allowlisted',
    (_label, _name, point) => {
      const content = text(`x${String.fromCodePoint(point)}y`);
      expect(findInvisibleCharacters('a.txt', content, false)).toEqual({
        kind: 'text',
        findings: [{ line: 1, column: 2, codePoint: point }],
      });
      expect(findInvisibleCharacters('a.txt', content, true)).toEqual({
        kind: 'text',
        findings: [],
      });
    },
  );

  it('counts columns in code points and reports every occurrence', () => {
    const content = text('\u{1F600}\u200B\n\n  \u2060\u2060');
    expect(findInvisibleCharacters('a.txt', content, false)).toEqual({
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
      findInvisibleCharacters('a.txt', text('caf\u00E9 na\u00EFve \u4E2D\u6587\ttab\r\n'), false),
    ).toEqual({ kind: 'text', findings: [] });
  });

  it('reports a NUL byte in a file not on the binary list, and still scans the rest', () => {
    // A NUL in a comment must not turn a source file into a skipped binary.
    const content = Buffer.concat([text('// x'), Buffer.from([0]), text('\n\u202E')]);
    expect(findInvisibleCharacters('src/trojan.ts', content, false)).toEqual({
      kind: 'text',
      findings: [
        { line: 1, column: 5, codePoint: 0 },
        { line: 2, column: 1, codePoint: 0x202e },
      ],
    });
  });

  it.each(Object.keys(BINARY_SIGNATURES))(
    'skips a .%s file whose content starts like one',
    (ext) => {
      const signature = fromSignature(BINARY_SIGNATURES[ext]?.[0] ?? []);
      const content = Buffer.concat([signature, Buffer.from([0]), text('\u202E')]);
      expect(findInvisibleCharacters(`asset.${ext}`, content, false)).toEqual({ kind: 'binary' });
      expect(findInvisibleCharacters(`ASSET.${ext.toUpperCase()}`, content, false)).toEqual({
        kind: 'binary',
      });
    },
  );

  it.each(Object.keys(BINARY_SIGNATURES))(
    'reports a .%s file whose content does not match',
    (ext) => {
      const content = Buffer.concat([text('not really\n\u202E'), Buffer.from([0])]);
      expect(findInvisibleCharacters(`asset.${ext}`, content, false)).toEqual({
        kind: 'mismatch',
        extension: ext,
      });
    },
  );

  it('requires the WebP form type, not just a RIFF header', () => {
    const wave = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1')]);
    expect(findInvisibleCharacters('a.webp', wave, false)).toEqual({
      kind: 'mismatch',
      extension: 'webp',
    });
    expect(findInvisibleCharacters('a.webp', Buffer.from('RIF'), false)).toEqual({
      kind: 'mismatch',
      extension: 'webp',
    });
  });

  it('treats a dot in a folder name as no extension', () => {
    expect(findInvisibleCharacters('assets.png/readme', text('ok'), false)).toEqual({
      kind: 'text',
      findings: [],
    });
  });

  it('accepts every listed signature of a type', () => {
    for (const signature of BINARY_SIGNATURES['gif'] ?? []) {
      expect(findInvisibleCharacters('a.gif', fromSignature(signature), false)).toEqual({
        kind: 'binary',
      });
    }
  });

  it('reports text that is not valid UTF-8', () => {
    expect(findInvisibleCharacters('a.txt', Buffer.from([0x61, 0xff, 0x62]), false)).toEqual({
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
      // A listed extension with matching content is skipped.
      'image.png': Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        text('\u202E'),
      ]),
    });
    const result = check(root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Invisible character check passed: 1 text files, 1 binary/);
  });

  it('fails on a NUL in a source file and on binary content behind a listed name', () => {
    const root = repo({
      'src/trojan.ts': Buffer.concat([text('// x'), Buffer.from([0]), text('\n\u202E\n')]),
      'fake.png': 'just text\n',
      'blob.dat': Buffer.from([0x00, 0x01, 0x02]),
    });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/trojan.ts:1:5: U+0000');
    expect(result.stderr).toContain('src/trojan.ts:2:1: U+202E');
    expect(result.stderr).toContain('fake.png: named .png but its content is not png');
    expect(result.stderr).toContain('blob.dat:1:1: U+0000');
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
