// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { RAIL_IDS, railKindOf } from './rails.js';

describe('railKindOf', () => {
  it('gives every rail a kind, so a stored method can name one without naming a chain', () => {
    expect(RAIL_IDS.map(railKindOf).sort()).toEqual(['anchor', 'wallet']);
  });
});
