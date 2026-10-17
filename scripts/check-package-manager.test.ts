// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkPackageManager, parseStrictJson, StrictJsonError } from './strict-json.ts';

const CHECK = join(import.meta.dirname, 'check-package-manager.ts');
const ROOT_MANIFEST = readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8');
const HASH = 'a'.repeat(128);
const PIN = `pnpm@12.14.0+sha512.${HASH}`;

const scratch = mkdtempSync(join(tmpdir(), 'package-manager-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(manifest: string, version: string) {
  const path = join(scratch, `${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, manifest);
  return spawnSync(process.execPath, [CHECK, version, path], { encoding: 'utf8' });
}

describe('parseStrictJson', () => {
  it('parses the same values as JSON.parse', () => {
    const text = '{"a":[1,-2.5e3,true,false,null,"x\\u0041\\n"],"b":{"c":{}},"d":[]}';
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
    expect(parseStrictJson(ROOT_MANIFEST)).toEqual(JSON.parse(ROOT_MANIFEST));
  });

  it('rejects a duplicate key at the top level and when nested, naming the path', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow('duplicate key "a" at $');
    expect(() => parseStrictJson('{"s":{"x":1,"y":2,"x":3}}')).toThrow('duplicate key "x" at $.s');
    expect(() => parseStrictJson('[{"k":1},{"k":2,"k":3}]')).toThrow('duplicate key "k" at $[1]');
  });

  it('treats keys that differ only by escapes as the same key', () => {
    expect(() => parseStrictJson('{"packageManager":1,"package\\u004danager":2}')).toThrow(
      'duplicate key "packageManager"',
    );
  });

  it('allows the same key in sibling objects', () => {
    expect(parseStrictJson('{"a":{"k":1},"b":{"k":2}}')).toEqual({ a: { k: 1 }, b: { k: 2 } });
  });

  it.each([
    ['trailing comma in an object', '{"a":1,}'],
    ['trailing comma in an array', '[1,]'],
    ['single quotes', "{'a':1}"],
    ['a comment', '{"a":1 /* x */}'],
    ['a leading zero', '[01]'],
    ['a bare word', '[nope]'],
    ['an unterminated string', '{"a":"b'],
    ['a raw control character in a string', '["a\nb"]'],
    ['a bad escape', '["\\x41"]'],
    ['trailing content', '{} {}'],
    ['an empty document', '   '],
    ['an object key that is not a string', '{a:1}'],
  ])('rejects %s', (_name, text) => {
    expect(() => parseStrictJson(text)).toThrow(StrictJsonError);
  });

  it('rejects nesting deeper than 256 levels instead of overflowing the stack', () => {
    expect(() => parseStrictJson('['.repeat(300) + ']'.repeat(300))).toThrow('nested deeper');
    expect(parseStrictJson('['.repeat(200) + ']'.repeat(200))).toBeDefined();
  });

  it('rejects a leading byte order mark, which is not JSON', () => {
    expect(() => parseStrictJson('\uFEFF{}')).toThrow(StrictJsonError);
  });
});

describe('checkPackageManager', () => {
  it('accepts the pinned version with a SHA-512', () => {
    expect(checkPackageManager({ packageManager: PIN }, '12.14.0')).toEqual([]);
  });

  it.each([
    ['a missing field', {}, 'packageManager is missing'],
    ['a non string value', { packageManager: 12 }, 'packageManager is not a string'],
    ['another version', { packageManager: `pnpm@12.13.0+sha512.${HASH}` }, 'pins pnpm 12.13.0'],
    ['no hash', { packageManager: 'pnpm@12.14.0' }, 'must be pnpm@<version>+sha512.<128 hex>'],
    ['a short hash', { packageManager: 'pnpm@12.14.0+sha512.abc' }, 'must be pnpm@'],
    ['another tool', { packageManager: `yarn@12.14.0+sha512.${HASH}` }, 'must be pnpm@'],
    ['a not an object manifest', [], 'package.json is not an object'],
  ])('rejects %s', (_name, manifest, message) => {
    const problems = checkPackageManager(manifest, '12.14.0');
    expect(problems.join('\n')).toContain(message);
  });
});

describe('check-package-manager', () => {
  it('duplicate packageManager keys fail', () => {
    // The second key is the one JSON.parse would keep, so a text grep for the
    // first one would pass while pnpm reads the second.
    const manifest = `{\n  "packageManager": "${PIN}",\n  "packageManager": "pnpm@9.0.0"\n}\n`;
    const result = run(manifest, '12.14.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicate key "packageManager" at $');
  });

  it('passes on the repository package.json for its own pinned version', () => {
    const pinned = (JSON.parse(ROOT_MANIFEST) as { packageManager: string }).packageManager;
    const version = /^pnpm@([^+]+)\+/.exec(pinned)?.[1] ?? '';
    const result = spawnSync(process.execPath, [CHECK, version], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`packageManager pins pnpm ${version}\n`);
  });

  it('fails on a version mismatch and on invalid JSON', () => {
    expect(run(`{"packageManager":"${PIN}"}`, '12.15.0').stderr).toContain('pins pnpm 12.14.0');
    expect(run('{"packageManager":', '12.14.0').status).toBe(1);
  });

  it('exits 2 without an expected version', () => {
    const result = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });
});
