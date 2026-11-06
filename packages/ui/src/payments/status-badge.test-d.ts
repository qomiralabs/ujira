// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compile time checks, run by typecheck. Each ts-expect-error is an
// assertion: if the line ever compiles, typecheck fails on the unused
// directive.

import type { PayoutStatus } from '@ujira/api-schema';
import { describe, expectTypeOf, it } from 'vitest';
import { STATUS_SPECS, type BadgeStatus, type StatusMap } from './status-badge.js';

describe('status badge types', () => {
  it('a new status in the union without a mapping is an error', () => {
    // The map is typed over the whole union, so a status added to the API
    // contract fails to compile here until it has a word, a tone and an icon.
    // @ts-expect-error 'on_hold' has no mapping
    const extended: StatusMap<BadgeStatus | 'on_hold'> = STATUS_SPECS;
    expectTypeOf(extended).toBeObject();
  });

  it('every payout status the API sends is a badge status', () => {
    expectTypeOf<PayoutStatus>().toExtend<BadgeStatus>();
  });

  it('refuses a status that does not exist', () => {
    // @ts-expect-error 'done' is not a status
    const unknown: BadgeStatus = 'done';
    expectTypeOf(unknown).toBeString();
  });
});
