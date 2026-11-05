// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The in-memory mandate runs every shared vector that applies to Stellar,
// unchanged, and its trace is compared with the vector as the contracts'
// comparator compares the Soroban contract's. Vectors restricted to another
// chain are skipped and counted, never passed.

import { describe, expect, it } from 'vitest';

import { appliesTo } from './format.js';
import { describeMismatch } from './compare.js';
import { loadVectors } from './load.js';
import { runVector } from './world.js';

const vectors = loadVectors();
const stellar = vectors.filter((v) => appliesTo(v, 'stellar'));
const skipped = vectors.filter((v) => !appliesTo(v, 'stellar'));

describe('the shared vectors on the in-memory mandate', () => {
  it('loads the whole vendored set and counts what applies to Stellar', () => {
    expect(new Set(vectors.map((v) => v.file)).size).toBe(29);
    expect(vectors).toHaveLength(611);
    expect(stellar).toHaveLength(569);
    expect(skipped).toHaveLength(42);
    expect(new Set(vectors.map((v) => v.parsed.id)).size).toBe(vectors.length);
  });

  describe.each(stellar.map((v) => [v.parsed.id, v] as const))('%s', (_id, v) => {
    it('passes', () => {
      const { mismatch } = runVector(v);
      expect(mismatch === undefined ? 'passed' : describeMismatch(mismatch)).toBe('passed');
    });
  });

  describe.each(skipped.map((v) => [v.parsed.id, v] as const))('%s', (_id, v) => {
    it.skip(`applies to ${String(v.parsed.applies_to)} only`, () => undefined);
  });
});
