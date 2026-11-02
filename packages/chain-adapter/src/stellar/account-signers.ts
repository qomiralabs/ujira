// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How many signatures a classic Stellar account needs to authorize a
// mandate call. Soroban checks a classic account's authorization against
// its medium threshold, so that is the level that counts here. An account
// whose master key alone meets it is a single key principal, whatever other
// signers it lists.

import { InvalidInputError } from '../errors.js';

export interface StellarAccountSigners {
  /** The account's medium threshold, 0 to 255. */
  readonly mediumThreshold: number;
  /** Every signer with its weight, the master key included. */
  readonly signers: readonly { readonly key: string; readonly weight: number }[];
}

const isByte = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 255;

/**
 * The fewest signers whose weights together reach the medium threshold, or
 * null when no set of signers can (the account cannot authorize at all).
 * A threshold of 0 still takes one signature, as on the network.
 */
export function stellarMinimumSignatures(account: StellarAccountSigners): number | null {
  if (!isByte(account.mediumThreshold) || !account.signers.every((s) => isByte(s.weight))) {
    throw new InvalidInputError({ issues: ['account (out_of_range)'] });
  }
  const needed = Math.max(account.mediumThreshold, 1);
  const weights = account.signers
    .map((s) => s.weight)
    .filter((w) => w > 0)
    .sort((a, b) => b - a);
  let total = 0;
  for (const [index, weight] of weights.entries()) {
    total += weight;
    if (total >= needed) return index + 1;
  }
  return null;
}
