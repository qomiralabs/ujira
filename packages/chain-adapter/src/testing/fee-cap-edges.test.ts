// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fee cap at the inputs most likely to lose a stroop or overflow, from the
// same fixture the contract's own property tests read, so the fake mandate and
// the real one cannot round differently.

import { describe, expect, it } from 'vitest';

import { feeCap } from './rules.js';
import { readFromDisk } from './vectors/vendored.js';

interface FeeCapCase {
  readonly total: string;
  readonly max_fee_bps: number;
  readonly fee_cap: string;
}

const fixture = JSON.parse(
  Buffer.from(readFromDisk('fixtures/fee-cap-edges.json')).toString('utf8'),
) as {
  readonly rule: string;
  readonly cases: readonly FeeCapCase[];
};

describe('the fee cap edges', () => {
  it('reads the cases the contract tests read', () => {
    expect(fixture.rule).toBe('MANDATE-FEE-002');
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases)('$max_fee_bps bps of $total is $fee_cap', (c) => {
    expect(feeCap(BigInt(c.total), c.max_fee_bps)).toBe(BigInt(c.fee_cap));
  });
});
