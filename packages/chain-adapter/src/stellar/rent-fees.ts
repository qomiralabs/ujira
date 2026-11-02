// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Soroban rent, as the host charges it, in stroops. Rent is paid when an
// entry's time to live is extended (for the extra ledgers, at the entry's
// new size) and when a live entry grows (for the ledgers already paid, on
// the extra bytes). Every extended entry also writes its TTL entry, which is
// charged as a ledger write. All arithmetic is bigint with ceilings where
// the host rounds up, so the model never under-prices.

import type { SorobanRentSettings } from './rent-settings.js';

const KB = 1024n;
/** The host's floor on the rent price of 1 KB. */
export const MINIMUM_RENT_FEE_PER_1KB = 1000n;
/** Bytes of the TTL entry written for each extended entry. */
export const TTL_ENTRY_BYTES = 48n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return numerator > 0n ? numerator : 0n;
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The rent price of 1 KB for one rent period. It rises with the average
 * size of the network's live Soroban state, faster past the target size,
 * and never falls below the floor.
 */
export function rentFeePer1KB(s: SorobanRentSettings): bigint {
  const spread = s.rentFee1KBStateSizeHigh - s.rentFee1KBStateSizeLow;
  const target = s.sorobanStateTargetSizeBytes > 0n ? s.sorobanStateTargetSizeBytes : 1n;
  let fee = ceilDiv(spread * s.averageStateSizeBytes, target) + s.rentFee1KBStateSizeLow;
  if (s.averageStateSizeBytes > target) {
    const past = s.averageStateSizeBytes - target;
    fee += ceilDiv(spread * past * BigInt(s.stateRentFeeGrowthFactor), target);
  }
  return fee > MINIMUM_RENT_FEE_PER_1KB ? fee : MINIMUM_RENT_FEE_PER_1KB;
}

/** Rent for keeping `sizeBytes` alive for `ledgers` more ledgers. */
export function rentForSizeAndLedgers(
  s: SorobanRentSettings,
  sizeBytes: bigint,
  ledgers: bigint,
  persistent: boolean,
): bigint {
  if (sizeBytes <= 0n || ledgers <= 0n) return 0n;
  const denominator = persistent ? s.persistentRentRateDenominator : s.tempRentRateDenominator;
  return ceilDiv(sizeBytes * rentFeePer1KB(s) * ledgers, KB * denominator);
}

/** One entry's change in a transaction, as the host sees it for rent. */
export interface RentChange {
  readonly persistent: boolean;
  /** Zero for an entry the transaction creates. */
  readonly oldSizeBytes: bigint;
  readonly newSizeBytes: bigint;
  /** Zero for an entry the transaction creates. */
  readonly oldLiveUntilLedger: bigint;
  readonly newLiveUntilLedger: bigint;
}

function isNew(c: RentChange): boolean {
  return c.oldSizeBytes === 0n && c.oldLiveUntilLedger === 0n;
}

/** The rent one entry change costs, without the TTL write. */
export function rentForChange(
  s: SorobanRentSettings,
  c: RentChange,
  currentLedger: bigint,
): bigint {
  let fee = 0n;
  // A new entry is paid from the current ledger; an existing one from the
  // ledger after its old end.
  const before = isNew(c) ? currentLedger - 1n : c.oldLiveUntilLedger;
  if (c.newLiveUntilLedger > before) {
    fee += rentForSizeAndLedgers(s, c.newSizeBytes, c.newLiveUntilLedger - before, c.persistent);
  }
  // Ledgers already paid at the old size pay again for the extra bytes.
  if (!isNew(c) && c.newSizeBytes > c.oldSizeBytes && c.oldLiveUntilLedger >= currentLedger) {
    fee += rentForSizeAndLedgers(
      s,
      c.newSizeBytes - c.oldSizeBytes,
      c.oldLiveUntilLedger - currentLedger + 1n,
      c.persistent,
    );
  }
  return fee;
}

function extended(c: RentChange, currentLedger: bigint): boolean {
  const before = isNew(c) ? currentLedger - 1n : c.oldLiveUntilLedger;
  return c.newLiveUntilLedger > before;
}

/** The rent of a transaction's changes, with the TTL entry writes they cause. */
export function rentFee(
  s: SorobanRentSettings,
  changes: readonly RentChange[],
  currentLedger: bigint,
): bigint {
  let fee = 0n;
  let extendedEntries = 0n;
  for (const change of changes) {
    fee += rentForChange(s, change, currentLedger);
    if (extended(change, currentLedger)) extendedEntries += 1n;
  }
  fee += s.feeWriteLedgerEntry * extendedEntries;
  fee += ceilDiv(TTL_ENTRY_BYTES * extendedEntries * s.feeWrite1KB, KB);
  return fee;
}
