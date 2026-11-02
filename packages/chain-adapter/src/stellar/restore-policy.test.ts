// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { INSTANCE_TTL_EXTEND_LEDGERS, extensionPlan } from './restore-policy.js';

const NOW = 1_800_000_000n;
const policy = { nowSeconds: NOW, instanceTtlExtendLedgers: INSTANCE_TTL_EXTEND_LEDGERS };

describe('extensionPlan', () => {
  it('open record extended only to expires_at plus one day, tombstone not extended', () => {
    const plan = extensionPlan(
      [
        { kind: 'open_record', key: 'record', expiresAt: NOW + 3600n },
        { kind: 'tombstone', key: 'tombstone' },
      ],
      policy,
    );
    // One hour to expiry plus the day of margin, in five second ledgers.
    expect(plan).toEqual([{ extendTo: (3600 + 86_400) / 5, keys: ['record'] }]);
  });

  it('extends the instance, the code and the asset balance to the instance horizon', () => {
    expect(INSTANCE_TTL_EXTEND_LEDGERS).toBe(535_680);
    const plan = extensionPlan(
      [
        { kind: 'instance', key: 'instance' },
        { kind: 'code', key: 'code' },
        { kind: 'asset_balance', key: 'balance' },
        { kind: 'other', key: 'allowlist' },
      ],
      policy,
    );
    expect(plan).toEqual([{ extendTo: 535_680, keys: ['instance', 'code', 'balance'] }]);
  });

  it('rounds a record up to a whole ledger, groups equal targets and orders by target', () => {
    const plan = extensionPlan(
      [
        { kind: 'instance', key: 'instance' },
        { kind: 'open_record', key: 'a', expiresAt: NOW + 1n },
        { kind: 'open_record', key: 'b', expiresAt: NOW + 2n },
      ],
      policy,
    );
    expect(plan).toEqual([
      { extendTo: 17_281, keys: ['a', 'b'] },
      { extendTo: 535_680, keys: ['instance'] },
    ]);
  });

  it('leaves a record that lapsed more than a day ago alone', () => {
    expect(
      extensionPlan([{ kind: 'open_record', key: 'old', expiresAt: NOW - 86_400n }], policy),
    ).toEqual([]);
  });
});
