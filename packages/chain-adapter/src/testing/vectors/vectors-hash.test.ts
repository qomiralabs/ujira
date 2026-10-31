// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The vendored spec files cannot drift. SOURCE.json holds the SHA-256 of
// every copied file and this test pins the hash of SOURCE.json, so editing
// a vector, adding or removing a file, or rewriting the list of hashes to
// match, each fails here. Updating the vendored set is a deliberate change
// to the files, the manifest and the pin together.

import { describe, expect, it } from 'vitest';

import { MANDATE_ERRORS, SPEC_CONSTANTS, RECOVERY_ACTION, ROLE } from '../spec.js';

import { isObject } from './json.js';
import {
  MANIFEST,
  listVendored,
  parseManifest,
  readFromDisk,
  readJson,
  sha256Hex,
  vendoredProblems,
} from './vendored.js';
import type { ReadVendored } from './vendored.js';

// SHA-256 of spec/SOURCE.json: qomiralabs/ujira-contracts at 2cd67bb.
const PINNED_MANIFEST_SHA256 = '7ee3234ddaa50e69c34e19c950aa70fcb732e19e13d6a7992f32d020a9bf42b8';

const files = listVendored();
const manifestBytes = readFromDisk(MANIFEST);
const manifest = parseManifest(manifestBytes);

describe('the vendored spec files', () => {
  it('vendored files match the pinned hash', () => {
    expect(sha256Hex(manifestBytes)).toBe(PINNED_MANIFEST_SHA256);
    expect(manifest.repository).toBe('qomiralabs/ujira-contracts');
    expect(manifest.commit).toBe('2cd67bbea58f214039600206dcb6fef912aba6ca');
    expect(vendoredProblems(manifest, files, readFromDisk)).toEqual([]);
    expect(manifest.files).toHaveLength(32);
  });

  it('fails after one byte of one vendored file changes', () => {
    const tampered: ReadVendored = (relative) => {
      const bytes = readFromDisk(relative);
      if (relative !== 'vectors/example.json') return bytes;
      const out = Uint8Array.from(bytes);
      out[out.length - 2] = (out[out.length - 2] ?? 0) ^ 1;
      return out;
    };
    expect(vendoredProblems(manifest, files, tampered)).toEqual(['vectors/example.json: changed']);
  });

  it('fails when a file goes missing or one the manifest does not list appears', () => {
    const fewer = files.filter((f) => f !== 'vectors/fee.json');
    expect(vendoredProblems(manifest, fewer, readFromDisk)).toEqual(['vectors/fee.json: missing']);
    expect(vendoredProblems(manifest, [...files, 'vectors/extra.json'], readFromDisk)).toEqual([
      'vectors/extra.json: not in the manifest',
    ]);
  });

  it('refuses a manifest of the wrong shape', () => {
    const bad = new TextEncoder().encode(JSON.stringify({ ...manifest, commit: '2cd67bb' }));
    expect(() => parseManifest(bad)).toThrow();
  });
});

describe('the engine tables match the vendored spec', () => {
  it('has every error with its code, and nothing else', () => {
    const table = readJson('errors.json');
    const fromSpec = Array.isArray(table)
      ? table.map((e) => [isObject(e) ? e['name'] : null, isObject(e) ? e['code'] : null])
      : [];
    expect(Object.fromEntries(fromSpec)).toEqual(MANDATE_ERRORS);
  });

  it('has every constant, role code and recovery action kind', () => {
    const spec = readJson('constants.json');
    expect(isObject(spec) ? spec['constants'] : null).toEqual(SPEC_CONSTANTS);
    expect(isObject(spec) ? spec['role_codes'] : null).toEqual(ROLE);
    expect(isObject(spec) ? spec['recovery_action_kinds'] : null).toEqual(RECOVERY_ACTION);
  });
});
