// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

const BPS_DENOMINATOR = 10_000n;

/**
 * The most a mandate lets a payout of `total` carry as a fee: floor(total * bps
 * / 10000), worked out without ever forming total * bps, as the contract does.
 * A check that rounded differently from the contract would let through a fee
 * the contract then refuses, after a signature and a network fee were spent.
 */
export function feeCap(total: bigint, maxFeeBps: number): bigint {
  const bps = BigInt(maxFeeBps);
  return (total / BPS_DENOMINATOR) * bps + ((total % BPS_DENOMINATOR) * bps) / BPS_DENOMINATOR;
}
