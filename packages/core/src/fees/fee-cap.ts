// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The take rate fee, worked out exactly as the mandate contract works out its
// cap, so a fee UJIRA builds can never be one the contract refuses. The
// contract never forms total * bps, because that can overflow its integer
// type, and rounds down; this does the same, so the two agree on every input.

import { tokenAmount } from '../money/index.js';
import type { TokenAmount } from '../money/index.js';

/** The highest take rate any mandate can carry, in basis points. */
export const MAX_FEE_BPS = 100;

const BPS_DENOMINATOR = 10_000n;

/** A rate that is not a whole number of basis points from 0 to MAX_FEE_BPS. */
export class InvalidFeeBpsError extends Error {
  override readonly name = 'InvalidFeeBpsError';
  readonly code = 'INVALID_FEE_BPS';

  constructor() {
    super(`a fee rate is a whole number of basis points from 0 to ${String(MAX_FEE_BPS)}`);
  }
}

/** A total the contract could never be asked to pay. */
export class InvalidFeeTotalError extends Error {
  override readonly name = 'InvalidFeeTotalError';
  readonly code = 'INVALID_FEE_TOTAL';

  constructor() {
    super('a fee is worked out on a total above zero');
  }
}

/** Checks a rate and returns it as a bigint. */
export function feeBps(bps: number): bigint {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) {
    throw new InvalidFeeBpsError();
  }
  return BigInt(bps);
}

/**
 * floor(total * bps / 10000), in the contract's overflow-free form:
 * (total / 10000) * bps + ((total % 10000) * bps) / 10000. The result is in
 * the total's own token and scale.
 */
export function feeCap(total: TokenAmount, bps: number): TokenAmount {
  const rate = feeBps(bps);
  if (total.amount <= 0n) throw new InvalidFeeTotalError();
  const whole = (total.amount / BPS_DENOMINATOR) * rate;
  const part = ((total.amount % BPS_DENOMINATOR) * rate) / BPS_DENOMINATOR;
  return tokenAmount(whole + part, total.asset, total.chain);
}
