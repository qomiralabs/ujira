// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LockfileError, parseLockfile, parseYamlDocuments, splitPackageKey } from './lockfile.ts';

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'pnpm-lock.workspace.yaml'),
  'utf8',
);

describe('lockfile', () => {
  it('reads every package of the project document with its scope and platform flag', () => {
    const lockfile = parseLockfile(FIXTURE);
    expect(lockfile.importers).toEqual(['.', 'packages/core', 'packages/shared']);
    expect(lockfile.packages).toEqual([
      { name: 'copyleft-lib', version: '1.0.0', platformSpecific: false, scope: 'prod' },
      { name: 'native-darwin-arm64', version: '3.0.0', platformSpecific: true, scope: 'dev' },
      { name: 'native-linux-x64-musl', version: '3.0.0', platformSpecific: true, scope: 'prod' },
      { name: 'peer-lib', version: '2.0.0', platformSpecific: false, scope: 'dev' },
      { name: 'string-width', version: '4.2.3', platformSpecific: false, scope: 'prod' },
      { name: 'tool', version: '1.0.0', platformSpecific: false, scope: 'dev' },
      // A tarball is reported under its manifest version, not its file: key.
      { name: 'vendored', version: '1.5.0', platformSpecific: false, scope: 'prod' },
    ]);
  });

  it('ignores the package manager document', () => {
    const names = parseLockfile(FIXTURE).packages.map((p) => p.name);
    expect(names).not.toContain('@pnpm/exe.win32-x64');
  });

  it('marks a package reachable from both scopes as production', () => {
    const text = FIXTURE.replace(
      '  packages/shared: {}',
      '  packages/shared:\n    dependencies:\n      peer-lib:\n        specifier: 2.0.0\n        version: 2.0.0',
    );
    const peer = parseLockfile(text).packages.find((p) => p.name === 'peer-lib');
    expect(peer?.scope).toBe('prod');
  });

  it('reads the real lockfile of this repository', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'pnpm-lock.yaml'), 'utf8');
    const lockfile = parseLockfile(text);
    expect(lockfile.importers).toContain('.');
    expect(lockfile.packages.length).toBeGreaterThan(0);
    expect(lockfile.packages.some((p) => p.platformSpecific)).toBe(true);
  });

  it('splits package keys with scopes and peer suffixes', () => {
    expect(splitPackageKey('@scope/name@1.2.3(peer@1.0.0)(other@2.0.0(x@1.0.0))')).toEqual({
      name: '@scope/name',
      version: '1.2.3',
    });
    expect(splitPackageKey('local@file:../local')).toEqual({
      name: 'local',
      version: 'file:../local',
    });
    expect(() => splitPackageKey('noversion')).toThrow(LockfileError);
    expect(() => splitPackageKey('trailing@')).toThrow(LockfileError);
  });

  it('parses quoted keys, flow sequences, block sequences and empty values', () => {
    expect(
      parseYamlDocuments(
        [
          "'it''s:key': value",
          '"double": "quoted \\"x\\""',
          "list: [a, 'b']",
          'empty: []',
          'map: {}',
          'flow: {integrity: sha512-x}',
          'block:',
          '  - one',
          '  - two',
          'nothing:',
          '# a comment',
          'nested:',
          '  inner: 1',
        ].join('\n'),
      ),
    ).toEqual([
      {
        "it's:key": 'value',
        double: 'quoted "x"',
        list: ['a', 'b'],
        empty: [],
        map: {},
        flow: '{integrity: sha512-x}',
        block: ['one', 'two'],
        nothing: '',
        nested: { inner: '1' },
      },
    ]);
  });

  it.each([
    ['a tab', 'key:\tvalue'],
    ['an unterminated quote', "key: 'value"],
    ['an unterminated double quote', 'key: "value'],
    ['an unterminated quoted key', "'key: value"],
    ['a quoted key without a colon', "'key' value"],
    ['a line without a colon', 'just text'],
    ['an unterminated flow sequence', 'key: [a, b'],
    ['an unterminated flow mapping', 'key: {a: b'],
    ['a duplicate key', 'key: a\nkey: b'],
    ['a stray indentation', 'a:\n    b: 1\n  c: 2'],
    ['a scalar mixed into a sequence', 'a:\n  - one\n  two: 2'],
    ['a top level sequence', '- one'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseYamlDocuments(text)).toThrow(LockfileError);
  });

  it.each([
    [
      'an unsupported lockfile version',
      FIXTURE.replaceAll("lockfileVersion: '9.0'", "lockfileVersion: '6.0'"),
    ],
    ['a dependency without a snapshot', FIXTURE.replace('  copyleft-lib@1.0.0: {}\n', '')],
    [
      'a dependency without a package entry',
      FIXTURE.replace('  copyleft-lib@1.0.0:\n    resolution: {integrity: sha512-BBBB}\n', ''),
    ],
    [
      'a package no importer reaches',
      FIXTURE.replace(
        '  peer-lib@2.0.0:\n    resolution',
        '  orphan@1.0.0:\n    resolution: {integrity: sha512-Z}\n\n  peer-lib@2.0.0:\n    resolution',
      ),
    ],
    ['two project documents', `${FIXTURE}\n---\nlockfileVersion: '9.0'\nimporters:\n  .: {}\n`],
    [
      'no project document',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies: {}\n",
    ],
    ['importers that are not a mapping', "lockfileVersion: '9.0'\nimporters: [a]\n"],
    [
      'a dependency version that is not a string',
      FIXTURE.replace('        version: 1.0.0\n      width', '        version: []\n      width'),
    ],
  ])('fails closed on %s', (_label, text) => {
    expect(() => parseLockfile(text)).toThrow(LockfileError);
  });

  it('reads a missing lockfile version as unsupported', () => {
    expect(() => parseLockfile('importers:\n  .: {}\n')).toThrow(/lockfileVersion missing/);
  });
});
