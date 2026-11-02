// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the rail list (rails.ts). RAIL_IDS holds exactly the members
 * of the RailId type, no more and no fewer, and isRailId accepts exactly
 * those values.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { RAIL_IDS, isRailId } from './index.js';
import type { RailId } from './index.js';

describe('rails', () => {
  it('lists every RailId member and nothing else', () => {
    expectTypeOf<(typeof RAIL_IDS)[number]>().toEqualTypeOf<RailId>();
    expect(new Set(RAIL_IDS).size).toBe(RAIL_IDS.length);
    expect(Object.isFrozen(RAIL_IDS)).toBe(true);
  });

  it('recognises exactly the listed rails', () => {
    for (const rail of RAIL_IDS) expect(isRailId(rail)).toBe(true);
    for (const value of ['stellar.sep24', 'Stellar.wallet', 'wallet', '', null, 1, undefined]) {
      expect(isRailId(value)).toBe(false);
    }
  });
});
