// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// parseMoney options that are present but not an object. The contract only
// names options.rounding, so anything that cannot hold it is a bad rounding.

import { describe, expect, it } from 'vitest';

import * as moneyIndex from './index.js';
import type { MoneyError } from './index.js';
import { parseMoney } from './parse.js';

type ErrorClass = abstract new (message?: string) => MoneyError;
const InvalidRoundingModeError = (moneyIndex as Record<string, unknown>)[
  'InvalidRoundingModeError'
] as ErrorClass;

describe('parseMoney options that are not an object', () => {
  it.each([
    ['null', null],
    ['a string', 'half-even'],
    ['a number', 2],
    ['a boolean', true],
    ['a bigint', 1n],
  ])('throws InvalidRoundingModeError for %s', (_label, options) => {
    let err: unknown;
    try {
      parseMoney('1.5', 'USD', 2, options as never);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(InvalidRoundingModeError);
  });
});
