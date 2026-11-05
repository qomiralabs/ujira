// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BATCH_LIMITS, RAIL_IDS, railKindOf } from './rails.js';

describe('BATCH_LIMITS', () => {
  it('are the spec constants', () => {
    const spec = JSON.parse(
      readFileSync(new URL('../spec/constants.json', import.meta.url), 'utf8'),
    ) as {
      readonly constants: { readonly MAX_BATCH: number; readonly MAX_BATCH_TRANSFERS: number };
    };
    expect(BATCH_LIMITS).toEqual({
      maxBatch: spec.constants.MAX_BATCH,
      maxBatchTransfers: spec.constants.MAX_BATCH_TRANSFERS,
    });
  });
});

describe('railKindOf', () => {
  it('gives every rail a kind, so a stored method can name one without naming a chain', () => {
    expect(RAIL_IDS.map(railKindOf).sort()).toEqual(['anchor', 'wallet']);
  });
});
