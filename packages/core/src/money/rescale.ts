// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { InvalidRoundingModeError } from './errors.js';
import { money, multiply } from './money.js';
import type { Money } from './money.js';

/**
 * How to drop digits when a value has to lose precision.
 *   half-even  nearest, ties to the even neighbour
 *   half-up    nearest, ties away from zero
 *   floor      toward negative infinity
 *   ceil       toward positive infinity
 *   trunc      toward zero
 */
export type RoundingMode = 'half-even' | 'half-up' | 'floor' | 'ceil' | 'trunc';

export const ROUNDING_MODES: readonly RoundingMode[] = Object.freeze([
  'half-even',
  'half-up',
  'floor',
  'ceil',
  'trunc',
]);

// A Set of exact strings, so boxed strings and look alikes never match.
const MODES: ReadonlySet<unknown> = new Set<unknown>(ROUNDING_MODES);

export function parseRoundingMode(mode: unknown): RoundingMode {
  if (!MODES.has(mode)) {
    throw new InvalidRoundingModeError(`rounding must be one of ${ROUNDING_MODES.join(', ')}`);
  }
  return mode as RoundingMode;
}

/** Divides by a positive divisor and rounds the exact quotient with `mode`. */
export function divideRounded(n: bigint, divisor: bigint, mode: RoundingMode): bigint {
  const truncated = n / divisor;
  if (n % divisor === 0n) return truncated;
  const floor = n < 0n ? truncated - 1n : truncated;
  const ceil = floor + 1n;
  if (mode === 'floor') return floor;
  if (mode === 'ceil') return ceil;
  if (mode === 'trunc') return truncated;
  // Twice the remainder against the divisor tells below, at or above half
  // without ever forming a fraction.
  const twice = 2n * (n - floor * divisor);
  if (twice < divisor) return floor;
  if (twice > divisor) return ceil;
  if (mode === 'half-up') return n < 0n ? floor : ceil;
  return floor % 2n === 0n ? floor : ceil;
}

/**
 * Moves `m` to `toScale`. Scaling up is exact and throws MoneyOverflowError
 * outside i128. Scaling down rounds with `rounding`, which is required on
 * every call so a caller can never fall into an implicit mode.
 */
export function rescale(m: Money, toScale: number, rounding: RoundingMode): Money {
  const value = multiply(m, 1n);
  const target = money(0n, value.currency, toScale).scale;
  const mode = parseRoundingMode(rounding);
  const shift = BigInt(target) - BigInt(value.scale);
  if (shift >= 0n) {
    return money(value.amount * 10n ** shift, value.currency, target);
  }
  return money(divideRounded(value.amount, 10n ** -shift, mode), value.currency, target);
}
