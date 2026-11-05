// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// errors.json is the source of the generated mandate error names, so its own
// pin is checked here, apart from the rest of the vendored spec: the hash in
// this file, the hash in SOURCE.json and the bytes on disk must all agree.
// Bumping the vendored copy changes all three, and the generated file, in
// one pull request.

import { describe, expect, it } from 'vitest';

import {
  listVendored,
  parseManifest,
  readFromDisk,
  sha256Hex,
  vendoredProblems,
} from './testing/vectors/vendored.js';

// spec/errors.json at qomiralabs/ujira-contracts 16b48a7.
const PINNED_ERRORS_SHA256 = '627e18a7fff3f01798fafca4f1c1613ccf3be8519a6c4930f753d3ec3af97826';

const manifest = parseManifest(readFromDisk('SOURCE.json'));

describe('vendored errors.json', () => {
  it('vendored errors.json matches its pinned hash', () => {
    const bytes = readFromDisk('errors.json');
    expect(sha256Hex(bytes)).toBe(PINNED_ERRORS_SHA256);
    expect(manifest.files.find((f) => f.path === 'errors.json')?.sha256).toBe(PINNED_ERRORS_SHA256);
  });

  it('fails after one entry is edited', () => {
    const edited = (relative: string): Uint8Array => {
      const bytes = readFromDisk(relative);
      if (relative !== 'errors.json') return bytes;
      const text = Buffer.from(bytes).toString('utf8').replace('"code": 65', '"code": 66');
      expect(text).not.toBe(Buffer.from(bytes).toString('utf8'));
      return new TextEncoder().encode(text);
    };
    expect(sha256Hex(edited('errors.json'))).not.toBe(PINNED_ERRORS_SHA256);
    // Only errors.json, so the check does not hash every vector to prove one file.
    const errorsOnly = {
      ...manifest,
      files: manifest.files.filter((f) => f.path === 'errors.json'),
    };
    expect(listVendored()).toContain('errors.json');
    expect(vendoredProblems(errorsOnly, ['errors.json'], edited)).toEqual(['errors.json: changed']);
    expect(vendoredProblems(errorsOnly, ['errors.json'], readFromDisk)).toEqual([]);
  });
});
